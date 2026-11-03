import { DECISION_NAMESPACE } from '../../libraries/core/decision-settings.js';

/**
 * Банки bootstrap вне чата. После bootstrap готовые банки сохраняются набором,
 * привязанным к книгам лорбука; в новом чате с теми же книгами движок
 * спрашивает тостом, взять ли готовые, и если да — ставит их сразу. Набор
 * обновляется только в фазе bootstrap (пока в чате нет ни одного хода), так
 * что в нём лежит именно «стартовая» версия, а не правки поздней игры.
 */
const SETS_KEY = 'bankSets';
const MAX_SETS = 5;
const USE_FRESH = 'Build new banks';
const text = value => String(value ?? '').trim();

export function createBankSets({ call, banks, store, bootstrap, askUser, publishEvent, now = () => Date.now() }) {
    async function lorebookKey() {
        try {
            const entries = await call('lorebook.entries');
            const books = [...new Set((Array.isArray(entries) ? entries : []).map(entry => text(entry?.book)).filter(Boolean))].sort();
            return books.length ? `books:${books.join('|')}` : '';
        } catch { return ''; }
    }

    async function readAll() {
        const value = await call('storage.settings.get', { namespace: DECISION_NAMESPACE, key: SETS_KEY, fallback: {} }).catch(() => ({}));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }

    async function setsFor(key) {
        if (!key) return [];
        const all = await readAll();
        return (Array.isArray(all[key]) ? all[key] : []).filter(set => set && Object.keys(set.banks ?? {}).length);
    }

    function label(set) {
        const timeline = text(set.timeline).replace(/^TIMELINE\s*:?\s*/i, '').split('\n').map(text).find(Boolean) ?? '';
        const short = timeline.length > 110 ? `${timeline.slice(0, 107)}…` : timeline;
        const date = new Date(set.createdAt || 0).toLocaleDateString();
        return `${Object.keys(set.banks).length} banks from ${date}${short ? ` — ${short}` : ''}`;
    }

    /** Новый чат: есть готовые наборы для этих книг — спросить. Возвращает, сколько банков поставлено. */
    async function offer() {
        const key = await lorebookKey();
        const sets = (await setsFor(key)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 3);
        if (!sets.length || typeof askUser !== 'function') return 0;
        const options = [...sets.map(label), USE_FRESH];
        const answer = await askUser({
            question: 'Character banks for this lorebook were already built in an earlier chat. Use them?',
            options,
            why: 'Ready banks start the chat at once; new ones are researched from scratch and take a few minutes.',
        });
        const index = options.indexOf(text(answer?.answer));
        if (answer?.skipped || index < 0 || index >= sets.length) return 0;
        const applied = await banks.applySet(sets[index]);
        publishEvent('decision.bankSet.used', { key, setId: sets[index].id, applied });
        return applied;
    }

    /** Снимок готовых банков чата — только в фазе bootstrap (ходов ещё не было). */
    async function snapshot() {
        const state = bootstrap.state();
        if (state.status !== 'done' || !state.startedAt) return false;
        if ((typeof store.cycles === 'function' ? store.cycles() : []).some(cycle => ['turn', 'regenerate', 'swipe'].includes(cycle?.event))) return false;
        const key = await lorebookKey();
        if (!key) return false;
        const ready = banks.records().filter(record => record.status === 'ready' && text(record.text) && record.sourceKind !== 'history');
        if (!ready.length) return false;
        const set = {
            id: `chat_${state.startedAt}`, createdAt: state.startedAt, updatedAt: now(),
            timeline: text(store.chatBrief?.()?.text ?? ''),
            banks: Object.fromEntries(ready.map(record => [record.sourceKey, {
                name: record.name, sourceKind: record.sourceKind, sourceHash: record.sourceHash, text: record.text,
                sizeBand: record.sizeBand, aliases: record.aliases ?? [], canonicalName: record.canonicalName ?? '',
                examples: record.examples ?? '', timelineHash: record.timelineHash ?? '',
            }])),
        };
        const all = await readAll();
        const others = (Array.isArray(all[key]) ? all[key] : []).filter(item => item?.id !== set.id);
        all[key] = [set, ...others].slice(0, MAX_SETS);
        await call('storage.settings.set', { namespace: DECISION_NAMESPACE, key: SETS_KEY, value: all });
        publishEvent('decision.bankSet.saved', { key, setId: set.id, banks: ready.length });
        return true;
    }

    return { offer, snapshot, setsFor, lorebookKey };
}
