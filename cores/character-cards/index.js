import { request } from '../../libraries/shared/request.js';
import { createCardTestRunner } from './card-test.js';
import { computeCardNegationProblems, buildNegationRefusal } from '../../libraries/core/character-lint.js';
import { normalizeCardFields, computeFlatCard, computeBookAfterPatch, computeChangedFieldNames, buildCreateForm, buildMergeBody, buildRestoreBody } from '../../libraries/core/character-card.js';

/**
 * Ядро карточек персонажей: чтение, создание и правка всех полей карточки ST, с откатом каждой правки. Любой вызывающий (гид, Модули) получает
 * одно и то же: проверенные пределы, отказ с причиной вместо тихой обрезки и запись через родное слияние ST — оно не трогает неназванные поля
 * (чужие расширения, картинку, чаты).
 *
 * Контракты: `characterCard.list`; `characterCard.get { avatar | name }` → `{ avatar, fields }`; `characterCard.create { fields }` → `{ avatar, name }`
 * (занятое имя — отказ, а не тихая замена); `characterCard.update { avatar | name, fields, label? }` → `{ avatar, name, changed }`;
 * `characterCard.versions { avatar | name }`; `characterCard.restore { avatar | name, key }`; `characterCard.test { avatar | name, probes, workerId?, maxTokens? }` — серия ходов
 * в изолированном чате (card-test.js); `characterCard.chatExcerpt { avatar | name, last? }` — последние реплики открытого чата с этим персонажем.
 * Удаления нет намеренно — оно за родными экранами ST.
 * Событие: `characterCard.changed { avatar, action }`.
 */
export function createCharacterCardsCore(host, { publish, now = () => Date.now() } = {}) {
    const callService = (contract, params) => request(host.services, contract, { params });
    const emitChanged = publish ?? (() => {});

    async function callCharacterCardService(contract, params) {
        const result = await callService(contract, params);
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
    }

    const isSameName = (first, second) => String(first).trim().toLowerCase() === String(second).trim().toLowerCase();

    async function requireCharacterEntry(params = {}) {
        const entries = await callCharacterCardService('stCharacterCard.list');
        const byAvatar = params.avatar ? entries.find(entry => entry.avatar === params.avatar) : null;
        if (byAvatar) return byAvatar;
        const wanted = params.avatar ?? params.name;
        if (!wanted) throw new Error('characterCard: which character? Give its avatar file or its name.');
        const named = entries.filter(entry => isSameName(entry.name, wanted) || isSameName(entry.avatar.replace(/\.png$/i, ''), wanted));
        if (named.length === 1) return named[0];
        throw new Error(named.length ? `characterCard: several characters are called "${wanted}" — use the avatar file name.` : `characterCard: there is no character "${wanted}".`);
    }

    async function readCard(params) {
        const entry = await requireCharacterEntry(params);
        return { avatar: entry.avatar, fields: computeFlatCard(await callCharacterCardService('stCharacterCard.load', { avatar: entry.avatar })) };
    }

    async function saveVersion(avatar, rawCard, label) {
        await callCharacterCardService('characterCardVersions.put', { record: { avatar, at: now(), label, card: rawCard } });
    }

    // Правило владельца: стоящие отрицания карательно отклоняются (character-lint.js); `negationsOk` — только когда человек или тест их потребовал.
    function requireNoStandingNegations(fields, negationsOk) {
        if (negationsOk === true) return;
        const problems = computeCardNegationProblems(fields);
        if (problems.length) throw new Error(`characterCard: ${buildNegationRefusal(problems)}`);
    }

    async function createCard(params = {}) {
        const made = normalizeCardFields(params.fields ?? {}, { isNewCard: true });
        if (!made.ok) throw new Error(`characterCard: ${made.error}`);
        const fields = made.value;
        requireNoStandingNegations(fields, params.negationsOk);
        const taken = (await callCharacterCardService('stCharacterCard.list')).find(entry => isSameName(entry.name, fields.name));
        if (taken) throw new Error(`characterCard: a character called "${taken.name}" already exists (${taken.avatar}) — pick another name, or edit that one.`);
        // Книгу собираем ДО создания: отказ по её записям не должен оставлять в ST пустую карточку с одним именем.
        const book = fields.character_book ? computeBookAfterPatch(null, fields.character_book) : null;
        if (book && !book.ok) throw new Error(`characterCard: ${book.error}`);
        const { avatar } = await callCharacterCardService('stCharacterCard.create', { form: buildCreateForm(fields) });
        const { name: _alreadyInForm, ...rest } = fields;
        const body = buildMergeBody(rest, book?.value ?? null);
        if (Object.keys(body).length) await callCharacterCardService('stCharacterCard.merge', { avatar, body });
        emitChanged('characterCard.changed', { avatar, action: 'create' });
        return { avatar, name: fields.name };
    }

    async function updateCard(params = {}) {
        const made = normalizeCardFields(params.fields ?? {}, { isNewCard: false });
        if (!made.ok) throw new Error(`characterCard: ${made.error}`);
        const fields = made.value;
        requireNoStandingNegations(fields, params.negationsOk);
        const entry = await requireCharacterEntry(params);
        if (fields.name !== undefined && !isSameName(fields.name, entry.name)) {
            const clash = (await callCharacterCardService('stCharacterCard.list')).find(other => other.avatar !== entry.avatar && isSameName(other.name, fields.name));
            if (clash) throw new Error(`characterCard: another character is already called "${clash.name}".`);
        }
        const rawBefore = await callCharacterCardService('stCharacterCard.load', { avatar: entry.avatar });
        let book = null;
        if (fields.character_book) {
            const merged = computeBookAfterPatch(computeFlatCard(rawBefore).character_book, fields.character_book);
            if (!merged.ok) throw new Error(`characterCard: ${merged.error}`);
            book = merged.value;
        }
        // Снимок ДО записи: если запись упадёт на полпути, откатывать есть к чему.
        await saveVersion(entry.avatar, rawBefore, params.label || `Before changing ${Object.keys(fields).join(', ')}`);
        await callCharacterCardService('stCharacterCard.merge', { avatar: entry.avatar, body: buildMergeBody(fields, book) });
        emitChanged('characterCard.changed', { avatar: entry.avatar, action: 'update' });
        return { avatar: entry.avatar, name: fields.name ?? entry.name, changed: Object.keys(fields) };
    }

    async function listVersions(params) {
        const entry = await requireCharacterEntry(params);
        return callCharacterCardService('characterCardVersions.list', { avatar: entry.avatar });
    }

    async function restoreVersion(params = {}) {
        const entry = await requireCharacterEntry(params);
        const version = await callCharacterCardService('characterCardVersions.get', { key: params.key });
        if (!version || version.avatar !== entry.avatar) throw new Error('characterCard: there is no such version of this character.');
        const rawBefore = await callCharacterCardService('stCharacterCard.load', { avatar: entry.avatar });
        // Сам откат тоже обратим: иначе ошибочный откат стирал бы то, что было до него.
        await saveVersion(entry.avatar, rawBefore, `Before restoring the version of ${new Date(version.at).toISOString().slice(0, 16).replace('T', ' ')}`);
        await callCharacterCardService('stCharacterCard.merge', { avatar: entry.avatar, body: buildRestoreBody(version.card) });
        emitChanged('characterCard.changed', { avatar: entry.avatar, action: 'restore' });
        return { avatar: entry.avatar, changed: computeChangedFieldNames(computeFlatCard(rawBefore), computeFlatCard(version.card)) };
    }

    // Картинка карточки: Сервис качает, обрезает и пишет её в ST; здесь — только какая карточка и событие об изменении.
    async function setAvatar(params = {}) {
        const entry = await requireCharacterEntry(params);
        if (params.undo === true) {
            await callCharacterCardService('stCharacterAvatar.undo', { avatar: entry.avatar });
            emitChanged('characterCard.changed', { avatar: entry.avatar, action: 'avatar' });
            return { avatar: entry.avatar, name: entry.name, undone: true };
        }
        const done = await callCharacterCardService('stCharacterAvatar.set', { avatar: entry.avatar, url: params.url, focus: params.focus });
        emitChanged('characterCard.changed', { avatar: entry.avatar, action: 'avatar' });
        return { avatar: entry.avatar, name: entry.name, source: done.source, canUndo: done.canUndo };
    }

    const cardTest = createCardTestRunner(host, { readCard });

    const unregisters = [
        host.own.register('characterCard.list', () => callCharacterCardService('stCharacterCard.list')),
        host.own.register('characterCard.get', params => readCard(params)),
        host.own.register('characterCard.create', params => createCard(params)),
        host.own.register('characterCard.update', params => updateCard(params)),
        host.own.register('characterCard.versions', params => listVersions(params)),
        host.own.register('characterCard.restore', params => restoreVersion(params)),
        host.own.register('characterCard.avatar', params => setAvatar(params)),
        host.own.register('characterCard.test', params => cardTest.runTest(params)),
        host.own.register('characterCard.chatExcerpt', params => cardTest.readChatExcerpt(params)),
    ];

    return { readCard, createCard, updateCard, listVersions, restoreVersion, unregister: () => { for (const unregister of unregisters) unregister(); } };
}
