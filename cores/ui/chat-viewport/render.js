import { computeVisibleRange } from '../../../libraries/shared/chat-viewport-math.js';
import { GLYPH_GAP, QUICK_SCROLL_MS } from './constants.js';

/**
 * Проход рендера: читает актуальный чат (`ensureSnapshot`), решает окно видимости, раскладывает строки окна
 * (`layoutRow`), отпускает то, что вышло из окна, и коммитит кадр (`commitFrame`). Безопасно звать сколько угодно
 * раз подряд — повторный вызов, пока предыдущий ещё не закончился, ставится в очередь РОВНО ОДИН РАЗ (`renderQueued`).
 */
export function installRender(ctx) {
    const { s, heights, rowStates, rowHeight, overscan, prerenderFactor, textureBudgetBytes, publishEvent } = ctx;

    /** Состояние одного кадра: неизменяемое (снимок, окно) + накопители, которые заполняет `layoutRow`. */
    function startFrame(snapshot) {
        const { order, byMesid, glyphHeaderByMesid, glyphFinalByHeader, glyphMembersByHeader, indexByMesid } = snapshot;
        // scrollTop фиксируется на весь проход: setViewport() может поменять его посреди await-ов, и строки одного кадра разъехались бы.
        const frameScrollTop = s.scrollTop;
        // Окно предрендера вдвое выше видимого (по половине высоты экрана сверху и снизу): быстрый скролл иначе показывает строки,
        // которые ещё не успели растеризоваться. Пока пользователь скроллит, считаем ТОЛЬКО видимые строки (быстрый кадр);
        // полное окно предрендера — отдельным проходом, когда скролл притих.
        const visibleOnly = prerenderFactor > 1 && (performance.now() - s.lastScrollAt) < QUICK_SCROLL_MS;
        const retainRange = computeVisibleRange({
            order, heights, scrollTop: Math.max(0, frameScrollTop - s.viewportHeight * (prerenderFactor - 1) / 2), viewportHeight: s.viewportHeight * prerenderFactor,
            estimatedHeight: rowHeight, overscan,
        });
        const range = visibleOnly
            ? computeVisibleRange({ order, heights, scrollTop: frameScrollTop, viewportHeight: s.viewportHeight, estimatedHeight: rowHeight, overscan: 1 })
            : retainRange;
        const needed = new Set(order.slice(range.startIndex, range.endIndex));
        const retained = visibleOnly ? new Set(order.slice(retainRange.startIndex, retainRange.endIndex)) : needed;

        // Сколько высоты глифа уже «съели» строки выше окна (если окно начинается СЕРЕДИНОЙ глифа).
        let glyphOffset = 0;
        const first = order[range.startIndex];
        const head = glyphHeaderByMesid.get(first) ?? first;
        if (first !== undefined && head !== first) {
            const headIndex = indexByMesid.get(head) ?? -1;
            for (let i = headIndex; i >= 0 && i < range.startIndex; i++) {
                glyphOffset += (heights.get(order[i]) ?? rowHeight) - (i === headIndex && head !== order[0] ? GLYPH_GAP : 0);
            }
        }
        return {
            order, byMesid, glyphHeaderByMesid, glyphFinalByHeader, glyphMembersByHeader, indexByMesid,
            frameScrollTop, visibleOnly, range, needed, retained,
            y: range.offsetTop,
            // Якорь прокрутки: строка, в которой стоит `frameScrollTop`. Высоты строк ВЫШЕ неё в окне только что могли уточниться (оценка →
            // измеренная), тогда сама строка уезжает на разницу, а нативный `scrollTop` остаётся прежним — чат «подпрыгивал» после остановки.
            // Считаем сдвиг якоря между старой и новой раскладкой и в конце прогона компенсируем им прокрутку.
            oldCum: range.offsetTop, anchorFound: false, anchorDelta: 0,
            glyphOffset, heightsChanged: false, lastPlacement: null,
            quads: [], positions: [],
            glyphSpans: [],     // [{headerMesid, top, height}] — фон каждого глифа, В ПОРЯДКЕ появления
            skeletonSpecs: [],  // строки, что ещё грузятся: [{ top, height }]
            neededGlyphs: new Set(),
        };
    }

    async function render({ fresh = true } = {}) {
        if (!s.attached || !s.enabled) return false;
        if (s.rendering) { s.renderQueued = true; if (fresh) s.pendingFresh = true; return false; }
        s.rendering = true;
        publishEvent('ui.chatViewport.render.started', {});
        try {
            // Снимок чата пересобирается только по событиям изменения чата; обычный скролл использует прошлый —
            // иначе каждый кадр скролла заново мапил бы ВСЕ тысячи сообщений (на слабом ноутбуке это и был тормоз).
            const snapshot = await ctx.ensureSnapshot(fresh);
            const f = startFrame(snapshot);
            const { order, byMesid, glyphHeaderByMesid, indexByMesid, frameScrollTop, visibleOnly, needed, retained } = f;

            for (const mesid of s.lastNeeded) {
                if (retained.has(mesid)) continue;
                if (textureBudgetBytes == null) await ctx.forgetMesid(mesid);
                else await ctx.forgetRowChrome(mesid);
            }

            // Растеризация тел строк окна запускается ПАРАЛЛЕЛЬНО заранее, а цикл ниже подхватывает уже идущую работу или кэш.
            ctx.prelaunchBodies(f);

            // Первый проход — только асинхронная работа (измерения/растеризация/монтирование хрома), БЕЗ единой видимой правки DOM
            // или канваса: позиции копятся в `f.positions`. Второй проход (`commitFrame`) применяет ВСЕ позиции хрома и вызывает
            // `drawFrame()` синхронно, одним куском — без `await` между ними браузер не может вклиниться со своим кадром
            // (иначе «иконки и текст едут на разных уровнях» при скролле).
            for (let idx = f.range.startIndex; idx < f.range.endIndex; idx++) {
                if (!visibleOnly && s.scrollTop !== frameScrollTop) return false; // пришёл новый скролл — этот кадр устарел, следующий уже в очереди
                await ctx.layoutRow(f, idx);
            }

            await ctx.applySkeletons(f.skeletonSpecs);
            // Строки, что держим смонтированными, но в этом быстром кадре не считали, прячем за экран — иначе они висели бы на старых позициях.
            if (visibleOnly) for (const mesid of retained) if (!needed.has(mesid) && rowStates.has(mesid)) f.positions.push({ mesid, y: -1e6, width: s.viewportWidth });
            s.lastNeeded = retained;
            s.lastFrame = { order, byMesid, glyphHeaderByMesid, indexByMesid, needed, frameScrollTop };
            await ctx.enforceBudget(retained);
            if (visibleOnly) {
                clearTimeout(s.fullPassTimer);
                s.fullPassTimer = setTimeout(() => { ctx.render({ fresh: false }); }, QUICK_SCROLL_MS + 10);
            }

            await ctx.syncGlyphBackgrounds(f);
            await ctx.commitFrame(f);
            return true;
        } catch (error) {
            console.error('[chatViewport] render failed:', error);
            publishEvent('ui.chatViewport.render.failed', { message: error.message });
            throw error;
        } finally {
            s.rendering = false;
            if (s.renderQueued) { s.renderQueued = false; const fresh = s.pendingFresh; s.pendingFresh = false; ctx.render({ fresh }); }
        }
    }

    Object.assign(ctx, { render });
}
