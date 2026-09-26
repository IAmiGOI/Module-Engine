import { dragPlacement, toSaved } from '../../../libraries/shared/home-model.js';
import { reorderAt } from '../../../libraries/shared/home-order.js';
import { attachDrag } from './drag.js';
import { attachReorder } from './reorder.js';

const EDGE_ZONE = 64;       // у верхнего/нижнего края окна поднятый блок прокручивает стол
const EDGE_STEP = 12;

/**
 * Как блоки стола двигаются. На сцене (широкий экран) — свободное перетаскивание мышью с сохранением положения в долях. В потоке (телефон/узкое окно) —
 * перестановка: блок поднимается (касание — долгим нажатием), едет за пальцем, у края окна стол сам прокручивается; по отпусканию он встаёт на место среди
 * соседей, а новый порядок сохраняется (`onReorder`). Положение блока всегда считается по координатам содержимого стола (окно + прокрутка).
 */
export function createBlockInteraction({ win, blocks, getScene, isFlow, getPlacements, onMoved, onReorder }) {
    const redraw = () => getScene().draw([...blocks.values()].map(item => item.placement));

    function bindStage(id, entry) {
        entry.detach = attachDrag(entry.dom.el, {
            win,
            onStart: () => { entry.base = { ...entry.placement }; entry.dom.setDragging(true); },
            onMove: delta => {
                const stage = getScene().size();
                const others = [...blocks.entries()].filter(([otherId]) => otherId !== id).map(([, item]) => item.placement);
                entry.placement = dragPlacement(entry.base, delta, stage, { others, last: entry.placement });
                entry.dom.place(entry.placement.x, entry.placement.y);
                void redraw();
            },
            onEnd: () => { entry.dom.setDragging(false); onMoved(id, toSaved(entry.placement, getScene().size())); },
        });
    }

    function bindFlow(id, entry) {
        let grab = null;
        let point = null;
        let ticker = null;
        const content = () => {
            const root = getScene().root;
            const rect = root.getBoundingClientRect();
            return { x: point.clientX - rect.left + root.scrollLeft, y: point.clientY - rect.top + root.scrollTop, rect };
        };
        const follow = () => {
            const { x, y } = content();
            entry.placement = { ...entry.placement, x: x - grab.x, y: y - grab.y };
            entry.dom.place(entry.placement.x, entry.placement.y);
            void redraw();
        };
        const edgeScroll = () => {
            const { rect } = content();
            const root = getScene().root;
            const before = root.scrollTop;
            if (point.clientY < rect.top + EDGE_ZONE) root.scrollTop -= EDGE_STEP;
            else if (point.clientY > rect.bottom - EDGE_ZONE) root.scrollTop += EDGE_STEP;
            if (root.scrollTop !== before) follow();
        };
        entry.detach = attachReorder(entry.dom.el, {
            win,
            onStart: start => {
                point = start;
                const { x, y } = content();
                grab = { x: x - entry.placement.x, y: y - entry.placement.y };
                entry.dom.setDragging(true);
                ticker = win.setInterval(edgeScroll, 16);
            },
            onMove: next => { point = next; follow(); },
            onEnd: end => {
                point = end;
                win.clearInterval(ticker);
                entry.dom.setDragging(false);
                const { x, y } = content();
                onReorder(reorderAt(getPlacements(), id, { x, y }));
            },
        });
    }

    return { bind: (id, entry) => (isFlow() ? bindFlow(id, entry) : bindStage(id, entry)) };
}
