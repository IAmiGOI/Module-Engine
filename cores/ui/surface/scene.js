/**
 * ОБЩАЯ поверхность блоков (рабочий стол и панель — cores/ui/home/, cores/ui/hub/): контейнер на всё окно с ДВУМЯ слоями — снизу DOM блоков (плиты, аватары, кнопки), сверху прозрачный WebGL-канвас с
 * текстом блоков (`pointer-events: none`, поэтому клики доходят до DOM под ним). Тело блока — растр HTML (`htmlRasterizer`), тот же путь и тот же
 * рендерер (`webglChat`), что у тел сообщений в Chat Viewport; текстура перерисовывается ТОЛЬКО когда изменился HTML блока.
 *
 * Перетаскивание блока — это не растеризация: меняется только `transform` DOM-узла и позиция квада, кадр рисуется одним `drawFrame`.
 * Браузерное (`document`, `devicePixelRatio`) — инъекцией; вызовы сервисов — через `call(contract, params)` → `{ ok, value }`.
 */
const MAX_CANVAS_SIDE = 4096;

export function createSurfaceScene({ document: doc = globalThis.document, call, getDevicePixelRatio = () => globalThis.devicePixelRatio || 1, className = 'stme-home' }) {
    const root = doc.createElement('div');
    root.className = className;
    const blocksLayer = doc.createElement('div');
    blocksLayer.className = 'stme-home-blocks';
    const canvas = doc.createElement('canvas');
    canvas.className = 'stme-home-canvas';
    root.append(blocksLayer, canvas);

    const textures = new Map();   // id -> ключ (html + масштаб), на котором построена текущая текстура
    let attached = false;
    let size = { width: 1, height: 1 };
    let lastQuads = '';
    let canvasDpr = 0;           // масштаб, в котором сейчас размечен холст (физических пикселей на CSS-пиксель)
    let content = { width: 1, height: 1 };

    const dpr = () => Math.max(1, getDevicePixelRatio());
    /**
     * Масштаб холста: не больше `dpr` и такой, чтобы ни одна сторона не превысила `MAX_CANVAS_SIDE` физических пикселей — у мобильных видеокарт предел размера
     * буфера/текстуры 4096–8192, а прокручиваемое содержимое на телефоне (`contentHeight`) бывает в несколько экранов высотой (3× dpr → 7000+ px).
     */
    const canvasScale = () => Math.max(0.5, Math.min(dpr(), MAX_CANVAS_SIDE / Math.max(content.width, content.height, 1)));

    async function mount(parent) {
        parent.append(root);
        const result = await call('webglChat.attach', { canvas, width: size.width * canvasScale(), height: size.height * canvasScale() });
        attached = Boolean(result.ok && result.value);
        if (attached) canvasDpr = canvasScale();
        return attached;
    }

    /**
     * Прямоугольник сцены в окне (CSS-пиксели). `contentHeight` — высота ВСЕГО содержимого, если оно выше видимой части (телефон: сцена прокручивается, корень
     * получает `overflow-y: auto`, слои и холст — полную высоту содержимого). Холст пересоздаём и при смене размера, и при смене масштаба (`devicePixelRatio`,
     * потолок размера): иначе он остаётся в старом разрешении, а квады считаются по новому — WebGL-текст уезжает от плит. Текстуры перерастеризуются сами.
     */
    async function setRect({ left, top, width, height, contentHeight = height }) {
        Object.assign(root.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
        const fullH = Math.max(Math.round(height), Math.round(contentHeight));
        const scrolls = fullH > Math.round(height);
        root.style.overflowY = scrolls ? 'auto' : 'hidden';
        blocksLayer.style.height = `${fullH}px`;
        canvas.style.height = `${fullH}px`;
        canvas.style.width = `${Math.round(width)}px`;
        const next = { width: Math.max(1, Math.round(width)), height: Math.max(1, fullH) };
        const before = canvasDpr;
        content = next;
        const scale = canvasScale();
        const changed = next.width !== size.width || next.height !== size.height || scale !== before;
        size = next;
        if (attached && changed) {
            canvasDpr = scale;
            await call('webglChat.resize', { canvas, width: Math.round(size.width * scale), height: Math.round(size.height * scale) });
            lastQuads = '';
        }
    }

    /** Текстура тела блока; перерастеризуется, только если изменились HTML/размер/масштаб. Возвращает `true`, если текстура обновилась. */
    async function setBody(id, { html, width, height, css }) {
        const key = `${dpr()}|${width}x${height}|${html}|${css.length}`;
        if (textures.get(id) === key) return false;
        const raster = await call('htmlRasterizer.rasterize', { html, width, height, css, scale: dpr() });
        if (!raster.ok) return false;
        const upload = await call('webglChat.uploadTexture', { canvas, textureId: id, image: raster.value.image });
        if (!upload.ok) return false;
        textures.set(id, key);
        lastQuads = '';
        return true;
    }

    async function removeBody(id) {
        if (!textures.delete(id)) return;
        await call('webglChat.releaseTexture', { canvas, textureId: id });
        lastQuads = '';
    }

    /** Рисует кадр: по квадрату на блок (`placements` — CSS-пиксели сцены, квады — физические). Тот же кадр повторно не рисуется. */
    async function draw(placements) {
        if (!attached) return;
        const scale = canvasScale();
        const quads = placements.filter(p => textures.has(p.id)).map(p => ({ textureId: p.id, x: p.x * scale, y: p.y * scale, width: p.w * scale, height: p.h * scale }));
        const key = JSON.stringify(quads);
        if (key === lastQuads) return;
        lastQuads = key;
        await call('webglChat.drawFrame', { canvas, quads });
    }

    async function dispose() {
        for (const id of [...textures.keys()]) await removeBody(id);
        if (attached) await call('webglChat.detach', { canvas });
        attached = false;
        root.remove();
    }

    return { root, blocksLayer, canvas, mount, setRect, setBody, removeBody, draw, dispose, hasBody: id => textures.has(id), size: () => ({ ...size }) };
}
