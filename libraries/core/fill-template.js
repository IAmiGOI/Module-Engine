/**
 * Шаблонизация текста — `{field}`-style placeholder substitution, the exact
 * pattern LIBRARIES.md anticipated (Alpha's Tracker/RP Time/Post-Turn all
 * hand-rolled this once each). First real consumer: cores/tracking/index.js's
 * prompt-building.
 *
 * A placeholder with no matching key in `values` is left untouched (not
 * blanked) — a silently-vanished `{typoedField}` in a hand-written prompt is
 * far more confusing than an obviously-still-a-placeholder one.
 */
export function fillTemplate(template, values) {
    return String(template ?? '').replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(values ?? {}, key) ? String(values[key]) : match);
}
