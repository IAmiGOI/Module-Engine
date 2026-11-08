import { DECISION_NAMESPACE } from '../../libraries/core/decision-settings.js';
import { canonKey, canonSummary, normalizeCanons } from '../../libraries/core/decision-canon.js';
import { BANK_BUILDER_VERSION } from '../../libraries/core/decision-banks.js';

/**
 * Canon — сохранённый итог подготовки: Creation (разделы и Scales с
 * открытиями), Great Bank (material, spiritual, decree, importance) и записи
 * банков (исходные card.md). Хранится в настройках расширения под ключом
 * набора лорбуков и карточек. Новый чат с тем же набором берёт Canon сразу:
 * мир и банки копируются, подготовка становится `ready`, ни God, ни Director
 * не вызываются.
 *
 * Canon не обновляется по ходу игры: новая версия — только новой кнопкой
 * «Save as Canon».
 */

const CANONS_KEY = 'canons';
const MAX_CANONS = 12;
const text = value => String(value ?? '').trim();

export function createCanon({
    call, callService = null, store, banks, creation, preparation,
    askUser = null, publishEvent = () => {}, now = () => Date.now(),
}) {
    const service = async (contract, params) => {
        if (typeof callService === 'function') return callService(contract, params);
        return call(contract, params);
    };

    async function readAll() {
        const value = await call('storage.settings.get', { namespace: DECISION_NAMESPACE, key: CANONS_KEY, fallback: {} }).catch(() => ({}));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }

    /** Набор книг лорбука и карточек чата — тот же ключ, что у Canon. */
    async function keyNow() {
        try {
            const [entries, cards] = await Promise.all([
                call('lorebook.entries').catch(() => []),
                service('stCharacter.chatCharacters').catch(() => []),
            ]);
            return canonKey({
                books: (Array.isArray(entries) ? entries : []).map(entry => entry?.book),
                cards: (Array.isArray(cards) ? cards : []).map(card => card?.name),
            });
        } catch { return ''; }
    }

    async function list(key = null) {
        const wanted = key ?? await keyNow();
        if (!wanted) return [];
        return normalizeCanons((await readAll())[wanted]);
    }

    async function find({ id = '', name = '' } = {}) {
        const canons = await list();
        return canons.find(canon => canon.id === text(id)) ?? canons.find(canon => canon.name === text(name)) ?? null;
    }

    function recordCopy(record) {
        return {
            sourceKey: String(record?.sourceKey ?? ''), sourceKind: String(record?.sourceKind ?? ''),
            name: text(record?.name), sourceHash: String(record?.sourceHash ?? ''), text: String(record?.text ?? ''),
            sizeBand: record?.sizeBand === 'key' ? 'key' : 'minor', rawSource: String(record?.rawSource ?? ''),
            examples: String(record?.examples ?? ''), aliases: Array.isArray(record?.aliases) ? [...record.aliases] : [],
            canonicalName: text(record?.canonicalName), importance: text(record?.importance),
            builderVersion: Number(record?.builderVersion) || BANK_BUILDER_VERSION, timelineHash: String(record?.timelineHash ?? ''),
            status: 'ready',
        };
    }

    /** «Save as Canon»: снимок мира и банков под именем игрока; прежние версии не трогаются. */
    async function save({ name } = {}) {
        const clean = text(name);
        if (!clean) return { ok: false, error: 'A Canon needs a name.' };
        const key = await keyNow();
        if (!key) return { ok: false, error: 'There are no books or cards to bind a Canon to.' };
        await creation?.load?.();
        const creationState = creation?.state?.() ?? {};
        await banks?.great?.sync?.();
        const great = (await banks?.great?.load?.()) ?? {};
        const records = {};
        for (const record of typeof banks?.records === 'function' ? banks.records() : []) {
            if (!text(record?.name) || !text(record?.text)) continue;
            records[String(record.sourceKey)] = recordCopy(record);
        }
        const canon = {
            id: `canon_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            name: clean, createdAt: now(), creation: creationState, great, banks: records,
        };
        const all = await readAll();
        all[key] = [canon, ...normalizeCanons(all[key])].slice(0, MAX_CANONS);
        await call('storage.settings.set', { namespace: DECISION_NAMESPACE, key: CANONS_KEY, value: all });
        publishEvent('decision.canon.saved', { key, canon: canonSummary(canon) });
        return { ok: true, canon: canonSummary(canon) };
    }

    /** Взять готовый Canon: Creation и банки копируются, подготовка сразу `ready`. */
    async function apply({ id = '', name = '' } = {}) {
        const canon = await find({ id, name });
        if (!canon) return { ok: false, error: 'There is no such Canon.' };
        await creation?.save?.(canon.creation);
        await banks?.applySet?.({ banks: canon.banks });
        await banks?.great?.replace?.(canon.great);
        await banks?.markSorted?.();
        await preparation?.markReady?.();
        publishEvent('decision.canon.applied', { canon: canonSummary(canon) });
        return { ok: true, canon: canonSummary(canon) };
    }

    /**
     * Новый чат с тем же набором: тост «Есть Canon … Взять?». Да — мир и банки
     * сразу; нет или пропуск — обычная подготовка.
     */
    async function offer() {
        if (typeof askUser !== 'function') return 0;
        const canons = (await list()).slice(0, 3);
        if (!canons.length) return 0;
        const options = [
            ...canons.map(canon => `Canon “${canon.name}” — ${canonSummary(canon).characters} characters, ${new Date(canon.createdAt || 0).toLocaleDateString()}`),
            'No — build a new world',
        ];
        const answer = await askUser({
            question: 'A Canon already exists for these books and cards. Take it?',
            options,
            why: 'A Canon starts the chat at once with the world and banks saved earlier; God and the Director are not called again.',
        });
        const index = options.indexOf(text(answer?.answer));
        if (answer?.skipped || index < 0 || index >= canons.length) return 0;
        const result = await apply({ id: canons[index].id });
        return result.ok ? Object.keys(canons[index].banks).length : 0;
    }

    return { list, find, save, apply, offer, keyNow };
}
