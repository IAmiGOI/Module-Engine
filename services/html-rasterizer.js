/**
 * Сервис растеризации HTML — превращает уже готовый HTML (обычно результат
 * `stChat.formatMessage`, то есть родного `messageFormatting()` ST) в
 * растровое изображение, пригодное как источник текстуры для WebGL. Часть
 * гибридной архитектуры Chat Viewport: тело сообщения не переизобретается
 * своим text-layout движком — оно один раз рисуется настоящим браузерным
 * рендерером через `SVG foreignObject`, а WebGL несёт только композитинг и
 * эффекты (см. план `chat-viewport`, раздел "Ключевое техническое решение").
 *
 * **Единственный подтверждённый рабочий путь — `data:` URI + `new Image()`.**
 * Проверено живым спайком (не предположение): `new Blob([svg]) →
 * createImageBitmap(blob)` НАПРЯМУЮ падает в Chromium с `InvalidStateError:
 * The source image could not be decoded`, стоит SVG содержать
 * `foreignObject` — это воспроизведённый баг, не гипотетический риск.
 * `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` через
 * `new Image()` — рабочий путь, попиксельно подтверждённый (CSS-переменные
 * темы ST внутри `foreignObject` резолвятся, фон/цвет кода/акцент доходят
 * до растра в ожидаемых пропорциях).
 *
 * `rasterizeToImage` инжектируется — тот же приём, что `decodeImageToPixels`/
 * `resolveImageDimensions` в `modules/map/index.js`: платформенная
 * возможность (реальный браузерный `Image`), не то, что можно протестировать
 * в Node напрямую, поэтому в тестах подменяется фейком, а не мокается через
 * `globalThis.Image`.
 *
 * **`normalizeHtmlToXml` — найдено живьём в настоящей SillyTavern 1.18, не
 * на синтетическом HTML спайка.** `messageFormatting()` отдаёт настоящий
 * HTML (родной markdown-рендер ST) — а SVG требует строгий XML, и обычный
 * HTML им не является: `<br>` без самозакрытия, одиночный `&` в тексте/URL,
 * — всё это валидный HTML, но невалидный XML, и декодирование ВСЕГО SVG
 * падает целиком (`img.onerror`), даже если сломан один символ. Синтетический
 * HTML спайка (`scratchpad/rasterize-spike.html`) случайно не содержал ни
 * одного такого случая — поймано только на реальном выводе ST. Лечится тем
 * же приёмом, что обычно используют для "HTML → безопасный XML": прогнать
 * через настоящий HTML-парсер браузера (`div.innerHTML = html`), затем
 * сериализовать результат обратно через `XMLSerializer` — он ВСЕГДА
 * самозакрывает пустые элементы и экранирует спецсимволы, потому что XML
 * иначе не сериализовать. Инжектируется тем же приёмом, что и
 * `rasterizeToImage` — оба платформенные, оба недоступны в Node.
 */

/**
 * Собирает SVG-строку с одним `foreignObject`, несущим переданный HTML и
 * инлайновый CSS. Чистая функция — строки в строку, без DOM, без сети —
 * поэтому тестируется как данные, а не через живой рендер.
 *
 * `css` передаётся целиком уже готовым текстом (Ядро решает, какие правила
 * темы ST нужны телу сообщения — тот же принцип, что и у остального
 * движка: WHAT решает вызывающий, HOW делает Сервис). foreignObject НЕ
 * наследует стили хост-страницы ни в одном браузере надёжно, поэтому CSS
 * всегда инлайнится сюда явно, а не предполагается унаследованным.
 *
 * `width`/`height` — ЛОГИЧЕСКИЕ (CSS) пиксели, те же, что измерил невидимый
 * DOM-зеркало в Ядре (см. `cores/ui/chat-viewport.js`) — перенос переноса
 * строк должен совпадать с реальным layout один в один. `scale` (обычно
 * `devicePixelRatio`) задаёт РАЗРЕШЕНИЕ растра отдельно от переноса строк:
 * сам SVG (и итоговая текстура) физически больше в `scale` раз, а внутренний
 * контент растягивается CSS-трансформом от исходного логического размера —
 * без этого текстура на экране с `devicePixelRatio > 1` растеризовалась бы в
 * разрешении логических пикселей и потом растягивалась бы GPU при отрисовке
 * физически большего квада, то есть выглядела бы пиксельной именно там, где
 * реальный браузер рисует чётко.
 */
export function buildForeignObjectSvg({ html, width, height, css = '', scale = 1 } = {}) {
    const logicalW = Math.max(1, Math.round(Number(width) || 0));
    const logicalH = Math.max(1, Math.round(Number(height) || 0));
    const factor = Math.max(0.0001, Number(scale) || 1);
    const physicalW = Math.max(1, Math.round(logicalW * factor));
    const physicalH = Math.max(1, Math.round(logicalH * factor));
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${physicalW}" height="${physicalH}">` +
        `<foreignObject width="100%" height="100%">` +
        `<div xmlns="http://www.w3.org/1999/xhtml">` +
        (css ? `<style>${css}</style>` : '') +
        `<div class="stme-chat-viewport-body" style="width:${logicalW}px; transform: scale(${factor}); transform-origin: top left;">${html ?? ''}</div>` +
        `</div>` +
        `</foreignObject>` +
        `</svg>`
    );
}

/**
 * HTML (обычный, не обязательно валидный XML) → та же разметка, но
 * гарантированно валидный XML — см. doc-comment файла. Пропускается через
 * НАСТОЯЩИЙ HTML-парсер браузера (не самодельный regex — тот неизбежно
 * пропустил бы какой-то случай, который реальный парсер уже решил), затем
 * сериализуется обратно поэлементно: `XMLSerializer` не умеет сериализовать
 * временный `<div>`-контейнер БЕЗ явного namespace предсказуемо, поэтому
 * сериализуются его ДЕТИ по одному, а не он сам целиком.
 */
function defaultNormalizeHtmlToXml(html) {
    const container = document.createElement('div');
    container.innerHTML = String(html ?? '');
    const serializer = new XMLSerializer();
    return [...container.childNodes].map(node => serializer.serializeToString(node)).join('');
}

/** Единственный проверенный рабочий путь — см. doc-comment файла для того, что НЕ работает и почему. Инжектируется целиком (не только `Image`), чтобы Node-тесты не трогали ни один браузерный конструктор. */
async function defaultRasterizeToImage(svgString) {
    const dataUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`;
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('html-rasterizer: the browser failed to decode the rasterized SVG.'));
        img.src = dataUri;
    });
}

/**
 * Регистрирует `htmlRasterizer.rasterize` на `servicesBus`. Возвращает
 * `{ image, width, height }` — `image` готов как источник текстуры
 * (`texImage2D` принимает `HTMLImageElement` напрямую, отдельного шага
 * `createImageBitmap` не требуется — и, как показал спайк, для SVG с
 * `foreignObject` он и не надёжен). `width`/`height` в ответе — ФИЗИЧЕСКИЕ
 * (после `scale`), то есть настоящие размеры отданного изображения, не
 * входные логические — вызывающему для построения квада нужны именно они.
 */
export function registerHtmlRasterizerService(servicesBus, {
    rasterizeToImage = defaultRasterizeToImage,
    normalizeHtmlToXml = defaultNormalizeHtmlToXml,
} = {}) {
    async function rasterize(params) {
        const logicalWidth = Math.max(1, Math.round(Number(params?.width) || 0));
        const logicalHeight = Math.max(1, Math.round(Number(params?.height) || 0));
        const scale = Math.max(0.0001, Number(params?.scale) || 1);
        const safeHtml = normalizeHtmlToXml(params?.html);
        const svgString = buildForeignObjectSvg({ html: safeHtml, width: logicalWidth, height: logicalHeight, css: params?.css, scale });
        const image = await rasterizeToImage(svgString);
        return { image, width: Math.round(logicalWidth * scale), height: Math.round(logicalHeight * scale) };
    }

    const unregisters = [
        servicesBus.register('htmlRasterizer.rasterize', params => rasterize(params), { loadMetric: () => 1 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}
