/**
 * Входящий ящик правок (сервис `stPatchInbox`): правки банков вне сюжета, положенные снаружи, применяются при открытии
 * чата и перед каждым ходом — через те же исправления, что и вкладка Files, поэтому доходят до снимков и не откатываются.
 *
 * Формат `me-patch.json`:
 *   { "chatId": "<имя чата без .jsonl, необязательно>", "comment": "…",
 *     "edits": [ { "character": "Elil", "part": "psyche", "lines": ["…"] },
 *                { "character": "Elil", "part": "decree", "sections": { "5": ["…"] } },
 *                { "character": "Elil", "rewrite": "psyche" } ] }
 * Правка для другого чата лежит, пока не откроют её чат. Отчёт — `me-patch-result.json` рядом.
 */
export function createPatchInbox({ callService, banks, publishEvent = () => {} }) {
    let taking = null;

    async function applyOne(item, comment) {
        try {
            if (item?.rewrite === 'psyche') return { character: item.character, ...(await banks.rewritePsyche(item.character)) };
            return await banks.great.correct({ ...item, comment: item?.comment ?? comment, by: 'outside' });
        } catch (error) {
            return { ok: false, character: item?.character, error: error?.message ?? String(error) };
        }
    }

    async function takeNow() {
        const patch = await callService('stPatchInbox.read').catch(() => null);
        if (!patch || typeof patch !== 'object') return null;
        const chat = await callService('stChat.chatId').catch(() => null);
        const wanted = String(patch.chatId ?? '').trim().replace(/\.jsonl$/i, '');
        if (wanted && wanted !== String(chat?.id ?? '')) return { skipped: true, reason: 'the patch is for another chat' };
        const results = [];
        for (const item of Array.isArray(patch.edits) ? patch.edits : []) results.push(await applyOne(item, String(patch.comment ?? '')));
        await callService('stPatchInbox.remove').catch(() => null);
        await callService('stPatchInbox.reply', { result: { chatId: chat?.id ?? null, results } }).catch(() => null);
        publishEvent('decision.patch.applied', { results });
        return { ok: results.every(result => result?.ok !== false), results };
    }

    /** Один разбор за раз: открытие чата и ход могут спросить почти одновременно. */
    function take() {
        if (taking) return taking;
        taking = takeNow().catch(() => null).finally(() => { taking = null; });
        return taking;
    }

    return { take };
}
