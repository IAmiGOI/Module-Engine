import { hashString, AVATAR_SPACER_WIDTH } from './constants.js';

/** Синхронизация зеркала+текстуры одного сообщения с его текстом. */
export function installBodySync(ctx) {
    const { s, rasterizedText, physicalTextureSize, mirrors, bodyImages, syncInflight, textureHome, bodyHeights, rowHeight, persistentCache, serviceOrThrow, serviceOrNull } = ctx;

    /**
     * Заглушка-обтекание для ОСТАВШЕЙСЯ высоты аватарки — owner: "И только
     * после заполнения той зоны спускаться вниз". `avatarRemainder`
     * (считает `render()`: `AVATAR_HEIGHT - chromeHeight`, где
     * `chromeHeight` — измеренная высота ТОЛЬКО реального контента шапки/
     * ризонинга/ToolCall, БЕЗ аватарки, см. её doc-comment) — сколько
     * высоты аватарки хром САМ не занял и должно занять тело. `0` — хром
     * (имя+дата+ризонинг+ToolCall) уже сам дотянулся до низа аватарки или
     * ниже, обтекать больше нечего, спейсер не нужен вовсе (и не
     * добавляется — иначе именно он и раздувал бы короткие сообщения
     * пустым хвостом, как в первой попытке этой же фичи). Настоящий
     * `float:left` браузера ВНУТРИ того же `foreignObject`, что и так уже
     * рисует тело (не угаданный отступ) — реальный текст сам обтекает эту
     * невидимую (`visibility:hidden`, не `display:none` — тот убрал бы
     * элемент из потока, обтекание не сработало бы) коробку.
     */
    function avatarSpacerHtml(avatarRemainder) {
        if (!(avatarRemainder > 0)) return '';
        return `<div style="float:left;width:${AVATAR_SPACER_WIDTH}px;height:${avatarRemainder}px;visibility:hidden;" aria-hidden="true"></div>`;
    }

    /**
     * Приводит зеркало+текстуру ОДНОГО сообщения в соответствие с его
     * текущим текстом. Не делает ничего, если текст с прошлого прохода не
     * изменился (`rasterizedText` — тот же приём кеша, что у остального
     * движка: сравнить с тем, что писали МЫ, а не гадать по побочным
     * признакам). `avatarRemainder` ВХОДИТ в ключ кеша — НАЙДЕНО ЖИВЬЁМ:
     * тот же текст МОЖЕТ потребовать другую заглушку, если СОСЕДНЕЕ
     * сообщение изменилось (реролл/правка/тоггл ризонинга) настолько, что
     * поменялась измеренная высота ХРОМА этого же сообщения — сам текст
     * при этом не тронут, кеш по одному только `text` решил бы "ничего не
     * изменилось". Возвращает измеренную высоту строки (для `heights`).
     */
    async function syncMesid(message, avatarRemainder = 0) {
        const { mesid } = message;
        const key = ctx.bodyKey(avatarRemainder, message.text);
        const inflight = syncInflight.get(mesid);
        if (inflight) {
            if (inflight.key === key) return inflight.promise;
            await inflight.promise.catch(() => {});
        }
        const promise = ctx.syncMesidRun(message, avatarRemainder);
        syncInflight.set(mesid, { key, promise });
        try { return await promise; } finally { if (syncInflight.get(mesid)?.promise === promise) syncInflight.delete(mesid); }
    }

    async function syncMesidRun(message, avatarRemainder = 0) {
        const { mesid, text } = message;
        const html = ctx.avatarSpacerHtml(avatarRemainder) + await ctx.paintedBodyHtml(message);

        // Сравнение с тем, что записали МЫ прошлый раз — тот же приём, что
        // `dom.js`'s `lastWritten`: без него растеризация/загрузка текстуры
        // повторялась бы на КАЖДЫЙ render(), а не только когда текст реально
        // изменился (стриминг зовёт render() на каждый токен ДРУГОГО
        // сообщения тоже — это не повод перерисовывать текущее).
        const cacheKey = ctx.bodyKey(avatarRemainder, text);
        const home = (s.lastCanvas && mesid === s.lastBodyMesid) ? s.lastCanvas : s.canvas;
        const oldHome = textureHome.get(mesid);
        const homeMoved = oldHome !== undefined && oldHome !== home;
        if (homeMoved) {
            // Сообщение стало (или перестало быть) последним — текстуру надо перенести на другой канвас.
            await serviceOrNull('webglChat.releaseTexture', { canvas: oldHome, textureId: mesid });
            textureHome.delete(mesid);
            rasterizedText.delete(mesid);
        }
        const changed = rasterizedText.get(mesid) !== cacheKey;
        if (!changed && !mirrors.has(mesid) && bodyHeights.has(mesid)) return bodyHeights.get(mesid);

        // Постоянный кэш (IndexedDB): готовая строка + измеренная высота + позиции картинок — без зеркала и растеризации.
        let diskKey = null;
        if (changed && persistentCache) {
            if (s.cssHashCache.css !== s.css) s.cssHashCache = { css: s.css, hash: hashString(s.css) };
            diskKey = `${hashString(html)}.${html.length}.${s.cssHashCache.hash}.${ctx.contentWidth()}.${s.devicePixelRatio}`;
            const hit = await serviceOrNull('rasterCache.get', { key: diskKey });
            if (hit?.image) {
                await serviceOrThrow('webglChat.uploadTexture', { canvas: home, textureId: mesid, image: hit.image });
                textureHome.set(mesid, home);
                if (home === s.lastCanvas) s.dirtyLast = true; else s.dirtyMain = true;
                rasterizedText.set(mesid, cacheKey);
                physicalTextureSize.set(mesid, { width: hit.width, height: hit.physHeight });
                if (hit.images?.length) bodyImages.set(mesid, hit.images); else bodyImages.delete(mesid);
                bodyHeights.set(mesid, hit.height);
                return hit.height;
            }
        }

        const mirror = await ctx.ensureMirror(mesid);
        let rasterHtml = html;
        if (changed) {
            await serviceOrThrow('dom.setInnerHtml', { el: mirror, html });
            // Картинки: дождаться загрузки (иначе высота зеркала замерится без них), снять позиции, подменить пустышками.
            const prepared = await serviceOrNull('dom.prepareImages', { el: mirror });
            if (prepared?.images?.length) { bodyImages.set(mesid, prepared.images); rasterHtml = prepared.html; }
            else bodyImages.delete(mesid);
        }

        // `Number.isFinite(...) ? ... : rowHeight`, НЕ `Math.round(...) ||
        // rowHeight` — НАЙДЕНО ЖИВЬЁМ, owner: "Пустые блоки... не должны
        // иметь этот спейс". `||` считает `0` ЛОЖНЫМ значением в JS — у
        // ГЕНУИННО пустого сообщения (`mes: ""`, реальный случай: модель
        // "подумала", но ничего не ответила) зеркало корректно измеряет
        // `rect.height === 0`, но `0 || rowHeight` отбрасывало этот
        // ПРАВИЛЬНЫЙ нулевой результат и подставляло `rowHeight` (96px по
        // умолчанию) — пустое сообщение получало пустой блок ВЫСОТОЙ В ЦЕЛУЮ
        // СТРОКУ вместо честного "почти ничего". `rowHeight`-фолбэк должен
        // срабатывать ТОЛЬКО когда измерение вообще не удалось (не число),
        // а не когда оно честно вернуло ноль.
        const rect = await ctx.measureBatched(mirror);
        const height = Math.max(1, Number.isFinite(rect.height) ? Math.round(rect.height) : rowHeight);

        if (changed) {
            // `width`/`height` здесь ЛОГИЧЕСКИЕ (совпадают с тем, что измерило
            // зеркало) — физическое разрешение растра задаёт `scale`, а не эти
            // два числа: без этого на экране с devicePixelRatio > 1 текстура
            // растеризовалась бы В РАЗРЕШЕНИИ ЭКРАНА БЕЗ УЧЁТА DPR и потом
            // растягивалась GPU при отрисовке квада большего физического
            // размера — то самое "текст слишком пиксельный".
            const rasterized = await serviceOrThrow('htmlRasterizer.rasterize', { html: rasterHtml, width: ctx.contentWidth(), height, css: s.css, scale: s.devicePixelRatio });
            await serviceOrThrow('webglChat.uploadTexture', { canvas: home, textureId: mesid, image: rasterized.image });
            textureHome.set(mesid, home);
            if (home === s.lastCanvas) s.dirtyLast = true; else s.dirtyMain = true;
            rasterizedText.set(mesid, cacheKey);
            physicalTextureSize.set(mesid, { width: rasterized.width, height: rasterized.height });
            if (diskKey) {
                serviceOrNull('rasterCache.put', {
                    key: diskKey, image: rasterized.image, height, width: rasterized.width, physHeight: rasterized.height, images: bodyImages.get(mesid) ?? [],
                }).catch(() => {});
            }
        }

        bodyHeights.set(mesid, height);
        return height;
    }

    Object.assign(ctx, { avatarSpacerHtml, syncMesid, syncMesidRun });
}
