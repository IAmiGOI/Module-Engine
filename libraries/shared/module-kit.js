import { request } from './request.js';

/**
 * Типовая обвязка Модуля — то, что каждый из пяти существующих Модулей
 * (notebook, tracker, time, postprocess, music) писал у себя РУКАМИ и в
 * своём варианте: разовый вызов контракта, уведомления, персистентные
 * настройки, персистентная память чата, этап пайплайна, инструмент ST.
 *
 * Библиотека — набор НЕЗАВИСИМЫХ хелперов (решение пользователя), а не
 * единая фабрика: Модуль берёт только то, что ему нужно, и комбинирует сам.
 * Общего состояния между хелперами нет — каждый замыкается только на
 * переданный ему `host` и свои аргументы.
 *
 * Граница Библиотеки: ни ST, ни DOM, ни сети — весь внешний мир для неё
 * это контракты Шин, которые Модуль и так мог бы вызвать напрямую. Хелперы
 * ничего не знают о ЧЁМ хранится и КАК рисуется — только о механике вызовов.
 */

/**
 * Единый тон вызова контракта через Шину ядер + готовые уведомления.
 *
 * `notify` отдельным объектом намеренно: не всякий Модуль хочет тосты,
 * а отдельный кусок можно просто не деструктурировать.
 */
export function createModuleHost(host) {
    async function call(contract, params) {
        return request(host.cores, contract, { params });
    }
    return {
        call,
        notify: {
            ok: text => call('ui.notify', { tone: 'ok', text }),
            error: text => call('ui.notify', { tone: 'error', text }),
        },
    };
}

/**
 * Персистентные настройки Модуля: чтение при restore, запись по команде.
 *
 * Значения живут в СИГНАЛАХ Модуля — Библиотека не решает, какими они
 * быть (у notebook'а их три, у postprocess'а свой набор). Библиотека
 * только:
 *  - читает сохранённое ОДИН раз, явно, при `restore()` — та же гонка с
 *    ранним чтением, что у persisted-list.js, поэтому тот же приём;
 *  - применяет `clamp` перед применением и записью: любой мусор с диска
 *    превращается в валидные значения, никогда не бросает (у Notebook это
 *    был `clampNoteSettings`, у postprocess — `clampContextDepth` —
 *    каждый писал свой клампер руками);
 *  - пишет через `storage.settings.set` и возвращает true — форма,
 *    которую ждёт UI-кнопка «Save settings».
 *
 * `clamp` опционален: Модуль без границ не передаёт его, и значение с
 * диска применяется как есть.
 */
export function persistedSettings(host, { namespace, key = 'settings', clamp } = {}) {
    const { call } = createModuleHost(host);

    async function restore(apply) {
        const result = await call('storage.settings.get', { namespace, key, fallback: null });
        if (!(result.ok && result.value)) return null;
        const clamped = clamp ? clamp(result.value) : result.value;
        apply(clamped);
        // Возвращается ТАКЖЕ зажатое: вызывающий может использовать возврат
        // напрямую (лог, сравнение), и сырое значение с диска там не годится.
        return clamped;
    }

    async function save(current, apply) {
        const clamped = clamp ? clamp(current) : current;
        if (apply) apply(clamped);
        await call('storage.settings.set', { namespace, key, value: clamped });
        return true;
    }

    return { restore, save };
}

/**
 * Персистентная память ЧАТА — данные, которые живут в `storage.chatMemory`
 * и обязаны переживать переключение чата.
 *
 * Закрывает ДВА повторяющихся класса багов (см. tests/summary-core.test.js
 * и references/persistence-bugs.md скилла проекта):
 *
 *  1. **Debounce loss.** `storage.chatMemory.set` уходит в ST-дебаунс
 *     (~1000ms) — запись без последующего flush теряется при перезагрузке
 *     страницы в течение этой секунды. Поэтому каждый `persist()` здесь
 *     заканчивается `storage.chatMemory.flush` через ту же очередь записи
 *     Ядра памяти (ordering с параллельными записями сохранён). NoteBook
 *     до выноса этой Библиотеки flush'а НЕ делал — живой баг класса 1.
 *  2. **Stale-empty write-back.** `load()` движка часто выполняется ДО
 *     того, как ST подгрузил `chatMetadata` текущего чата — в памяти
 *     пусто, и следующая запись затирает good-диск устаревшим пустым.
 *     Лечение — подписка на `st.chatChanged` с перечитыванием; здесь она
 *     встроена в `load()`: хелпер сам подписывается при создании и
 *     возвращает отписку в `stop()`.
 *
 * Возвращаемое значение из `chatChanged`-колбэка Модуля (если он его дал)
 * подставляется в сигнал — типовой случай «перечитал и показал».
 */
export function chatCollection(host, { namespace, key, fallback = [], signal, onChange } = {}) {
    const { call } = createModuleHost(host);

    async function load() {
        const result = await call('storage.chatMemory.get', { namespace, key, fallback });
        const value = result.ok ? result.value ?? fallback : fallback;
        if (signal) signal.set(value);
        if (onChange) await onChange(value);
        return value;
    }

    async function persist(next) {
        if (signal) signal.set(next);
        await call('storage.chatMemory.set', { namespace, key, value: next });
        await call('storage.chatMemory.flush', {});
        return next;
    }

    const unsubscribe = host.events.subscribe('st.chatChanged', () => { void load(); });

    return {
        load,
        persist,
        stop: unsubscribe,
    };
}

/**
 * Этап пайплайна Модуля: регистрация контракта на `host.own` + добавление
 * этапа в пайплайн одной парой вызовов, со снятием обоих в `stop()`.
 *
 * Почему парой: контракт и этап — два обязательных куска одного замысла
 * (этап исполняется под ПРАВАМИ Модуля, см. doc-comment NoteBook про
 * `community.notebook.inject`), и рассинхрон при частичном снятии —
 * реальный класс ошибки: этап остался, контракта нет → `onExhausted`.
 */
export function pipelineStage(host, { pipelineId, stageId, contract, params, onExhausted, execute }) {
    const { call } = createModuleHost(host);

    if (typeof execute !== 'function') {
        throw new Error(`pipelineStage "${stageId}": "execute" handler is required — the stage runs under the module's own rights, someone must do the work.`);
    }

    async function add(stageParams) {
        // Контракт регистрируется на `host.own`: исполнять его обязан именно
        // этот Модуль, под своими правами — чужой вызов контракта напрямую
        // остаётся возможен, но этап пайплайна добирается до него только
        // через зарегистрированную здесь пару контракт+этап.
        const unregisterContract = host.own.register(contract, p => execute(p));
        await call('pipeline.stages.add', {
            pipelineId,
            stage: { id: stageId, contract, params: stageParams ?? params, onExhausted },
        });
        return unregisterContract;
    }

    async function remove() {
        await call('pipeline.stages.remove', { pipelineId, stageId });
    }

    return { add, remove };
}

/**
 * Инструмент ST: регистрация схемы с `action`/`formatMessage`, добавленными
 * Модулем, и снятие в `stop()`.
 *
 * Договорённость об ошибках — на стороне Модуля (см. doc-comment NoteBook:
 * модель обязана УВИДЕТЬ, что пошло не так, текстом, а не обрывать
 * генерацию), но типовой случай «обернуть и вернуть текстом» настолько
 * частый, что хелпер даёт его сразу: `onError: 'returnText'` оборачивает
 * `action`, любой брошенный `Error` становится возвращаемой строкой.
 */
export function stTool(host, { schema, action, formatMessage, onError } = {}) {
    const { call } = createModuleHost(host);
    const name = schema?.name;

    if (!name || typeof action !== 'function') {
        throw new Error('stTool: both "schema" (with a name) and "action" are required.');
    }

    const wrapped = onError === 'returnText'
        ? async args => {
            try {
                return await action(args);
            } catch (error) {
                return error?.message ?? String(error);
            }
        }
        : action;

    async function register() {
        await call('generation.registerTool', { definition: { ...schema, action: wrapped, ...(formatMessage ? { formatMessage } : {}) } });
    }

    async function unregister() {
        await call('generation.unregisterTool', { name });
    }

    return { register, unregister };
}
