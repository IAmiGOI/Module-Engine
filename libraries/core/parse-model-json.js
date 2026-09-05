/**
 * Разбор структурированного (JSON) ответа модели — the pattern LIBRARIES.md
 * anticipated (Alpha's `parseTrackerResponse`, generalized: any Ядро
 * expecting a structured reply needs this, not just tracking). Strips a
 * markdown code fence first — a real model asked for "reply with only JSON"
 * still often wraps it in ```json ... ``` anyway.
 *
 * Defensive reader — malformed/non-JSON input yields `undefined`, never
 * throws; the caller decides whether that's a real failure.
 */
export function parseModelJson(text) {
    const stripped = String(text ?? '').trim().replace(/^```[\w-]*\n?/, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(stripped); }
    catch { return undefined; }
}
