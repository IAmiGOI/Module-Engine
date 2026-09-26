import { computeGlyphs } from '../../../libraries/shared/chat-viewport-math.js';

/** Снимок чата для рендера. */
export function installRenderSnapshot(ctx) {
    const { s, glyphHeadOf } = ctx;

    async function ensureSnapshot(fresh) {
        if (fresh || !s.snapshot) {
            const freshMessages = await ctx.readOrderedMessages();
            const freshOrder = freshMessages.map(m => m.mesid);
            const freshGlyphHeaders = new Map();
            const freshById = new Map(freshMessages.map(m => [m.mesid, m]));
            const freshGlyphMembers = new Map(); // mesid заголовка глифа -> mesid'ы всех его сообщений (для суммарного времени генерации)
            const freshGlyphFinals = new Map(); // mesid заголовка глифа -> mesid ПОСЛЕДНЕГО (финального) сообщения глифа
            for (const glyph of computeGlyphs(freshMessages)) {
                for (const id of glyph.mesids) freshGlyphHeaders.set(id, glyph.headerMesid);
                freshGlyphMembers.set(glyph.headerMesid, glyph.mesids);
                // Финальное — последнее сообщение глифа, но не вызов инструментов (у него нет собственного текста, правка бессмысленна).
                const lastEditable = [...glyph.mesids].reverse().find(id => !freshById.get(id)?.isToolCall);
                freshGlyphFinals.set(glyph.headerMesid, lastEditable ?? glyph.mesids[glyph.mesids.length - 1]);
            }
            s.snapshot = {
                glyphFinalByHeader: freshGlyphFinals,
                glyphMembersByHeader: freshGlyphMembers,
                order: freshOrder,
                byMesid: new Map(freshMessages.map(m => [m.mesid, m])),
                glyphHeaderByMesid: freshGlyphHeaders,
                indexByMesid: new Map(freshOrder.map((id, i) => [id, i])),
            };
            glyphHeadOf.clear();
            for (const [id, head] of freshGlyphHeaders) glyphHeadOf.set(id, head);
        }

        const { order, byMesid } = s.snapshot;
        const tail = byMesid.get(order[order.length - 1]);
        s.lastBodyMesid = (s.lastCanvas && tail && !tail.isToolCall) ? tail.mesid : null;
        return s.snapshot;
    }

    Object.assign(ctx, { ensureSnapshot });
}
