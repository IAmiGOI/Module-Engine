
/** Фоны глифов (отдельный `<div>` под канвасом на каждый глиф). */
export function installGlyphBg(ctx) {
    const { s, glyphBgApplied, glyphBgRoots, serviceOrThrow, serviceOrNull } = ctx;

    /**
     * Фон одного глифа (owner: "Глифы должны иметь отдельный бэкграунд, в
     * стиле всего движка") — обычный статичный `<div>`, не через `h()`/
     * реактивность: ему нечего диффить, только позиция/высота меняются
     * каждый `render()`, а это дешевле выставить напрямую через `dom.setProp`
     * (тот же приём, что канвас/хром-контейнер уже используют для СВОИХ
     * позиций в `cores/ui/engine-panel.js`).
     *
     * Добавляется в `canvas.parentElement` (тот же `stickyLayer`, что несёт
     * канвас и хром), а не в `chromeContainer` — фон обязан быть ПОД
     * WebGL-текстом, иначе непрозрачный фон перекрыл бы тело сообщения,
     * нарисованное на канвасе. `z-index: -1` — фон соседствует с канвасом/
     * хромом в ОДНОМ общем родителе без явного `z-index` у них (оба —
     * `auto`, эффективно `0`), поэтому `-1` гарантированно кладёт фон НИЖЕ
     * обоих независимо от порядка добавления в DOM — не нужен свой
     * `dom.insertBefore` (которого у Сервиса и нет).
     */
    async function ensureGlyphBg(headerMesid) {
        let bg = glyphBgRoots.get(headerMesid);
        if (!bg) {
            const parent = s.canvas ? await serviceOrNull('dom.parentElement', { el: s.canvas }) : null;
            if (!parent) return null;
            bg = await serviceOrThrow('dom.createElement', { tag: 'div' });
            await serviceOrThrow('dom.setProp', { el: bg, key: 'class', value: 'stme-chat-viewport-glyph-bg' });
            await serviceOrThrow('dom.setProp', { el: bg, key: 'style', value: { position: 'absolute', left: '0px', top: '0px', zIndex: -1 } });
            await serviceOrThrow('dom.append', { parent, child: bg });
            glyphBgRoots.set(headerMesid, bg);
        }
        return bg;
    }

    async function forgetGlyphBg(headerMesid) {
        const bg = glyphBgRoots.get(headerMesid);
        if (bg) {
            await serviceOrNull('dom.remove', { node: bg });
            glyphBgRoots.delete(headerMesid);
            glyphBgApplied.delete(headerMesid);
        }
    }

    /** Расставляет фоны глифов кадра: лишние убирает, остальным пишет позицию/размер (только если изменились). */
    async function syncGlyphBackgrounds(f) {
        const { neededGlyphs, glyphSpans } = f;
        for (const headerMesid of s.lastNeededGlyphs) if (!neededGlyphs.has(headerMesid)) await ctx.forgetGlyphBg(headerMesid);
        s.lastNeededGlyphs = neededGlyphs;
        for (const span of glyphSpans) {
            const bg = await ctx.ensureGlyphBg(span.headerMesid);
            if (bg) {
                // Тот же стиль — не трогаем DOM: даже запись одинаковых значений заставляла браузер перерисовывать фон глифа (таймер, стрим, светофор).
                const bgKey = `${span.top}|${s.viewportWidth}|${span.height}`;
                if (glyphBgApplied.get(span.headerMesid) !== bgKey) {
                    await serviceOrNull('dom.setProp', { el: bg, key: 'style', value: { transform: `translateY(${span.top}px)`, width: `${s.viewportWidth}px`, height: `${span.height}px` } });
                    glyphBgApplied.set(span.headerMesid, bgKey);
                }
            }
        }
    }

    /** Плита глифа под панелью действий: срастается с ней (класс убирает правый контур и скругления). Нет плиты — нечего менять. */
    function setGlyphJoined(headerMesid, joined) {
        const bg = glyphBgRoots.get(headerMesid);
        if (!bg) return;
        serviceOrNull('dom.setProp', { el: bg, key: 'class', value: joined ? 'stme-chat-viewport-glyph-bg stme-glyph-joined' : 'stme-chat-viewport-glyph-bg' });
    }

    Object.assign(ctx, { setGlyphJoined, ensureGlyphBg, forgetGlyphBg, syncGlyphBackgrounds });
}
