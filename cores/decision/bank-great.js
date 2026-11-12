import { DECISION_MEMORY_NAMESPACE } from '../../libraries/core/decision-settings.js';
import { applyDecrees, applyEdits, bankKey, ensureCharacter, findCharacter, normalizeCharacter, normalizeGreatBank, normalizeImportance, resolveSection, isUserCharacter, USER_CHARACTER_NOTE } from '../../libraries/core/decision-great-bank.js';
import { normalizeDecrees } from '../../libraries/core/decision-decree.js';
import { parseBankSections } from '../../libraries/core/decision-bank-parse.js';
import { BANK_BUILDER_VERSION } from '../../libraries/core/decision-banks.js';
import { formatInstant, rpInstant, parseInstant } from '../../libraries/core/decision-bank-time.js';
import { renderFarBanks, renderNearBanks, renderDecreeSection } from '../../libraries/core/decision-bank-projections.js';
import { createTimeReader } from './readers.js';
import { normalizeWithUser } from '../../libraries/core/acquaintance.js';

const GREAT_KEY = 'greatBank';
const CORRECTED_PARTS = ['material', 'spiritual', 'decree', 'psyche'];
const clone = value => JSON.parse(JSON.stringify(value ?? null));
const HISTORY_LIMIT = 300;
const text = value => String(value ?? '').trim();

/** Источники, у которых банк — описание мира, а не персонаж: в Great Bank не переводятся. */
const NON_CHARACTER = new Set(['scene']);

/**
 * Great Bank в памяти чата: разделы персонажей, история правок, проекции.
 * Банки-карточки остаются источником текста: собранный новой версией сборщика
 * банк раскладывается по разделам, старый — показывается как есть (решение
 * владельца: старые банки не переводим). Правка — `bank_edit`, без отказов.
 */
export function createGreatBank({ call, store = null, banks = null, timeOfDay = () => null }) {
    const lastTimeMark = createTimeReader(call);

    async function load() {
        try {
            return normalizeGreatBank(await call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: GREAT_KEY, fallback: {} }));
        } catch { return {}; }
    }

    function clockMinutes() {
        return Number(typeof store?.clock === 'function' ? store.clock()?.minutes : 0) || 0;
    }

    /**
     * Текущий момент RP-времени: `value` — одно число для сравнения сроков,
     * `label` — текст метки. Без даты в строке RP Time моментом служит
     * счётчик минут движка, и метка печатается счётчиком дней.
     */
    async function rpNow() {
        const label = await lastTimeMark().catch(() => '');
        const value = rpInstant(label, clockMinutes());
        return { value, label: formatInstant(value) };
    }

    async function save(state) {
        await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: GREAT_KEY, value: state });
        return state;
    }

    /** Canon: Great Bank ставится целиком — разделы, Указы и уровни уже в наборе. */
    async function replace(value) {
        const state = normalizeGreatBank(value);
        await save(state);
        return state;
    }

    function records() {
        return typeof banks?.records === 'function' ? banks.records() : [];
    }

    /** Банк-карточка → персонаж Great Bank; не разобранный по разделам остаётся свободным текстом. */
    function fromRecord(record) {
        const source = String(record?.text ?? '');
        const parsed = parseBankSections(source);
        // Старые банки не переводим: только сборщик этой версии пишет по разделам.
        const ready = parsed.ready && Number(record?.builderVersion) >= BANK_BUILDER_VERSION;
        const character = normalizeCharacter({
            name: record?.name,
            aliases: [record?.canonicalName, ...(record?.aliases ?? [])]
                .filter(Boolean).filter(alias => bankKey(alias) !== bankKey(record?.name)),
            importance: record?.importance,
            material: ready ? parsed.material : {},
            spiritual: ready ? parsed.spiritual : {},
        }, record?.name);
        if (!character) return null;
        return {
            ...character,
            sourceKey: String(record?.sourceKey ?? ''),
            textHash: source,
            sectionsReady: ready,
            fallbackText: ready ? '' : source,
            ...(Array.isArray(record?.several) && record.several.length > 1 ? { several: [...record.several] } : {}),
        };
    }

    /**
     * Догнать Great Bank за банками-карточками: раскладывает по разделам каждый
     * собранный банк, переживает пересборку (что было → что стало — в историю).
     */
    async function sync() {
        const state = { ...(await load()) };
        let changed = false;
        let at = null;
        for (const record of records()) {
            if (NON_CHARACTER.has(String(record?.sourceKind ?? ''))) continue;
            const source = String(record?.text ?? '').trim();
            const key = bankKey(record?.name);
            if (!source || !key) continue;
            const existing = state[key];
            const sameSource = existing?.sourceKey === String(record?.sourceKey ?? '');
            if (sameSource && existing?.textHash === source) continue;
            const fresh = fromRecord(record);
            if (!fresh) continue;
            at ??= (await rpNow()).label;
            if (!existing) {
                state[key] = fresh;
                changed = true;
                continue;
            }
            state[key] = mergeParsed(existing, fresh, at);
            changed = true;
        }
        return changed ? save(state) : state;
    }

    /** Пересборка банка: разделы новые, история правок прежняя. */
    function mergeParsed(existing, fresh, at) {
        const history = [...(existing.history ?? [])];
        const next = {
            ...fresh,
            importance: existing.importance ?? fresh.importance,
            history,
            pending: existing.pending ?? [],
            // psyche.md пишет Психолог, а не сборщик: пересборка банка его не трогает.
            psyche: existing.psyche ?? [],
        };
        if (existing.decree && Object.values(existing.decree).some(lines => lines.length)) next.decree = existing.decree;
        for (const part of ['material', 'spiritual']) {
            for (const [no, lines] of Object.entries(fresh[part] ?? {})) {
                const before = (existing[part]?.[no] ?? []).join('\n');
                const after = (lines ?? []).join('\n');
                if (before === after) continue;
                history.push({ at, by: 'builder', part, section: Number(no), old: before, new: after, comment: 'The bank was rebuilt from its source.' });
            }
        }
        return { ...next, history: history.slice(-HISTORY_LIMIT) };
    }

    /** Правка одним вызовом: несколько персонажей, без отказов. `by` — director или resolver. */
    /**
     * Правка вне сюжета доходит до снимков: иначе перегенерация хода восстанавливала банк из снимка, и правка
     * пользователя (или из входящего ящика) тихо пропадала.
     */
    async function propagate(before, after) {
        if (typeof store?.correctSnapshots !== 'function') return 0;
        const corrections = [];
        for (const [key, character] of Object.entries(after ?? {})) {
            for (const part of CORRECTED_PARTS) {
                const from = before?.[key]?.[part];
                if (from === undefined || JSON.stringify(from) === JSON.stringify(character?.[part])) continue;
                corrections.push({ key, part, from, to: character[part] });
            }
        }
        return corrections.length ? store.correctSnapshots(corrections).catch(() => 0) : 0;
    }

    async function edit({ comment = '', edits = [] } = {}, { by = 'director' } = {}) {
        const state = await sync();
        const before = by === 'user' ? clone(state) : null;
        const rp = await rpNow();
        const applied = applyEdits(state, { edits, comment, by, at: rp.label, nowValue: rp.value, importance: 'temporary', timeOfDay: timeOfDay() });
        for (const [key, character] of Object.entries(applied.state)) {
            if (character.history.length > HISTORY_LIMIT) applied.state[key] = { ...character, history: character.history.slice(-HISTORY_LIMIT) };
            if (character.sectionsReady === false) applied.state[key] = { ...applied.state[key], sectionsReady: true };
        }
        await save(applied.state);
        if (before) await propagate(before, applied.state);
        return { ok: true, at: rp.label, changes: applied.changes, created: applied.created };
    }

    /** Уровень важности персонажа: main / side / temporary / mass. */
    async function setImportance({ character, importance } = {}) {
        const state = await sync();
        const ensured = ensureCharacter(state, character, { importance });
        const found = findCharacter(ensured.state, character);
        if (!found) return { ok: false, error: `There is no character "${character}".` };
        if (isUserCharacter(found)) return { ok: false, error: `${found.name} ${USER_CHARACTER_NOTE}` };
        const level = normalizeImportance(importance);
        await save({ ...ensured.state, [bankKey(found.name)]: { ...found, importance: level } });
        return { ok: true, character: found.name, importance: level };
    }

    /**
     * Указ (часть 19): несколько персонажей одним вызовом. Пишет блок `decree`,
     * ставит метку RP-времени, прежние строки — в историю. Тот же Указ историю
     * не плодит. Состояние меняется только после успешного ответа модели.
     */
    /** Указ из файла `decree.md`: готовые разделы 1–5, без разбора полей (файловые инструменты, часть 21). */
    async function writeDecree({ character, sections = {}, comment = '', by = 'director' } = {}) {
        const state = await sync();
        const rp = await rpNow();
        const applied = applyDecrees(state, [{ character, sections }], { at: rp.label, comment, by });
        await save(applied.state);
        return { ok: true, at: rp.label, decrees: applied.applied };
    }

    /**
     * psyche.md — строки механизмов и темпа. Пишет только Психолог; персонажу
     * пользователя — никогда. Прежние строки уходят в историю.
     */
    async function setPsyche({ character, lines = [], comment = '', by = 'psychologist', correction = false } = {}) {
        const state = await sync();
        const found = findCharacter(state, character);
        if (!found) return { ok: false, error: `There is no character "${character}".` };
        if (isUserCharacter(found)) return { ok: false, error: `${found.name} ${USER_CHARACTER_NOTE}` };
        const psyche = (Array.isArray(lines) ? lines : [lines]).map(text).filter(Boolean);
        if (!psyche.length) return { ok: false, error: 'psyche.md needs at least one line.' };
        const rp = await rpNow();
        const history = [...(found.history ?? [])];
        if ((found.psyche ?? []).length) {
            history.push({ at: rp.label, by, part: 'psyche', section: 0, old: found.psyche.join('\n'), new: psyche.join('\n'), comment });
        }
        const key = bankKey(found.name);
        await save({ ...state, [key]: { ...found, psyche, history: history.slice(-HISTORY_LIMIT) } });
        // Переписан по просьбе пользователя — исправление, а не событие: в снимки тоже.
        if (correction) await propagate({ [key]: { psyche: found.psyche ?? [] } }, { [key]: { psyche } });
        return { ok: true, character: found.name, lines: psyche.length };
    }

    /**
     * Исправление вне сюжета (входящий ящик, вкладка Files): часть целиком (psyche — строки) или названные разделы
     * (material, spiritual, decree — `{ номер: строки }`) заменяются, старое — в историю, снимки — тоже.
     */
    async function correct({ character, part, lines = null, sections = null, comment = '', by = 'user' } = {}) {
        if (!CORRECTED_PARTS.includes(part)) return { ok: false, error: `Unknown part "${part}": use ${CORRECTED_PARTS.join(', ')}.` };
        const state = await sync();
        const found = findCharacter(state, character);
        if (!found) return { ok: false, error: `There is no character "${character}".` };
        if (isUserCharacter(found) && (part === 'decree' || part === 'psyche')) return { ok: false, error: `${found.name} ${USER_CHARACTER_NOTE}` };
        const rp = await rpNow();
        const note = text(comment) || 'Corrected outside the story.';
        const history = [...(found.history ?? [])];
        let value;
        if (part === 'psyche') {
            value = (Array.isArray(lines) ? lines : [lines]).map(text).filter(Boolean);
            if (!value.length) return { ok: false, error: 'psyche.md needs at least one line.' };
            history.push({ at: rp.label, by, part, section: 0, old: (found.psyche ?? []).join('\n'), new: value.join('\n'), comment: note });
        } else {
            const given = Object.entries(sections && typeof sections === 'object' ? sections : {});
            if (!given.length) return { ok: false, error: `Name the sections of ${part}.md to replace: { "1": ["line", …] }.` };
            value = clone(found[part] ?? {});
            for (const [no, rows] of given) {
                const next = (Array.isArray(rows) ? rows : [rows]).map(text).filter(Boolean);
                history.push({ at: rp.label, by, part, section: Number(no), old: (value[no] ?? []).join('\n'), new: next.join('\n'), comment: note });
                value[no] = next;
            }
        }
        const key = bankKey(found.name);
        const before = { [key]: { [part]: clone(found[part] ?? (part === 'psyche' ? [] : {})) } };
        await save({ ...state, [key]: { ...found, [part]: value, history: history.slice(-HISTORY_LIMIT) } });
        const snapshots = await propagate(before, { [key]: { [part]: value } });
        return { ok: true, character: found.name, part, snapshots };
    }

    /**
     * Прошлое с пользователем и вехи (инструмент Директора): с какого времени знакомы до истории, сколько были вместе,
     * и событие между ними. Веха без «when» — событие истории: движок ставит ей час игры сам.
     */
    async function setAcquaintance({ character, knownSince = null, before = null, milestone = null, firstMeeting = false, comment = '' } = {}) {
        const state = await sync();
        const found = findCharacter(state, character);
        if (!found) return { ok: false, error: `There is no character "${character}".` };
        if (isUserCharacter(found)) return { ok: false, error: `${found.name} is the user's character: their past with themselves is not recorded.` };
        const record = normalizeWithUser(found.withUser);
        if (knownSince !== null && knownSince !== undefined) record.knownSince = text(knownSince);
        if (before !== null && before !== undefined) record.before = text(before);
        // «По нулям»: до истории не встречались — это тоже записанное прошлое.
        if (firstMeeting === true) record.firstMeeting = true;
        const what = text(milestone?.what);
        if (what) {
            const when = text(milestone?.when);
            record.milestones = [...record.milestones, { at: when ? null : clockMinutes(), when, what }];
        }
        const rp = await rpNow();
        const history = [...(found.history ?? []), { at: rp.label, by: 'director', part: 'withUser', section: 0, old: '', new: [firstMeeting === true ? 'first meets the user in the story' : '', record.knownSince, record.before, what].filter(Boolean).join(' · '), comment: text(comment) }];
        await save({ ...state, [bankKey(found.name)]: { ...found, withUser: record, history: history.slice(-HISTORY_LIMIT) } });
        return { ok: true, character: found.name, knownSince: record.knownSince, before: record.before, milestones: record.milestones.length };
    }

    /**
     * Карточка на нескольких (инструмент Директора): каждый человек из неё — свой персонаж со своей важностью и тем же
     * card.md; общая запись уходит в NPC/Mass с отметкой, на кого разделена, и больше не играется и не показывается.
     */
    async function splitCharacter({ character, into = [], comment = '' } = {}) {
        const state = await sync();
        const found = findCharacter(state, character);
        if (!found) return { ok: false, error: `There is no character "${character}".` };
        if (isUserCharacter(found)) return { ok: false, error: `${found.name} is the user's character.` };
        const people = (Array.isArray(into) ? into : []).map(item => ({ name: text(item?.name), importance: normalizeImportance(item?.importance || 'side') })).filter(item => item.name);
        if (people.length < 2) return { ok: false, error: 'Split into at least two characters: { name, importance } for each person the card describes.' };
        const card = text(found.fallbackText) || text(found.textHash);
        const rp = await rpNow();
        let next = { ...state };
        const made = [];
        for (const person of people) {
            const ensured = ensureCharacter(next, person.name, { importance: person.importance });
            next = ensured.state;
            const target = findCharacter(next, person.name);
            if (isUserCharacter(target)) continue;
            const note = `This card describes several characters; this file is for ${target.name}.\n\n${card}`;
            next = { ...next, [bankKey(target.name)]: { ...target, importance: person.importance, splitFrom: found.name, fallbackText: text(target.fallbackText) || note,
                history: [...(target.history ?? []), { at: rp.label, by: 'director', part: 'split', section: 0, old: found.name, new: target.name, comment: text(comment) }].slice(-HISTORY_LIMIT) } };
            made.push(target.name);
        }
        next = { ...next, [bankKey(found.name)]: { ...next[bankKey(found.name)], importance: 'mass', splitInto: made, fallbackText: '' } };
        await save(next);
        return { ok: true, split: found.name, into: made };
    }

    /** Отчёты Симулятора — последние моменты каждого (до трёх): непрерывность состояния между ходами. */
    async function noteMoments(list = []) {
        const state = await load();
        let changed = false;
        const next = { ...state };
        for (const { name, account } of Array.isArray(list) ? list : []) {
            const found = findCharacter(next, name);
            if (!found || !account) continue;
            const keep = ['took', 'inner', 'does', 'says'].reduce((out, field) => ({ ...out, [field]: text(account[field]) }), {});
            next[bankKey(found.name)] = { ...found, moments: [...(Array.isArray(found.moments) ? found.moments : []), keep].slice(-3) };
            changed = true;
        }
        if (changed) await save(next);
        return { ok: true, changed };
    }

    /**
     * Срок (инструмент Директора): к какому моменту RP-времени персонаж должен что-то сделать или что с ним случится.
     * Момент — в той же форме, что метки строк в файлах; движок показывает резолверу, сколько осталось.
     */
    async function setDeadline({ character, by = '', what = '', comment = '' } = {}) {
        const state = await sync();
        const found = findCharacter(state, character);
        if (!found) return { ok: false, error: `There is no character "${character}".` };
        const rp = await rpNow();
        const at = parseInstant(by);
        // Мир с датой — срок тоже с датой; мир на счётчике дней — «Day N, HH:MM». Голое «06:00» не принимается.
        const DATED = 999_999_999_360;
        const dated = at !== null && (rp.value >= DATED ? at >= DATED : /^day\b/i.test(text(by)));
        if (!dated || !text(what)) return { ok: false, error: `Give "by" in the form the files stamp their lines — now is "${rp.label}" — and "what" hangs on it.` };
        const deadlines = [...(Array.isArray(found.deadlines) ? found.deadlines : []).filter(item => text(item?.what) !== text(what)), { at, what: text(what) }];
        const history = [...(found.history ?? []), { at: rp.label, by: 'director', part: 'deadline', section: 0, old: '', new: `${formatInstant(at)} — ${text(what)}`, comment: text(comment) }];
        await save({ ...state, [bankKey(found.name)]: { ...found, deadlines, history: history.slice(-HISTORY_LIMIT) } });
        return { ok: true, character: found.name, by: formatInstant(at), what: text(what) };
    }

    /**
     * Ход принят: у каждого в сцене, кроме пользователя, — первая общая сцена (если её ещё не было) и минуты вместе.
     * Лежит в Great Bank, поэтому снимок хода и откат несут его сами.
     */
    async function noteTogether({ names = [], minutes = 0, endMinutes = null } = {}) {
        const spent = Math.max(0, Number(minutes) || 0);
        const end = Number.isFinite(Number(endMinutes)) ? Number(endMinutes) : clockMinutes();
        const state = await load();
        let changed = false;
        const next = { ...state };
        for (const name of Array.isArray(names) ? names : []) {
            const found = findCharacter(next, name);
            if (!found || isUserCharacter(found)) continue;
            const record = normalizeWithUser(found.withUser);
            if (record.met === null) record.met = Math.max(0, end - spent);
            record.together += spent;
            next[bankKey(found.name)] = { ...found, withUser: record };
            changed = true;
        }
        if (changed) await save(next);
        return { ok: true, changed };
    }

    /**
     * Переписать Main Cast заново (по просьбе пользователя): material, spiritual и Указ пустеют,
     * прежние строки — в историю, исходная карточка (card.md) остаётся. Директор пишет их снова.
     */
    async function clearForRewrite({ importance = 'main', comment = 'The user asked the Director to rewrite this character.', by = 'user' } = {}) {
        const state = await sync();
        const rp = await rpNow();
        const next = { ...state };
        const names = [];
        for (const [key, character] of Object.entries(state)) {
            if (character?.importance !== importance) continue;
            const history = [...(character.history ?? [])];
            const blank = {};
            for (const part of ['material', 'spiritual', 'decree']) {
                blank[part] = Object.fromEntries(Object.keys(character[part] ?? {}).map(no => [no, []]));
                for (const [no, lines] of Object.entries(character[part] ?? {})) {
                    if ((lines ?? []).length) history.push({ at: rp.label, by, part, section: Number(no), old: lines.join('\n'), new: '', comment });
                }
            }
            // Психика написана под старые банки: с переписанным персонажем она больше не та.
            blank.psyche = [];
            if ((character.psyche ?? []).length) history.push({ at: rp.label, by, part: 'psyche', section: 0, old: character.psyche.join('\n'), new: '', comment });
            next[key] = { ...character, ...blank, history: history.slice(-HISTORY_LIMIT) };
            names.push(character.name);
        }
        await save(next);
        return { ok: true, names };
    }

    async function setDecree({ decrees = [], comment = '' } = {}) {
        const state = await sync();
        const rp = await rpNow();
        const applied = applyDecrees(state, normalizeDecrees(decrees), { at: rp.label, comment, by: 'director' });
        const next = { ...applied.state };
        for (const [key, character] of Object.entries(next)) {
            if (character.history.length > HISTORY_LIMIT) next[key] = { ...character, history: character.history.slice(-HISTORY_LIMIT) };
        }
        await save(next);
        return { ok: true, at: rp.label, decrees: applied.applied };
    }

    /** Знания персонажа — блок записи: та же форма, что у системы знаний, но живёт при персонаже. */
    async function setKnowledge(name, items) {
        const state = await sync();
        const ensured = ensureCharacter(state, name, { importance: 'temporary' });
        const found = findCharacter(ensured.state, name);
        if (!found) return { ok: false, error: `There is no character "${name}".` };
        const list = (Array.isArray(items) ? items : []).filter(item => item && typeof item === 'object' && String(item.id ?? '').trim() && String(item.fact ?? '').trim());
        await save({ ...ensured.state, [bankKey(found.name)]: { ...found, knowledge: { items: list } } });
        return { ok: true, character: found.name, count: list.length };
    }

    /** Каноническое имя персонажа по имени или псевдониму — привязка знаний идёт через запись Great Bank. */
    async function resolveName(name) {
        const state = await sync();
        return findCharacter(state, name)?.name ?? String(name ?? '').trim();
    }

    /** Предложения резолвера: его правки духовного, которые ждут директора. */
    async function pending() {
        const state = await sync();
        return Object.values(state)
            .filter(character => (character.pending ?? []).length)
            .map(character => ({ character: character.name, items: character.pending.map(item => ({ ...item })) }));
    }

    /** Директор принимает или отклоняет предложение резолвера. */
    async function resolvePending({ character, accept = true, index = 0 } = {}) {
        const state = await sync();
        const found = findCharacter(state, character);
        if (!found) return { ok: false, error: `There is no character "${character}".` };
        const item = found.pending?.[index];
        if (!item) return { ok: false, error: 'There is no such pending edit.' };
        const rest = found.pending.filter((_, at) => at !== index);
        let next = { ...state, [bankKey(found.name)]: { ...found, pending: rest } };
        if (accept) {
            const section = `${item.part === 'decree' ? 'decree' : item.part} ${item.section}`;
            next = applyEdits(next, {
                edits: [{ character: found.name, section, old: item.old, new: item.new }],
                comment: item.comment, by: 'director', at: item.at, nowValue: null, timeOfDay: timeOfDay(),
            }).state;
        }
        await save(next);
        return { ok: true, accepted: Boolean(accept) };
    }

    function entriesFor(state, names = null) {
        const wanted = Array.isArray(names) ? new Set(names.map(bankKey)) : null;
        return Object.values(state)
            .filter(character => !wanted || wanted.has(bankKey(character.name)) || (character.aliases ?? []).some(alias => wanted.has(bankKey(alias))))
            .map(character => ({ character }));
    }

    async function projection(render, names, extra = {}) {
        const state = await sync();
        const rp = await rpNow();
        return render(entriesFor(state, names), { nowValue: rp.value, ...extra });
    }

    /** Дальняя компактная проекция: все персонажи, Material 1/3/6 + Spiritual 4/6. */
    const farText = () => projection(renderFarBanks);
    /** Ближняя полная проекция: только названные (активный ростер). */
    const nearText = names => projection(renderNearBanks, names);
    /** Ближняя полная проекция для писателя — те же банки, свой заголовок. */
    const writerText = names => projection(renderNearBanks, names);
    /** Указы всех персонажей; до фазы 4 их нет — блок пустой. */
    const decreeText = () => projection(renderDecreeSection);

    async function historyFor(name) {
        const state = await sync();
        const found = findCharacter(state, name);
        return found ? found.history.map(item => ({ ...item })) : [];
    }

    return {
        load, sync, replace, edit, setImportance, setDecree, writeDecree, setPsyche, clearForRewrite, pending, resolvePending, resolveName, setKnowledge,
        correct,
        noteMoments,
        setDeadline,
        splitCharacter,
        setAcquaintance, noteTogether, clockMinutes,
        farText, nearText, writerText, decreeText, rpNow, historyFor,
        sectionOf: resolveSection,
    };
}
