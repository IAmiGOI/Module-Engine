import { computeVisibleRange } from '../../../libraries/shared/chat-viewport-math.js';
import { GLYPH_GAP, PREFETCH_HORIZON_MS, hashString, PRELAUNCH_CONCURRENCY, ROW_PAD, AVATAR_WRAP } from './constants.js';

/** Фоновая подготовка тел: прогрев кэша, предзагрузка по ходу прокрутки, параллельный прелаунч окна. */
export function installPrefetch(ctx) {
    const { s, heights, rasterizedText, bodyUse, lastChromeHeight, rowHeight, overscan, textureBudgetBytes, prefetchScreens, prefetchConcurrency, persistentCache, chromeMounts, serviceOrNull } = ctx;
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    /** Оценка заглушки под аватарку для строки, которой ещё не было на экране. */
    function guessRemainder(frame, idx) {
        const { order, byMesid, glyphHeaderByMesid } = frame;
        const mesid = order[idx];
        const message = byMesid.get(mesid);
        if (!chromeMounts || message.isToolCall) return 0;
        const head = glyphHeaderByMesid.get(mesid) ?? mesid;
        let offset = 0;
        for (let i = frame.indexByMesid.get(head) ?? -1; i >= 0 && i < idx; i++) {
            offset += (heights.get(order[i]) ?? rowHeight) - (order[i] === head && head !== order[0] ? GLYPH_GAP : 0);
        }
        let chrome = lastChromeHeight.get(mesid);
        if (chrome === undefined) {
            if (mesid === head) {
                const next = byMesid.get(order[idx + 1]);
                const cot = m => !!(m && (m.isToolCall || m.reasoningText));
                const nextTight = next && glyphHeaderByMesid.get(order[idx + 1]) === head && cot(next);
                chrome = ROW_PAD + ((cot(message) || nextTight) ? 0 : ROW_PAD) + 43 + (message.reasoningText ? 29 : 0);
            } else chrome = 15;
        }
        return Math.max(0, AVATAR_WRAP - (offset + chrome));
    }

    function schedulePrefetch() {
        if (!(prefetchScreens > 0) || !s.lastFrame || s.prefetchRunning) return;
        s.prefetchRunning = true;
        setTimeout(() => { ctx.pumpPrefetch().catch(() => {}).finally(() => { s.prefetchRunning = false; }); }, 20);
    }

    /**
     * Фоновый прогрев кэша ВСЕГО чата: в простое, по одной строке, от текущего места наружу (вперёд и назад по очереди).
     * Строки, которых нет на диске, растеризуются и пишутся в постоянный кэш (`rasterCache`, переживает перезагрузку), а
     * текстура тут же освобождается — GPU держит только окно у экрана. Останавливается при прокрутке/рендере и при смене чата.
     */

    async function warmChat() {
        if (!persistentCache || s.warmRunning) return;
        s.warmRunning = true;
        const gen = s.prefetchGen;
        try {
            const frame = s.lastFrame;
            if (!frame) return;
            const { order, byMesid, needed } = frame;
            const center = Math.max(0, order.findIndex(m => needed.has(m)));
            for (let d = 1; d < order.length; d += 1) {
                for (const i of [center + d, center - d]) {
                    if (i < 0 || i >= order.length) continue;
                    while (s.rendering || (performance.now() - s.lastScrollAt) < 600) {
                        await sleep(250);
                        if (gen !== s.prefetchGen || !s.attached || !s.enabled) return;
                    }
                    if (gen !== s.prefetchGen || !s.attached || !s.enabled) return;
                    const message = byMesid.get(order[i]);
                    if (!message || message.isToolCall || s.lastNeeded?.has(message.mesid)) continue;
                    const remainder = ctx.guessRemainder(frame, i);
                    const html = ctx.avatarSpacerHtml(remainder) + await ctx.paintedBodyHtml(message);
                    if (s.cssHashCache.css !== s.css) s.cssHashCache = { css: s.css, hash: hashString(s.css) };
                    const diskKey = `${hashString(html)}.${html.length}.${s.cssHashCache.hash}.${ctx.contentWidth()}.${s.devicePixelRatio}`;
                    if (await serviceOrNull('rasterCache.has', { key: diskKey })) continue;
                    await ctx.syncMesid(message, remainder);
                    if (!s.lastNeeded?.has(message.mesid)) await ctx.forgetBody(message.mesid);
                    await sleep(120);
                }
            }
        } catch { /* прогрев — best effort */ } finally { s.warmRunning = false; }
    }

    /**
     * Фоновая растеризация тел вокруг окна. Окно смещено ВПЕРЁД по ходу прокрутки: чем быстрее листаем, тем дальше
     * вперёд (скорость × PREFETCH_HORIZON_MS), назад — только полэкрана. Ближайшие по ходу движения строки первыми,
     * `prefetchConcurrency` параллельно. Цикл один и не сбрасывается новым кадром — каждый проход берёт свежий
     * `lastFrame`, поэтому предзагрузка идёт и во время прокрутки, а не только после остановки.
     */
    async function pumpPrefetch() {
        for (let pass = 0; pass < 600; pass += 1) {
            const frame = s.lastFrame;
            if (!frame || !s.attached || !s.enabled) return;
            if (s.rendering) { await sleep(16); continue; }
            if (textureBudgetBytes != null && ctx.textureBytes() > textureBudgetBytes * 0.9) return;
            const { order, byMesid, needed, frameScrollTop } = frame;
            const velocity = (performance.now() - s.lastVelAt) < 300 ? s.scrollVelocity : 0;
            const moving = Math.abs(velocity) > 0.05;
            const base = s.viewportHeight * prefetchScreens;
            const ahead = moving ? Math.min(s.viewportHeight * 30, base + Math.abs(velocity) * PREFETCH_HORIZON_MS) : base;
            const behind = moving ? s.viewportHeight * 0.5 : base;
            const down = velocity >= 0;
            const above = down ? behind : ahead;
            const below = down ? ahead : behind;
            const range = computeVisibleRange({
                order, heights, scrollTop: Math.max(0, frameScrollTop - above), viewportHeight: s.viewportHeight + above + below,
                estimatedHeight: rowHeight, overscan: 0,
            });
            const anchorFirst = order.findIndex(m => needed.has(m));
            const anchorLast = anchorFirst < 0 ? -1 : anchorFirst + needed.size - 1;
            const candidates = [];
            for (let i = range.startIndex; i < range.endIndex; i += 1) {
                const m = byMesid.get(order[i]);
                if (!m || m.isToolCall || needed.has(m.mesid)) continue;
                if (rasterizedText.get(m.mesid) === ctx.bodyKey(ctx.guessRemainder(frame, i), m.text)) continue;
                const forward = down ? i > anchorLast : i < anchorFirst;
                const distance = down ? Math.abs(i - anchorLast) : Math.abs(i - anchorFirst);
                candidates.push({ i, rank: (moving && !forward ? 100000 : 0) + distance });
            }
            if (!candidates.length) { ctx.warmChat(); return; }
            candidates.sort((x, y) => x.rank - y.rank);
            await Promise.all(candidates.slice(0, prefetchConcurrency).map(async ({ i }) => {
                const m = byMesid.get(order[i]);
                await ctx.syncMesid(m, ctx.guessRemainder(frame, i));
                bodyUse.delete(m.mesid); bodyUse.set(m.mesid, true);
            }).map(task => task.catch(() => {})));
            await sleep(0);
        }
    }

    /** Параллельный прелаунч тел окна: по оценке заглушки под аватарку, с ограничением одновременных растеризаций. */
    function prelaunchBodies(f) {
        const { order, byMesid, glyphHeaderByMesid, indexByMesid, range } = f;
        const frameLike = { order, byMesid, glyphHeaderByMesid, indexByMesid };
        let running = 0;
        const waiting = [];
        const runLimited = task => new Promise(resolve => {
            const start = () => { running += 1; task().catch(() => {}).finally(() => { running -= 1; resolve(); const next = waiting.shift(); if (next) next(); }); };
            if (running < PRELAUNCH_CONCURRENCY) start(); else waiting.push(start);
        });
        for (let idx = range.startIndex; idx < range.endIndex; idx++) {
            const message = byMesid.get(order[idx]);
            if (!message || message.isToolCall) continue;
            const remainder = ctx.guessRemainder(frameLike, idx);
            if (rasterizedText.get(message.mesid) === ctx.bodyKey(remainder, message.text)) continue;
            runLimited(() => ctx.syncMesid(message, remainder));
        }
    }

    Object.assign(ctx, { guessRemainder, schedulePrefetch, warmChat, pumpPrefetch, prelaunchBodies });
}
