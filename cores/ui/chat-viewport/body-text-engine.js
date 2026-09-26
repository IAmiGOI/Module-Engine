import { computeTextLayout } from '../../../libraries/shared/text-layout/index.js';
import { AVATAR_SPACER_WIDTH } from './constants.js';

/**
 * Новый путь тела сообщения: своя раскладка (`libraries/shared/text-layout`) + отрисовка в canvas (`textPainter.*`) вместо «зеркало +
 * SVG-растр». Высота берётся из раскладки, а не из зеркала — одна раскладка даёт и высоту, и то, что рисуется, запас на расхождение
 * движков не нужен. Текст — шрифтом темы ST (веб-шрифт страницы, растр его не видел).
 *
 * Сообщение, которое раскладчик не поддерживает (`textPainter.parse` → `ok: false`), битые картинки и тела выше предела одной текстуры
 * уходят на старый путь как раньше — `syncWithTextEngine` возвращает `null`. Причины копятся в `ctx.textEngineStats` (для диагностики).
 *
 * Измерения кэшируются здесь же, в Ядре: при стриминге (перерисовка на каждый токен) почти все слова уже измерены — вызов Сервиса за
 * ширинами уходит только за новыми словами, одним пакетом.
 */

/** Раундов «разложить → доизмерить недостающее». Обычно два (всё неизвестно → всё известно); третий — страховка. */
const MAX_LAYOUT_ROUNDS = 3;
/** Предел одной текстуры (физические px). Выше — старый путь: квад тела у рендера пока один на сообщение. */
const MAX_SINGLE_TEXTURE = 4096;

export function installBodyTextEngine(ctx) {
    const { s, rasterizedText, physicalTextureSize, bodyImages, textureHome, bodyHeights, mirrors, persistentCache, serviceOrNull, serviceOrThrow } = ctx;
    const widths = new Map();
    const metrics = new Map();
    const imageSizes = new Map();
    const stats = { engine: 0, fallback: 0, reasons: new Map() };

    const fallback = reason => {
        stats.fallback += 1;
        stats.reasons.set(reason, (stats.reasons.get(reason) ?? 0) + 1);
        return null;
    };

    async function fillMissing(missing) {
        const [measured, fontMetrics, sizes] = await Promise.all([
            missing.measures.length ? serviceOrThrow('textPainter.measure', { requests: missing.measures }) : [],
            missing.metrics.length ? serviceOrThrow('textPainter.metrics', { fonts: missing.metrics }) : [],
            missing.images.length ? serviceOrThrow('textPainter.imageSizes', { srcs: missing.images }) : [],
        ]);
        missing.measures.forEach(({ font, text }, index) => widths.set(`${font}\u0000${text}`, measured[index]));
        missing.metrics.forEach((font, index) => metrics.set(font, fontMetrics[index]));
        missing.images.forEach((src, index) => imageSizes.set(src, sizes[index] ?? 'broken'));
    }

    async function computeLayout(parsed, width) {
        const theme = { ...s.textTheme };
        for (let round = 0; round < MAX_LAYOUT_ROUNDS; round += 1) {
            const layout = computeTextLayout({
                parsed, width, theme,
                measure: (font, text) => widths.get(`${font}\u0000${text}`),
                metrics: font => metrics.get(font),
                imageSize: src => { const size = imageSizes.get(src); return size === 'broken' ? { width: 0, height: 0 } : size; },
            });
            if (layout.complete) return layout;
            if (layout.missing.images.some(src => imageSizes.get(src) === 'broken')) return null;
            await fillMissing(layout.missing);
        }
        return null;
    }

    /**
     * Синхронизирует тело `message` новым путём. Возвращает высоту (как `syncMesidRun`) или `null` — «старый путь». `html` — тело без
     * заглушки аватарки (обтекание задаётся исключением раскладки), `cacheKey`/`diskKey` — те же ключи, что у старого пути.
     */
    async function syncWithTextEngine(message, { html, avatarRemainder, home, cacheKey, diskKey }) {
        const { mesid } = message;
        const parsed = await serviceOrNull('textPainter.parse', { html });
        if (!parsed) return fallback('text painter unavailable');
        if (!parsed.ok) return fallback(parsed.reason);
        const withExclusion = avatarRemainder > 0 ? { ...parsed, exclusion: { width: AVATAR_SPACER_WIDTH, height: avatarRemainder } } : parsed;
        const layout = await computeLayout(withExclusion, ctx.contentWidth());
        if (!layout) return fallback('image failed to load');
        const height = Math.max(0, Math.ceil(layout.height));
        if (Math.ceil(height * s.devicePixelRatio) > MAX_SINGLE_TEXTURE) return fallback('taller than one texture');

        const painted = await serviceOrThrow('textPainter.paint', { layout: { ...layout, height: Math.max(1, height) }, dpr: s.devicePixelRatio, colors: s.textTheme.colors, maxTextureSize: MAX_SINGLE_TEXTURE });
        const tile = painted.tiles[0];
        await serviceOrThrow('webglChat.uploadTexture', { canvas: home, textureId: mesid, image: tile.image });
        textureHome.set(mesid, home);
        if (home === s.lastCanvas) s.dirtyLast = true; else s.dirtyMain = true;
        rasterizedText.set(mesid, cacheKey);
        physicalTextureSize.set(mesid, { width: tile.physicalWidth, height: tile.physicalHeight });
        const images = layout.boxes.filter(box => box.kind === 'image').map(({ src, x, y, width, height: imageHeight }) => ({ src, x, y, width, height: imageHeight }));
        if (images.length) bodyImages.set(mesid, images); else bodyImages.delete(mesid);
        bodyHeights.set(mesid, height);
        // Зеркало от старого пути (сообщение раньше шло им) больше не нужно — и опасно: `syncMesidRun` при неизменном тексте мерил бы
        // высоту по нему, а не по раскладке.
        const mirror = mirrors.get(mesid);
        if (mirror) { await serviceOrNull('dom.remove', { node: mirror }); mirrors.delete(mesid); }
        if (diskKey && persistentCache) {
            serviceOrNull('rasterCache.put', { key: diskKey, image: tile.image, height, width: tile.physicalWidth, physHeight: tile.physicalHeight, images }).catch(() => {});
        }
        stats.engine += 1;
        return height;
    }

    /** Включить/выключить новый путь на лету: все тела пересобираются тем путём, что выбран сейчас. */
    function setTextEngine({ enabled } = {}) {
        const next = Boolean(enabled);
        if (next === s.textEngine) return false;
        s.textEngine = next;
        rasterizedText.clear();
        if (s.attached) ctx.render({ fresh: true });
        return true;
    }

    function isTextEngineActive() {
        return Boolean(s.textEngine && s.textTheme);
    }

    Object.assign(ctx, { syncWithTextEngine, setTextEngine, isTextEngineActive, textEngineStats: stats });
}
