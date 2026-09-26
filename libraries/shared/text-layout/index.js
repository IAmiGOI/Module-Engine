import { layoutBlocks } from './block-layout.js';
import { resolveTheme } from './style.js';

export { parseBody, AVATAR_SPACER_CLASS } from './parse.js';
export { buildFontSpec, resolveTheme, DEFAULT_THEME, BASE_STYLE } from './style.js';

/**
 * Раскладка тела сообщения: разобранные блоки (`parseBody`) + ширина → строки с позициями кусков, коробки (картинки, маркеры списков,
 * линейки) и высота. Чистая функция: ни `document`, ни canvas — измерения приходят снаружи.
 *
 * Измерения запрашиваются через `measure(font, text) → число | undefined`, `metrics(font) → { ascent, descent } | undefined` и
 * `imageSize(src) → { width, height } | undefined`. `undefined` значит «ещё не измерено»: раскладка всё равно доводится до конца (с нулями),
 * но возвращает `{ complete: false, missing }` — вызывающий измеряет недостающее ОДНИМ пакетом и зовёт снова. Так Ядро не ходит в Сервис
 * за каждым словом: за первый проход собирается всё, второй — окончательный.
 */
export function computeTextLayout({ parsed, width, theme: themeInput, measure, metrics, imageSize = () => undefined }) {
    const theme = resolveTheme(themeInput);
    const missing = { measures: new Map(), metrics: new Set(), images: new Set() };
    const env = {
        textWidth(font, text) {
            const value = measure(font, text);
            if (typeof value === 'number' && Number.isFinite(value)) return value;
            missing.measures.set(`${font}\u0000${text}`, { font, text });
            return 0;
        },
        fontMetrics(font) {
            const value = metrics(font);
            if (value && Number.isFinite(value.ascent) && Number.isFinite(value.descent)) return value;
            missing.metrics.add(font);
            return { ascent: 0, descent: 0 };
        },
        imageSize(src) {
            const value = imageSize(src);
            if (value && value.width > 0 && value.height > 0) return value;
            missing.images.add(src);
            return { width: 0, height: 0 };
        },
    };
    const out = { lines: [], boxes: [] };
    const state = { y: 0, pendingGap: 0, atStart: true };
    layoutBlocks(parsed.blocks, { left: 0, right: Math.max(1, width) }, state, { theme, env, out, exclusion: parsed.exclusion ?? null });
    if (missing.measures.size || missing.metrics.size || missing.images.size) {
        return {
            complete: false,
            missing: { measures: [...missing.measures.values()], metrics: [...missing.metrics], images: [...missing.images] },
        };
    }
    return { complete: true, width, height: state.y, lines: out.lines, boxes: out.boxes };
}
