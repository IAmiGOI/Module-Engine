import { request } from '../../libraries/shared/request.js';
import { computeInsertIndex } from '../../libraries/shared/chat-injection.js';
import { findMostRecentLocationMention } from '../../libraries/core/location-mention.js';

const BEFORE_SEND_PIPELINE = 'generation.beforeSend';
const STAGE_ID = 'mapNarration:inject';
const INJECT_CONTRACT = 'core.mapNarration.inject';
/** How far back to look for a location mention — owner: "Если в ближайших 4 сообщений упоминаются локации". */
const SCAN_MESSAGE_COUNT = 4;
/** `@4` — owner's own depth choice, same `chat.length - depth` convention as Notebook/Secrets/Summary (`computeInsertIndex`). */
const INJECTION_DEPTH = 4;

/**
 * Ядро «Навигация по упоминаниям» (CORES.md, ROADMAP.md) — отдельное от
 * [Ядра карты](../map/index.js) по прямой просьбе владельца ("добавь
 * отдельное ядро парсинга сообщений"): парсинг прозы чата — самостоятельная
 * забота (та же, что уже разделяет детекцию говорящего и хранение состава
 * в разных Ядрах), а не то, что Ядро карты должно знать о существовании.
 *
 * **Что делает**: на каждом `generation.beforeSend` смотрит на последние
 * `SCAN_MESSAGE_COUNT` (4) сообщения чата (`chatHistory.messages`), ищет
 * САМОЕ СВЕЖЕЕ упоминание любой ИЗВЕСТНОЙ локации карты (closed-set-подход
 * `findMostRecentLocationMention()` — то же самое "сопоставляй с известным,
 * не угадывай", что уже `findKnownMention()` у детекции говорящего,
 * см. [[feedback-speaker-detection-testing]]). Если такая локация нашлась,
 * найдена от ТЕКУЩЕЙ позиции (`map.position.get`) и маршрут до неё реально
 * существует (`map.pathfind`) — вставляет в `chat` (та же живая мутация,
 * что уже делают Notebook/Secrets/Summary) короткое системное сообщение с
 * маршрутом, на глубине `@4` (`computeInsertIndex`, та же библиотека, что
 * и у них — 4-й реальный потребитель, вынесена в Библиотеку именно на этом
 * шаге).
 *
 * **Ничего не инжектит, если**: позиция не установлена (`map.position.get`
 * вернул `null` — нет отправной точки), в последних 4 сообщениях не
 * упомянута НИ ОДНА известная локация, упомянутая локация — та же, что и
 * текущая позиция (уже там, маршрут был бы тривиален и бесполезен), или
 * между позицией и упомянутой локацией реально нет пути
 * (`map.pathfind`'s `routes: []`) — молчание лучше, чем шум/выдумка.
 *
 * **Формулировка сообщения — явно "данные мира", не факт, который знают
 * персонажи** (владелец: "уточни, что это реальные данные мира и персонажи
 * могут не знать"): персонаж мог никогда не бывать этим маршрутом и не
 * обязан ориентироваться в геометрии карты так же точно, как сам движок.
 */
export function createMapNarrationCore(host) {
    async function call(contract, params) {
        return request(host.own, contract, { params });
    }

    function formatRouteMessage(route, nodesById) {
        const names = route.nodeIds.map(id => nodesById[id]?.name ?? id).join(' → ');
        const distance = Math.round(route.totalDistanceUnits);
        const time = route.totalTimeMinutes != null ? `${Math.round(route.totalTimeMinutes)} min` : 'time n/a';
        return `[World data, not necessarily known to any character: route ${names} — ${distance} m, ${time}]`;
    }

    async function injectRoute({ chat } = {}) {
        if (!Array.isArray(chat)) return true;

        const positionResult = await call('map.position.get', {});
        const position = positionResult.ok ? positionResult.value : null;
        if (!position?.nodeId) return true; // no tracked position — nothing to route FROM

        const messagesResult = await call('chatHistory.messages', { limit: SCAN_MESSAGE_COUNT });
        const messages = messagesResult.ok ? messagesResult.value ?? [] : [];
        if (!messages.length) return true;

        const nodesResult = await call('map.nodes.list', {});
        const nodes = nodesResult.ok ? nodesResult.value ?? [] : [];
        if (!nodes.length) return true;

        const mentionedId = findMostRecentLocationMention(messages, nodes);
        if (!mentionedId || mentionedId === position.nodeId) return true;

        const routeResult = await call('map.pathfind', { fromId: position.nodeId, toId: mentionedId, maxRoutes: 1 });
        if (!routeResult.ok || !routeResult.value.routes.length) return true;

        const nodesById = Object.fromEntries(nodes.map(node => [node.id, node]));
        const message = formatRouteMessage(routeResult.value.routes[0], nodesById);
        chat.splice(computeInsertIndex(chat.length, INJECTION_DEPTH), 0, { is_user: false, is_system: true, name: 'World Map', mes: message });
        return true;
    }

    async function load() {
        await call('pipeline.stages.add', {
            pipelineId: BEFORE_SEND_PIPELINE,
            stage: { id: STAGE_ID, contract: INJECT_CONTRACT, params: { chat: { $from: '$input.chat' } }, onExhausted: 'flag' },
        });
    }

    const unregisters = [
        host.own.register(INJECT_CONTRACT, params => injectRoute(params)),
    ];

    return {
        load,
        // Тестам: прямой доступ к чистой функции инъекции, без сборки
        // настоящего пайплайна — тот же приём, что и у остальных Ядер
        // (`checkAndFold` у Ядра саммари).
        injectRoute,
        unregister: async () => {
            await call('pipeline.stages.remove', { pipelineId: BEFORE_SEND_PIPELINE, stageId: STAGE_ID }).catch(() => {});
            for (const unregister of unregisters) unregister();
        },
    };
}
