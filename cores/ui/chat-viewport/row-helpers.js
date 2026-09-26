import { MIRROR_CLASS, TEXT_PADDING, AVATAR_CSS_WIDTH, AVATAR_CSS_HEIGHT, AVATAR_SUPERSAMPLE } from './constants.js';

/** Мелкие помощники строки: масштабированные аватарки, HTML тела, ширина тела, чтение сообщений, зеркало. */
export function installRowHelpers(ctx) {
    const { s, mirrors, avatarScaled, serviceOrThrow, serviceOrNull, coreOrNull } = ctx;

    // Аватарки готовятся один раз нужного размера (`imageScale.toBlobUrl`): оригинал в сотни пикселей, сжатый браузером в слое
    // `will-change: transform`, получался рваным, а миниатюра ST 96×144 при DPR > 1 — мыльной. Пока не готово, показывается оригинал.

    function scaledAvatarUrl(url) {
        if (!url) return url;
        const key = `${url}|${s.devicePixelRatio}`;
        const hit = avatarScaled.get(key);
        if (hit) return hit.ready ?? url;
        const entry = { ready: null };
        avatarScaled.set(key, entry);
        serviceOrNull('imageScale.toBlobUrl', { url, width: AVATAR_CSS_WIDTH * s.devicePixelRatio * AVATAR_SUPERSAMPLE, height: AVATAR_CSS_HEIGHT * s.devicePixelRatio * AVATAR_SUPERSAMPLE })
            .then(result => { if (result) { entry.ready = result; ctx.render({ fresh: false }); } })
            .catch(() => {});
        return url;
    }

    /** Сумма времени генерации по всем сообщениям глифа; `null`, если ни у одного нет измеренного времени. */
    function sumGlyphDuration(members, byMesid, fallbackMessage) {
        if (!members?.length) return fallbackMessage.genDurationMs ?? null;
        let total = 0;
        let any = false;
        for (const id of members) {
            const duration = byMesid.get(id)?.genDurationMs;
            if (Number.isFinite(duration)) { total += duration; any = true; }
        }
        return any ? total : null;
    }

    /** HTML тела сообщения, уже раскрашенный по говорящим (Ядро говорящего, `speaker.paintHtml`), если оно есть и есть что красить. */
    async function paintedBodyHtml(message) {
        const formatted = await serviceOrThrow('stChat.formatMessage', { mesid: message.mesid });
        const painted = await coreOrNull('speaker.paintHtml', { html: formatted, mesid: message.mesid, defaultSpeakerName: message.name });
        return typeof painted === 'string' ? painted : formatted;
    }

    /** Ширина, доступная САМОМУ телу сообщения — `viewportWidth` за вычетом `TEXT_PADDING` с обеих сторон. Вычисляется по требованию (не кешируется), чтобы `setViewport()`'s изменение `viewportWidth` подхватывалось следующим же `render()` без отдельной синхронизации. */
    function contentWidth() {
        return Math.max(1, s.viewportWidth - TEXT_PADDING * 2);
    }

    // `includeSystem: true` — НАЙДЕНО ЖИВЬЁМ: `stChat.messages` по умолчанию
    // (`includeSystem: false`) выкидывает ВСЕ `is_system`-сообщения — это
    // подходящий дефолт для потребителей вроде памяти/макросов, которым
    // системный шум не нужен, но НЕ для Chat Viewport, чья задача —
    // показывать то же самое, что видит пользователь в родном чате. Реальная
    // ST `is_system` НЕ прячет: `style.css` лишь чуть иначе стилизует такие
    // сообщения (`grayscale` на аватарке и т.п.), сам текст остаётся видимым
    // в `#chat`. Из-за этого пропадали, например, системные уведомления о
    // вызове инструмента (`<details><summary>Tool calls: ...`) — целое
    // сообщение молча не долетало до рендера.
    async function readOrderedMessages() {
        return (await serviceOrNull('stChat.messages', { limit: Number.MAX_SAFE_INTEGER, includeSystem: true })) ?? [];
    }

    /** Зеркало создаётся один раз на `mesid`, дальше только обновляется — пересоздание сорвало бы `ResizeObserver`/фокус выделения без нужды. */
    const mirrorWidths = new WeakMap(); // зеркало -> ширина, что мы ему задали (при изменении ширины сообщений зеркало обязано её подхватить)
    async function ensureMirror(mesid) {
        let mirror = mirrors.get(mesid);
        const width = ctx.contentWidth();
        if (mirror) {
            if (mirrorWidths.get(mirror) !== width) {
                await serviceOrThrow('dom.setProp', { el: mirror, key: 'style', value: { width: `${width}px` } });
                mirrorWidths.set(mirror, width);
            }
            return mirror;
        }
        mirror = await serviceOrThrow('dom.createElement', { tag: 'div' });
        await serviceOrThrow('dom.setProp', { el: mirror, key: 'class', value: MIRROR_CLASS });
        await serviceOrThrow('dom.setProp', { el: mirror, key: 'style', value: { width: `${width}px` } });
        await serviceOrThrow('dom.append', { parent: s.mirrorContainer, child: mirror });
        mirrors.set(mesid, mirror);
        mirrorWidths.set(mirror, width);
        return mirror;
    }

    /**
     * Ключ кэша растра тела: ШИРИНА тела + заглушка под аватарку + текст. Ширина входит в ключ — иначе после изменения ширины сообщений
     * (ручки заужения, поворот экрана) текстура и высота оставались от старой ширины: картинки не пересчитывались, а текст выезжал за окно.
     */
    function bodyKey(remainder, text) {
        return `${ctx.contentWidth()}|${remainder}::${text}`;
    }

    Object.assign(ctx, { scaledAvatarUrl, sumGlyphDuration, paintedBodyHtml, contentWidth, readOrderedMessages, ensureMirror, bodyKey });
}
