import { request } from '../../libraries/shared/request.js';

const ST_PREFIX = 'st.';
const FIREHOSE = 'events.any';
// Пороги взяты один в один с Alpha's core/module-engine.js — там они
// выведены не из головы, а из реального рантайм-бага: слушатель
// CHAT_CHANGED, который своей же работой снова провоцировал CHAT_CHANGED.
const BURST_WINDOW_MS = 2000;
const BURST_LIMIT = 8;
const DEFAULT_BURST_GUARDED = Object.freeze(['st.chatChanged']);
// Потоковые события ST срабатывают на КАЖДЫЙ токен генерации — мостить их
// на Шину событий по умолчанию значит сотни эмитов на один ответ модели.
const DEFAULT_EXCLUDED_ST = Object.freeze(['STREAM_TOKEN_RECEIVED', 'SMOOTH_STREAM_TOKEN_RECEIVED']);

/** Чистая деривация: `CHAT_CHANGED` → `st.chatChanged`, `GENERATE_AFTER_COMBINE_PROMPTS` → `st.generateAfterCombinePrompts`. Механическая, без таблицы соответствий вручную — новое событие в ST получает имя само. */
export function computeEngineEventName(stEvent) {
    const camel = String(stEvent ?? '').toLowerCase().replace(/_([a-z0-9])/g, (match, char) => char.toUpperCase());
    return `${ST_PREFIX}${camel}`;
}

/**
 * Ядро событий — управляемый фасад ВСЕЙ событийной поверхности движка.
 *
 * Разделение, ради которого оно существует:
 *  - **Сервис событий** ([services/st-events.js](../../services/st-events.js))
 *    знает только про `context.eventSource`/`eventTypes` — подписать,
 *    отписать, перечислить. Ни трансляции имён, ни защит, ни состояния.
 *  - **Это Ядро** берёт внешнее у Сервиса и добавляет всю внутреннюю
 *    логику: перевод имён на Шину событий, защиту от штормов и петель,
 *    резерв неймспейса, единый вход для ВНУТРЕННИХ публикаций и живой
 *    реестр того, что вообще происходит в движке.
 *
 * **Внутренние Ядра и Модули публикуют через это же Ядро**, а не эмитят на
 * Шину напрямую: только так защиты и реестр видят полную картину. Для Ядер
 * это обычный синхронный `publish()` (передаётся при сборке движка); для
 * Модулей — контракт `events.publish` через Гейт, с проверкой прав.
 *
 * **Подписки здесь НЕТ намеренно.** Условия доставки (по событию, каждый
 * N-й, debounce/throttle/dedupe/once) — работа Директора, см. `when` в
 * [contract-bus.js](../../libraries/shared/contract-bus.js). Дублировать их
 * фасадом здесь значило бы завести второй, конкурирующий способ делать то
 * же самое.
 *
 * `st.*` зарезервирован за настоящим мостом ST: внутренняя публикация с
 * таким именем отклоняется, иначе любое Ядро/Модуль могло бы подделать
 * внешнее событие, на которое остальные полагаются как на факт из ST.
 */
export function createEventsCore(host, { burstGuarded = DEFAULT_BURST_GUARDED, excludedStEvents = DEFAULT_EXCLUDED_ST } = {}) {
    const stSubscriptions = new Map(); // ST event key -> handler (нужна ТА ЖЕ ссылка для отписки)
    const dispatching = new Set();     // имена событий, доставка которых прямо сейчас идёт
    const bursts = new Map();          // имя события -> [timestamps]
    const surface = new Map();         // имя события -> { event, source, count, lastAt }
    const guarded = new Set(burstGuarded);
    const excluded = new Set(excludedStEvents);

    function record(event, source) {
        const entry = surface.get(event) ?? { event, source, count: 0, lastAt: 0 };
        entry.source = source;
        entry.count += 1;
        entry.lastAt = Date.now();
        surface.set(event, entry);
    }

    /**
     * Две защиты, обе выстраданы в Alpha:
     *  - реентрантность: событие, которое сработало ПОВТОРНО, пока ещё идёт
     *    доставка его же самого — это петля, законным оно не бывает никогда,
     *    поэтому проверка безусловная для всех событий;
     *  - шторм: больше BURST_LIMIT срабатываний за BURST_WINDOW_MS. Эта
     *    защита ТЕРЯЕТ события, поэтому включается только для явно
     *    перечисленных (по умолчанию — `st.chatChanged`, ровно тот случай,
     *    на котором Alpha и обожглась), а не для всех подряд: потерять
     *    `st.messageReceived` было бы хуже, чем пережить всплеск.
     */
    function allowed(event) {
        if (dispatching.has(event)) return false;
        if (!guarded.has(event)) return true;
        const now = Date.now();
        const recent = (bursts.get(event) ?? []).filter(at => now - at < BURST_WINDOW_MS);
        recent.push(now);
        bursts.set(event, recent);
        return recent.length <= BURST_LIMIT;
    }

    /** Единственное место во всём движке, откуда что-либо попадает на Шину событий. */
    function emit(event, payload, source) {
        if (!allowed(event)) return false;
        dispatching.add(event);
        try {
            record(event, source);
            host.events.emit(event, payload);
            host.events.emit(FIREHOSE, { event, source, payload });
        } finally {
            dispatching.delete(event);
        }
        return true;
    }

    /** Вход для ВНУТРЕННИХ публикаций (Ядра — напрямую, Модули — через контракт ниже). Возвращает false, если публикация была подавлена защитой. */
    function publish(event, payload, { source = 'unknown' } = {}) {
        const name = String(event ?? '').trim();
        if (!name) throw new Error('events.publish: event name is required.');
        if (name.startsWith(ST_PREFIX)) {
            throw new Error(`events.publish: "${ST_PREFIX}*" is reserved for real SillyTavern events — "${source}" tried to publish "${name}".`);
        }
        return emit(name, payload, source);
    }

    async function listStTypes() {
        const result = await request(host.services, 'stEvents.types', {});
        if (!result.ok) throw new Error(result.error.message);
        return result.value ?? [];
    }

    /**
     * Мостит события ST на Шину событий. Без аргумента — ВСЁ, что эта сборка
     * ST о себе заявляет (минус потоковые, см. DEFAULT_EXCLUDED_ST): так
     * новое событие в ST подхватывается само, без правок у нас (приоритет
     * "безопасность от изменений ST"). Со списком — только его, и тогда
     * неизвестный ST-ключ честно ругается в консоль, вместо того чтобы
     * молча никогда не сработать (та же диагностика, что у Alpha).
     */
    async function bridge(stEvents) {
        const available = await listStTypes();
        const wanted = (stEvents ?? available).filter(name => !excluded.has(name));

        for (const stEvent of wanted) {
            if (stSubscriptions.has(stEvent)) continue;
            if (stEvents && available.length && !available.includes(stEvent)) {
                console.warn(`[STME:events] "${stEvent}" is not in this SillyTavern build's eventTypes — nothing will ever fire it, so the bridge for it was skipped.`);
                continue;
            }
            const handler = (...args) => emit(computeEngineEventName(stEvent), { event: stEvent, args }, 'sillytavern');
            const result = await request(host.services, 'stEvents.subscribe', { params: { event: stEvent, handler } });
            if (!result.ok) throw new Error(result.error.message);
            stSubscriptions.set(stEvent, handler);
        }
        return [...stSubscriptions.keys()];
    }

    /** Снимает ВСЕ подписки у ST. Обязательно при разборке движка: оставленный слушатель продолжает стрелять в мёртвое Ядро (отдельно задокументированная боль Alpha). */
    async function stop() {
        for (const [stEvent, handler] of stSubscriptions) {
            await request(host.services, 'stEvents.unsubscribe', { params: { event: stEvent, handler } });
        }
        stSubscriptions.clear();
    }

    const unregisters = [
        // `source` заявляется вызывающим — тот же осознанный компромисс, что
        // и `namespace` у storage.* (см. ARCHITECTURE.md "Неймспейсинг:
        // заявленный, не проверенный"): Гейт доказывает ПРАВО публиковать,
        // но не то, кем вызывающий себя назвал.
        host.own.register('events.publish', params => publish(params?.event, params?.payload, { source: params?.source ?? 'module' })),
        host.own.register('events.types', () => listStTypes()),
        host.own.register('events.bridged', () => [...stSubscriptions.keys()]),
        host.own.register('events.surface', () => [...surface.values()]),
    ];

    return {
        bridge,
        stop,
        publish,
        surface: () => [...surface.values()],
        unregister: () => { for (const unregister of unregisters) unregister(); },
    };
}
