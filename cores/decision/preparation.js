import { DECISION_MEMORY_NAMESPACE } from '../../libraries/core/decision-settings.js';
import { godWorkerId, directorWorkerId } from '../../libraries/core/decision-settings.js';
import { mainWithoutDecree } from '../../libraries/core/decision-director.js';
import { normalizePreparation, stepFromFacts } from '../../libraries/core/decision-preparation.js';

/**
 * Явная машина подготовки к игре. Шаги не будят друг друга событиями: каждый
 * вызов `advance()` смотрит на факты (банки отсортированы? Creation готова?
 * есть открытые вопросы God? у всех Main Cast есть Указ?) и только потом
 * запускает роль, если её шаг текущий и она ещё не работает. Потерянное
 * событие поэтому ничего не останавливает, а лишних вызовов дорогих моделей
 * нет: без повода — ни одного запроса.
 *
 * Состояние — в памяти чата (`storage.chatMemory`, namespace `core.decision`,
 * key `preparation`): `{ step, startedAt, updatedAt, error }`.
 */

const KEY = 'preparation';
const STEP_LIMIT = 6;
const text = value => String(value ?? '').trim();

export function createPreparation({
    call, callService = null, store, banks, creation, cycle, getSettings = null,
    publishEvent = () => {}, facts = null, now = () => Date.now(),
}) {
    let running = null;
    let epoch = 0;

    const service = async (contract, params) => {
        if (typeof callService === 'function') return callService(contract, params);
        return call(contract, params);
    };

    async function readRaw() {
        try {
            const value = await call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: KEY, fallback: null });
            return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
        } catch { return null; }
    }

    async function state() {
        return normalizePreparation(await readRaw());
    }

    async function persist(next, startEpoch = epoch) {
        if (startEpoch !== epoch) return normalizePreparation(next);
        const value = normalizePreparation({ ...next, updatedAt: now() });
        await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: KEY, value }).catch(() => {});
        publishEvent('decision.preparation.changed', { ...value });
        return value;
    }

    function hasPlayed() {
        const runs = typeof store?.runs === 'function' ? store.runs() : null;
        if (runs && Object.keys(runs).length) return true;
        return (typeof store?.cycles === 'function' ? store.cycles() : [])
            .some(cycle => ['turn', 'regenerate', 'swipe'].includes(String(cycle?.event ?? '')));
    }

    function banksSorted() {
        const progress = typeof banks?.progress === 'function' ? banks.progress() : {};
        if (['ready', 'partial'].includes(String(progress?.status ?? ''))) return true;
        const records = typeof banks?.records === 'function' ? banks.records() : [];
        return records.length > 0 && records.every(record => !['pending', 'short'].includes(String(record?.status ?? '')));
    }

    async function hasCards() {
        try {
            const cards = await service('stCharacter.chatCharacters');
            return Array.isArray(cards) && cards.length > 0;
        } catch { return false; }
    }

    async function mainCastWithoutDecree() {
        if (!banks?.great?.load) return 0;
        try {
            const state = await banks.great.sync?.() ?? await banks.great.load();
            return mainWithoutDecree(state).length;
        } catch { return 0; }
    }

    async function defaultFacts() {
        const papers = typeof store?.papers === 'function' ? store.papers() ?? {} : {};
        const god = papers.god && typeof papers.god === 'object' ? papers.god : {};
        const questions = Array.isArray(god.questions) ? god.questions : [];
        const openQuestions = questions.some(item => !text(item?.answer));
        const declarationReady = (Array.isArray(god.declaration?.answers) ? god.declaration.answers : []).some(item => text(item?.answer));
        const studied = Boolean(god.studiedAt) || Boolean(god.lastRunAt) || questions.length > 0;
        const played = hasPlayed();
        const sorted = banksSorted();
        let complete = false;
        let started = false;
        try {
            await creation?.load?.();
            complete = Boolean(creation?.complete?.());
            started = Boolean(creation?.started?.());
        } catch { /* хранилище недоступно — считаем, что мира ещё нет */ }
        return {
            played,
            startable: await hasCards(),
            sorted,
            studied,
            openQuestions,
            declarationReady,
            creationStarted: started,
            creationComplete: complete,
            // Без подключения Бога мира не будет — директор пишет банки по карточкам и без него.
            godConfigured: Boolean(godWorkerId(getSettings?.() ?? {})),
            directorConfigured: Boolean(directorWorkerId(getSettings?.() ?? {})),
            mainWithoutDecree: (complete || !godWorkerId(getSettings?.() ?? {})) ? await mainCastWithoutDecree() : 0,
        };
    }

    const factsNow = typeof facts === 'function' ? async () => ({ startable: true, ...(await facts()) }) : defaultFacts;

    function failed(result) {
        return Boolean(result && (result.ok === false || result.type === 'error'));
    }

    function failureText(role, result) {
        const reason = text(result?.message) || text(result?.reason);
        return `${role}: ${reason || 'the run did not finish'}`;
    }

    async function runRole(step) {
        if (step === 'study' || step === 'build') {
            const result = await cycle?.maybeRunGod?.({ allowBuild: true });
            return failed(result) ? failureText('God', result) : '';
        }
        if (step === 'cast') {
            const result = await cycle?.maybeRunDirector?.();
            return failed(result) ? failureText('The Director', result) : '';
        }
        return '';
    }

    /** Продолжить с факта: поставить текущий шаг и, если нужно, запустить его роль. */
    async function advance({ retry = false } = {}) {
        if (running) return running;
        const startEpoch = epoch;
        running = runAdvance({ retry, startEpoch }).finally(() => { running = null; });
        return running;
    }

    async function runAdvance({ retry, startEpoch }) {
        const raw = await readRaw();
        let current = normalizePreparation(raw);
        let value = await factsNow();
        if (startEpoch !== epoch) return current;
        // Старый чат: ход уже был — игра идёт, подготовка ему не нужна. Новый чат без
        // единого источника (нет карточек) тоже готовить нечего. Ничего не пишем:
        // у таких чатов нет шага, который стоило бы помнить.
        if (value.played || (!raw && !value.startable)) {
            return { ...current, step: 'ready' };
        }
        if (current.step === 'ready') return current;

        let step = stepFromFacts(value);
        if (step === current.step && current.error && !retry) return current;
        current = await persist({ step, startedAt: step !== current.step || !current.startedAt ? now() : current.startedAt, error: '' }, startEpoch);

        const attempted = new Set();
        for (let index = 0; index < STEP_LIMIT; index += 1) {
            if (startEpoch !== epoch) return current;
            value = await factsNow();
            step = stepFromFacts(value);
            if (step === 'ready') {
                if (current.step !== 'ready') current = await persist({ step: 'ready', startedAt: current.startedAt || now(), error: '' }, startEpoch);
                return current;
            }
            if (step !== current.step || current.error) {
                current = await persist({ step, startedAt: step !== current.step || !current.startedAt ? now() : current.startedAt, error: '' }, startEpoch);
            }
            // Ответы ждём у Советника: модели здесь нечего делать.
            if (step === 'answers' || attempted.has(step)) return current;
            attempted.add(step);
            if (step === 'sort') {
                try {
                    await banks?.ensureColdStart?.();
                } catch (failure) {
                    return persist({ ...current, error: `Banks: ${failure?.message ?? failure}` }, startEpoch);
                }
                continue;
            }
            try {
                const error = await runRole(step);
                if (error) return persist({ ...current, error }, startEpoch);
            } catch (failure) {
                return persist({ ...current, error: `${step === 'cast' ? 'The Director' : 'God'}: ${failure?.message ?? failure}` }, startEpoch);
            }
        }
        return current;
    }

    /**
     * Только факты, без ролей и без записи: нужен ходу игры, чтобы честно
     * отказать до `ready`, и окну — чтобы показать шаг. Ни одного вызова модели.
     */
    async function assess() {
        const raw = await readRaw();
        const current = normalizePreparation(raw);
        const value = await factsNow();
        if (value.played || (!raw && !value.startable)) return { ...current, step: 'ready' };
        if (current.step === 'ready') return current;
        return { ...current, step: stepFromFacts(value) };
    }

    /** «Retry»: повторить упавший шаг — очистить ошибку и снова посмотреть на факты. */
    function retry() {
        return advance({ retry: true });
    }

    /** Canon применён: мир и банки уже на месте, игра открыта без единого вызова God/Director. */
    async function markReady() {
        const current = await state();
        return persist({ step: 'ready', startedAt: current.startedAt || now(), error: '' });
    }

    /** Смена чата: запоздавший прогон старого чата не пишет в новый. */
    function reset() {
        epoch += 1;
        running = null;
    }

    return { state, advance, assess, retry, markReady, reset, facts: defaultFacts };
}
