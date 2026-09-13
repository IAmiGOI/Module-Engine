/**
 * Auto color palette — pure HSL-rotation math, no DOM/ST/state. The ONLY
 * consumer right now is Модуль «Speaker Colors» (assigns a fresh color to a
 * newly-discovered speaker), but the math itself is generic enough that any
 * future "N distinct, readable colors derived from the current theme" need
 * (a legend, a set of user avatars) can reuse it without copying hue math —
 * LIBRARIES.md's "Library before Module" rule.
 *
 * Rotation, not random: the Nth speaker discovered always gets the SAME hue
 * offset from the base color, in the SAME order, on every machine — matters
 * because colors get persisted (Ядро определения говорящего), and a
 * re-resolve of the same chat must keep assigning newly-seen speakers the
 * same sequence, not a different shuffle each session.
 */

const HUE_STEP_DEGREES = 47; // co-prime with 360 → doesn't repeat a hue for a long, useful run of speakers

/** `resolveX` — a malformed/absent hex always falls back to a fixed neutral blue rather than propagating NaN into HSL math. */
export function resolveBaseHue(hexColor) {
    const match = String(hexColor ?? '').trim().match(/^#([0-9a-fA-F]{6})$/);
    if (!match) return 210;
    const r = parseInt(match[1].slice(0, 2), 16) / 255;
    const g = parseInt(match[1].slice(2, 4), 16) / 255;
    const b = parseInt(match[1].slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    if (delta === 0) return 210;
    let hue;
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue *= 60;
    return hue < 0 ? hue + 360 : hue;
}

function hslToHex(hue, saturation, lightness) {
    const s = saturation / 100;
    const l = lightness / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = l - c / 2;
    const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
    const toHex = value => Math.round((value + m) * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * `computeX` — the color for the `index`-th (0-based) auto-assigned
 * speaker, rotated off `baseHex` (typically the host app's own accent
 * color). Fixed saturation/lightness chosen to stay legible painted as text
 * on either a light or dark message background — not tuned to any one
 * theme, since the paint surface is ST's own chat area, not our own panel
 * (UI.md's `--stme-accent` rules don't apply here).
 */
export function computeAutoSpeakerColor(baseHex, index) {
    const hue = (resolveBaseHue(baseHex) + HUE_STEP_DEGREES * Math.max(0, index)) % 360;
    return hslToHex(hue, 65, 55);
}
