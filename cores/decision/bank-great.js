import { DECISION_MEMORY_NAMESPACE } from '../../libraries/core/decision-settings.js';
import { applyDecrees, applyEdits, bankKey, ensureCharacter, findCharacter, normalizeCharacter, normalizeGreatBank, normalizeImportance, resolveSection } from '../../libraries/core/decision-great-bank.js';
import { normalizeDecrees } from '../../libraries/core/decision-decree.js';
import { parseBankSections } from '../../libraries/core/decision-bank-parse.js';
import { BANK_BUILDER_VERSION } from '../../libraries/core/decision-banks.js';
import { formatInstant, rpInstant } from '../../libraries/core/decision-bank-time.js';
import { renderFarBanks, renderNearBanks, renderDecreeSection } from '../../libraries/core/decision-bank-projections.js';
import { createTimeReader } from './readers.js';

const GREAT_KEY = 'greatBank';
const HISTORY_LIMIT = 300;

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
    async function edit({ comment = '', edits = [] } = {}, { by = 'director' } = {}) {
        const state = await sync();
        const rp = await rpNow();
        const applied = applyEdits(state, { edits, comment, by, at: rp.label, nowValue: rp.value, importance: 'temporary', timeOfDay: timeOfDay() });
        for (const [key, character] of Object.entries(applied.state)) {
            if (character.history.length > HISTORY_LIMIT) applied.state[key] = { ...character, history: character.history.slice(-HISTORY_LIMIT) };
            if (character.sectionsReady === false) applied.state[key] = { ...applied.state[key], sectionsReady: true };
        }
        await save(applied.state);
        return { ok: true, at: rp.label, changes: applied.changes, created: applied.created };
    }

    /** Уровень важности персонажа: main / side / temporary / mass. */
    async function setImportance({ character, importance } = {}) {
        const state = await sync();
        const ensured = ensureCharacter(state, character, { importance });
        const found = findCharacter(ensured.state, character);
        if (!found) return { ok: false, error: `There is no character "${character}".` };
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
        load, sync, edit, setImportance, setDecree, writeDecree, pending, resolvePending, resolveName, setKnowledge,
        farText, nearText, writerText, decreeText, rpNow, historyFor,
        sectionOf: resolveSection,
    };
}
