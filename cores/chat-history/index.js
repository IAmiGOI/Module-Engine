import { request } from '../../libraries/shared/request.js';

const ANNOTATIONS_KEY = 'annotations';

/** Свой префикс поверх `storage.chatMemory`'s `namespace`, чтобы карта аннотаций одного вызывающего не легла в тот же слот, что и его же ПРОЧИЕ данные (RP Time, например, помимо аннотаций ещё хранит настройки Модуля отдельно). */
function annotationsNamespace(namespace) {
    return `core.chatHistory:${namespace}`;
}

/** Defensive reader — see cores/memory/index.js's own `requireLocation()` for the same discipline. */
function requireAnnotationLocation(params) {
    const namespace = String(params?.namespace ?? '').trim();
    if (!namespace) throw new Error('chatHistory: "namespace" is required.');
    const mesid = params?.mesid === undefined || params?.mesid === null ? '' : String(params.mesid);
    if (!mesid) throw new Error('chatHistory: "mesid" is required.');
    return { namespace, mesid };
}

/**
 * Ядро истории чата (CORES.md) — ОБЩАЯ инфраструктура, ни к одному Модулю не
 * привязанная: доступ к сообщениям чата С их `mesid`, и место хранить
 * произвольную информацию, привязанную к КОНКРЕТНОМУ сообщению, а не
 * абстрактно (было ровно так до этого Ядра — своя история времени у RP Time,
 * плоский "текущее значение" у Ядра трекинга, каждое хранение придумывало
 * своё). `namespace` в каждом контракте — как и у `storage.chatMemory`
 * (см. doc-comment [cores/memory/index.js](../memory/index.js)): заявляется
 * вызывающим, а не структурно проверяется — тот же компромисс, официальные
 * потребители доверенные по определению.
 *
 * **`chatHistory.messages`** — тонкий проброс `stChat.messages` (реальный
 * Сервис, см. [services/st-chat.js](../../services/st-chat.js)). Существует
 * отдельным контрактом ИМЕННО потому, что Модули не имеют права ходить в
 * Сервисы напрямую (только Ядра) — без этого Ядра ни один Модуль не мог бы
 * узнать `mesid` своих собственных сообщений вообще.
 *
 * **`chatHistory.annotate`/`chatHistory.annotations`** — привязка `{mesid:
 * значение}` к текущему чату, за кулисами через `storage.chatMemory` (уже
 * per-chat — привязка к чату достаётся бесплатно, без своего механизма).
 * `annotate` с `value: null`/`undefined` СТИРАЕТ отметку для этого
 * сообщения, а не пишет `null` буквально — симметрично с тем, как реролл
 * должен уметь откатить показание, а не оставить в истории мусор.
 *
 * **Своя очередь на запись, отдельная от очереди `storage.chatMemory`.**
 * `annotate()` сам по себе read-modify-write — читает карту аннотаций целиком,
 * мутирует один `mesid`, пишет карту назад ОДНИМ `storage.chatMemory.set`.
 * Очередь там (см. doc-comment этого Ядра) не спасает: у ДВУХ одновременных
 * ПЕРВЫХ аннотаций одного namespace `readAnnotations()` каждая получит свой
 * СВЕЖИЙ пустой fallback (разные объекты), и уже ИХ `set()`-вызовы честно
 * встанут в очередь `storage.chatMemory` — но втором из них целиком
 * перезапишет карту первого, потому что это два РАЗНЫХ JS-объекта с самого
 * начала. Гонка на уровень выше — и без своей очереди здесь она бьёт именно в
 * тот сценарий, ради которого это Ядро строится: несколько Модулей отмечают
 * одно и то же сообщение на одном и том же событии.
 */
export function createChatHistoryCore(host) {
    async function readMessages(params) {
        const result = await request(host.services, 'stChat.messages', { params });
        if (!result.ok) throw new Error(result.error.message);
        return result.value ?? [];
    }

    async function readAnnotations(namespace) {
        const result = await request(host.own, 'storage.chatMemory.get', {
            params: { namespace: annotationsNamespace(namespace), key: ANNOTATIONS_KEY, fallback: {} },
        });
        if (!result.ok) throw new Error(result.error.message);
        return result.value ?? {};
    }

    async function writeAnnotations(namespace, map) {
        const result = await request(host.own, 'storage.chatMemory.set', {
            params: { namespace: annotationsNamespace(namespace), key: ANNOTATIONS_KEY, value: map },
        });
        if (!result.ok) throw new Error(result.error.message);
    }

    // Тот же приём, что и в Ядре внутренней памяти чата: держим цепочку,
    // которая всегда разрешается, чтобы одна упавшая запись не заклинила
    // очередь для всех, кто встал после неё.
    let tail = Promise.resolve();
    function enqueue(task) {
        const run = tail.then(task, task);
        tail = run.then(() => {}, () => {});
        return run;
    }

    async function annotate(params) {
        const { namespace, mesid } = requireAnnotationLocation(params);
        const map = await readAnnotations(namespace);
        if (params?.value === undefined || params?.value === null) delete map[mesid];
        else map[mesid] = params.value;
        await writeAnnotations(namespace, map);
        return true;
    }

    async function annotations(params) {
        const namespace = String(params?.namespace ?? '').trim();
        if (!namespace) throw new Error('chatHistory: "namespace" is required.');
        return readAnnotations(namespace);
    }

    /** Стирает ВСЮ карту разом — то, чем пользуется «Reset» (у RP Time, у любого трекера): «забыть всё натрекан­ное» не обязано перечислять каждый `mesid` по одному. Через ту же очередь, что и `annotate()`, чтобы не разъехаться с записью, идущей параллельно. */
    async function clearAnnotations(params) {
        const namespace = String(params?.namespace ?? '').trim();
        if (!namespace) throw new Error('chatHistory: "namespace" is required.');
        await writeAnnotations(namespace, {});
        return true;
    }

    const unregisters = [
        host.own.register('chatHistory.messages', params => readMessages(params)),
        host.own.register('chatHistory.annotate', params => enqueue(() => annotate(params))),
        host.own.register('chatHistory.annotations', params => annotations(params)),
        host.own.register('chatHistory.clearAnnotations', params => enqueue(() => clearAnnotations(params))),
    ];

    return { unregister: () => { for (const unregister of unregisters) unregister(); } };
}
