/**
 * Слои оверлея Chat Viewport: обёртка со скроллом → (контент-бокс → липкий слой → слой отступа → канвасы и хром; spacer) + зеркало.
 * Только сборка и стили; ни подписок, ни состояния. Каждый вызов идёт через Гейт (`callOrThrow` = `dom.*`).
 *
 * Порядок вставки и стилей важен и проверен живьём — не перестраивать «для красоты».
 */

const WRAPPER_Z_INDEX = 31;

export async function buildOverlayLayers(callOrThrow, { parent, pageSize, layout }) {
    const make = tag => callOrThrow('dom.createElement', { tag });
    const setProp = (el, key, value) => callOrThrow('dom.setProp', { el, key, value });
    const append = (parent, child) => callOrThrow('dom.append', { parent, child });

    const wrapper = await make('div');
    const spacer = await make('div');
    const contentBox = await make('div');
    const stickyLayer = await make('div');
    const marginLayer = await make('div');
    const canvas = await make('canvas');
    const lastCanvas = await make('canvas');
    const mirror = await make('div');
    const chrome = await make('div');
    const leftHandle = await make('div');
    const rightHandle = await make('div');

    await setProp(wrapper, 'class', 'stme-chat-viewport-overlay');
    await setProp(spacer, 'class', 'stme-chat-viewport-spacer');
    await setProp(mirror, 'class', 'stme-chat-viewport-mirror-host');
    await setProp(chrome, 'class', 'stme-chat-viewport-chrome-host');
    await setProp(leftHandle, 'class', 'stme-chat-viewport-resize-handle');
    await setProp(rightHandle, 'class', 'stme-chat-viewport-resize-handle');

    // ОДИН `position:sticky` слой несёт И канвас, И хром. Раньше у каждого был свой sticky, и это работало лишь
    // случайно, пока большая высота `mirror` в потоке «проталкивала» chrome за порог прилипания; когда `mirror` стал
    // `position:absolute`, хром и тело начали прилипать на разных уровнях («едут на разных уровнях»). Один общий
    // контейнер с обоими внутри (`position:absolute`) убирает саму возможность разъехаться.
    await setProp(stickyLayer, 'style', { position: 'sticky', top: '0px', left: '0px', height: '0px', overflow: 'visible' });
    // `marginLayer` — единственный держатель горизонтального сдвига при заужении. Фон глифов берёт родителя через
    // `canvas.parentElement`, то есть тоже `marginLayer`, — и сдвигается синхронно с канвасом без правок chat-viewport.js.
    await setProp(marginLayer, 'style', { position: 'absolute', top: '0px', left: '0px', height: '0px', overflow: 'visible', willChange: 'transform' });
    await setProp(canvas, 'style', { position: 'absolute', top: '0px', left: '0px', display: 'block' });
    await setProp(chrome, 'style', { position: 'absolute', top: '0px', left: '0px', height: '0px', overflow: 'visible' });
    // Ручки заужения — сиблинги `marginLayer`, не дети: их `left` считается в тех же координатах (относительно stickyLayer),
    // внутри `marginLayer` он удвоился бы с его собственным сдвигом. `100vh` — упрощение: ручка не обязана точно совпадать
    // с высотой канваса, только перекрывать видимую область для захвата мышью.
    await setProp(leftHandle, 'style', { position: 'absolute', top: '0px', height: '100vh' });
    await setProp(rightHandle, 'style', { position: 'absolute', top: '0px', height: '100vh' });
    await setProp(lastCanvas, 'style', { position: 'absolute', top: '0px', left: '0px', display: 'none', pointerEvents: 'none', willChange: 'transform' });

    await append(marginLayer, canvas);
    await append(marginLayer, lastCanvas);
    await append(marginLayer, chrome);
    await append(stickyLayer, marginLayer);
    await append(stickyLayer, leftHandle);
    await append(stickyLayer, rightHandle);
    // `overflow: clip`, НЕ hidden: hidden сделал бы коробку своим скролл-контейнером и сломал бы sticky слоя. Без границы
    // окно предрендера канваса (запас выше/ниже экрана) выступало бы за конец содержимого и добавляло лишнюю прокрутку.
    await setProp(contentBox, 'style', { position: 'relative', overflow: 'clip' });
    await append(contentBox, stickyLayer);
    await append(contentBox, spacer);
    await append(wrapper, contentBox);
    await append(wrapper, mirror);
    await append(parent, wrapper);

    // Оверлей лежит на ВСЁ окно (owner: «вьюпорт режется под верхним блоком и над блоком ввода, хотя должен уходить под них во все окно»):
    // сверху и снизу — отступы `paddingTop`/`paddingBottom` под верхнюю панель ST и панель ввода, чтобы первое и последнее сообщения
    // не оказались под ними, а всё между — прокручивается под панелями и виден вокруг них. Липкий слой прилипает к краю СОДЕРЖИМОГО обёртки (`top: 0` отсчитывается за вычетом `paddingTop`, найдено живьём: `top: T` давало двойной сдвиг), то есть ровно под верхней панелью.
    // `parent` — `#sheld`, а не `body`: оверлей с `z-index: -1` внутри его контекста укладывается ПОД панелью ввода (она в потоке) и над
    // прозрачным фоном `#sheld`, а верхняя панель ST (z-index 3005) выше по-прежнему. Найдено живьём раньше: при `z-index: 31` на `body`
    // оверлей перекрыл бы панель ввода целиком, а при `z-index < 30` `#sheld` перехватывал колесо и клики. Запасной вариант без `#sheld`
    // (`parent === body`) — прежний `z-index: 31`.
    // `scrollbar-gutter: stable` — без него ширина, измеренная ДО attach(), врала: скроллбара ещё нет, а после render() он появляется.
    await setProp(wrapper, 'style', {
        position: 'fixed', top: '0px', bottom: '0px', left: `${layout.left}px`, width: `${pageSize.width - layout.left}px`, boxSizing: 'border-box',
        paddingTop: `${layout.top}px`, paddingBottom: `${layout.bottom}px`,
        overflowY: 'auto', scrollbarGutter: 'stable', zIndex: layout.behindInput ? -1 : WRAPPER_Z_INDEX, contain: 'layout style',
    });

    return { wrapper, spacer, contentBox, stickyLayer, marginLayer, canvas, lastCanvas, mirror, chrome, leftHandle, rightHandle };
}
