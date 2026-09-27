/**
 * Адреса блоков интерфейса — для ссылок гида (`[Label](stme:<адрес>)`, cores/guide). Адрес — атрибут `data-stme-anchor` у каждой
 * карточки и секции (`collapsible` в widgets.js): ключ сворачивания (`card:models`, `worker:…`) или, без ключа, заголовок (`t:tracker`) —
 * так адреса есть и у блоков внутри Модулей, без правок в самих Модулях. Каталог собирается из живого DOM, поэтому новый Модуль или
 * карточка сразу доступны гиду.
 *
 * Контракты: `ui.anchors.list` → `[{ anchor, path }]` (путь — «Panel › Modules › Tracker»), `ui.reveal({ anchor })` → открыть нужный экран,
 * раскрыть блок и его родителей, прокрутить к нему и подсветить на несколько секунд. `ui.hide({ anchor })` → свернуть блок обратно (родителей не трогает — human
 * может держать открытой саму панель). `false` — такого адреса нет.
 *
 * `ui.context` → `{ blocks, text }` — что раскрыто СЕЙЧАС (поля, значения, подсказки, кнопки; секреты не отдаются) — см. libraries/core/ui-context.js.
 *
 * `roots` — экраны с деревьями: `[{ root: () => Element, open: () => void, label }]`; `hubs` — обзоры блоков над формами (им надо открыть
 * карточку, прежде чем она станет видимой).
 */
import { snapshotOpenBlocks, formatOpenBlocks } from '../../libraries/core/ui-context.js';

const MAX_ANCHORS = 200;
const SPOTLIGHT_MS = 4000;

function titleOf(details) {
    return details.querySelector(':scope > summary .stme-card-title strong')?.textContent.trim() ?? '';
}

export function createAnchorNavigator(host, { document: doc = globalThis.document, roots = [], hubs = [], setTimer = (fn, ms) => setTimeout(fn, ms) } = {}) {
    function pathOf(element, label) {
        const titles = [];
        for (let node = element; node; node = node.parentElement?.closest('[data-stme-anchor]')) titles.unshift(titleOf(node) || node.dataset.stmeAnchor);
        return [label, ...titles].filter(Boolean).join(' › ');
    }

    function list() {
        const seen = new Set();
        const out = [];
        for (const { root, label } of roots) {
            for (const element of root()?.querySelectorAll?.('[data-stme-anchor]') ?? []) {
                const anchor = element.dataset.stmeAnchor;
                if (!anchor || seen.has(anchor) || out.length >= MAX_ANCHORS) continue;
                seen.add(anchor);
                out.push({ anchor, path: pathOf(element, label) });
            }
        }
        return out;
    }

    function find(anchor) {
        for (const entry of roots) {
            const element = [...(entry.root()?.querySelectorAll?.('[data-stme-anchor]') ?? [])].find(node => node.dataset.stmeAnchor === anchor);
            if (element) return { entry, element };
        }
        return null;
    }

    /** Свернуть блок обратно — пара к `reveal()`: закрывает ТОЛЬКО сам блок (не экран и не родителей — их мог раскрыть человек, не гид). `false` — такого адреса нет или блок не сворачивается. */
    function hide({ anchor } = {}) {
        const found = find(String(anchor ?? ''));
        if (!found) return false;
        found.element.classList.remove('stme-spotlight-target');
        if (found.element.tagName !== 'DETAILS') return false;
        found.element.open = false;
        return true;
    }

    function reveal({ anchor } = {}) {
        const found = find(String(anchor ?? ''));
        if (!found) return false;
        found.entry.open();
        // Форма верхней карточки живёт в обзоре блоков — открываем её там, иначе блок в DOM, но не виден.
        let top = found.element;
        for (let node = top; node; node = node.parentElement?.closest('[data-stme-anchor]')) top = node;
        const topTitle = titleOf(top);
        for (const hub of hubs) if (topTitle && hub.groupHas?.(topTitle)) hub.openCard(topTitle);
        let tries = 0;
        const attempt = () => {
            const again = find(String(anchor))?.element;
            if ((!again || !again.getClientRects?.().length) && (tries += 1) < 20) { setTimer(attempt, 50); return; }
            const target = again ?? found.element;
            for (let node = target; node; node = node.parentElement?.closest('details')) if (node.tagName === 'DETAILS') node.open = true;
            target.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
            target.classList.add('stme-spotlight-target');
            setTimer(() => target.classList.remove('stme-spotlight-target'), SPOTLIGHT_MS);
        };
        setTimer(attempt, 0);
        return true;
    }

    /** Раскрытые блоки всех экранов: только то, что человек видит сейчас. */
    function context() {
        const blocks = roots.flatMap(({ root, label }) => { const element = root(); return element ? snapshotOpenBlocks(element, { label }) : []; });
        return { blocks: blocks.map(({ anchor, path }) => ({ anchor, path })), text: formatOpenBlocks(blocks) };
    }

    const unregisters = [
        host.own.register('ui.anchors.list', () => list()),
        host.own.register('ui.context', () => context()),
        host.own.register('ui.reveal', params => reveal(params)),
        host.own.register('ui.hide', params => hide(params)),
    ];
    void doc;
    return { list, reveal, hide, context, unregister: () => { for (const unregister of unregisters) unregister(); } };
}
