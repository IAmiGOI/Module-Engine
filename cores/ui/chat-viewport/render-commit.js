import { h } from '../tree.js';

/** Коммит кадра. */
export function installRenderCommit(ctx) {
    const { s, heights, rowStates, rowPositionApplied, rowHeight, publishEvent, serviceOrNull } = ctx;

    /** Итог кадра: устаканивание общей высоты, синхронный коммит позиций хрома и канваса, событие `render.completed`. */
    async function commitFrame(f) {
        const { order, positions, quads, frameScrollTop, visibleOnly } = f;
        // `range.totalHeight` — сумма высот ВСЕХ сообщений (не только
        // видимых), уже посчитана `computeVisibleRange()` для внутренних
        // нужд (см. chat-viewport-math.js) — переиспользуется здесь как
        // публичная величина: реальному DOM-скроллу (обёртке в UI движка,
        // не канвасу — у канваса своего скролла нет) нужен "distance",
        // подо что подставить родной скроллбар браузера.
        // Сумма по ОБНОВЛЁННЫМ высотам, а не `range.totalHeight` (посчитан по
        // высотам ДО этого прохода — после раскрытия ризонинга общая высота
        // и окно виртуализации были бы устаревшими на один рендер, скролл
        // "уезжал"). Если высоты поменялись — добиваем ещё проход(ы), пока
        // окно не устаканится (не больше 3 подряд).
        let settledTotal = 0;
        for (const m of order) settledTotal += heights.get(m) ?? rowHeight;
        s.lastTotalHeight = settledTotal;
        if (f.heightsChanged && s.settlePasses < 3) { s.settlePasses += 1; s.renderQueued = true; } else if (!f.heightsChanged) s.settlePasses = 0;

        // Второй проход — синхронный, без единого `await` внутри: хром и
        // канвас коммитятся в одном и том же тике браузера.
        s.renderedScrollTop = frameScrollTop;
        s.lastGlyphSpans = f.glyphSpans;
        if (Math.abs(f.anchorDelta) >= 1 && !globalThis.__stmeNoAnchorFix) publishEvent('ui.chatViewport.scrollRequest', { by: f.anchorDelta });   // флаг — только для сравнения «до/после» в диагностике
        for (const p of positions) {
            const key = `${p.y}|${p.width}`;
            if (rowPositionApplied.get(p.mesid) === key) continue; // позиция не изменилась — DOM строки не трогаем
            rowPositionApplied.set(p.mesid, key);
            rowStates.get(p.mesid)?.position.set({ y: p.y, width: p.width });
        }
        // Кадр без изменений (те же квады, ни одной новой текстуры) не перерисовываем — иначе любая правка внутри
        // сообщения заставляла перерисовывать весь канвас.
        const quadsKey = JSON.stringify(quads);
        if (s.dirtyMain || quadsKey !== s.lastQuadsKey) {
            await serviceOrNull('webglChat.drawFrame', { canvas: s.canvas, quads });
            s.lastQuadsKey = quadsKey;
            s.dirtyMain = false;
        }
        if (s.lastCanvas) await ctx.drawLastCanvas(f.lastPlacement);
        if (globalThis.__stmeBusStats) globalThis.__stmeFrame = { anchor: frameScrollTop, pad: ctx.canvasPad(), dpr: s.devicePixelRatio, quads: quads.map(q => ({ id: q.textureId, y: q.y / s.devicePixelRatio - ctx.canvasPad(), h: q.height / s.devicePixelRatio })), positions: positions.map(p => ({ id: p.mesid, y: p.y })), visibleOnly, at: performance.now() };
        if (globalThis.__stmeBusStats) globalThis.__stmeRendered = { scrollTop: s.renderedScrollTop, at: performance.now() };   // диагностика задержки: до какого scrollTop дорисован кадр
        publishEvent('ui.chatViewport.render.completed', { visible: quads.length, total: order.length, totalHeight: s.lastTotalHeight, userToggle: s.toggleRender, renderedScrollTop: s.renderedScrollTop });
        if (!s.renderQueued) s.toggleRender = false;
        ctx.followFrame();
        ctx.schedulePrefetch();
    }

    Object.assign(ctx, { commitFrame });
}
