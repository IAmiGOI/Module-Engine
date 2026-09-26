/**
 * Сцена главного экрана: контейнер на всё окно с ДВУМЯ слоями — снизу DOM блоков (плиты, аватары, кнопки), сверху прозрачный WebGL-канвас с
 * текстом блоков (`pointer-events: none`, поэтому клики доходят до DOM под ним). Тело блока — растр HTML (`htmlRasterizer`), тот же путь и тот же
 * рендерер (`webglChat`), что у тел сообщений в Chat Viewport; текстура перерисовывается ТОЛЬКО когда изменился HTML блока.
 *
 * Перетаскивание блока — это не растеризация: меняется только `transform` DOM-узла и позиция квада, кадр рисуется одним `drawFrame`.
 * Браузерное (`document`, `devicePixelRatio`) — инъекцией; вызовы сервисов — через `call(contract, params)` → `{ ok, value }`.
 */
export function createHomeScene({ document: doc = globalThis.document, call, getDevicePixelRatio = () => globalThis.devicePixelRatio || 1 }) {
    const root = doc.createElement('div');
    root.className = 'stme-home';
    const blocksLayer = doc.createElement('div');
    blocksLayer.className = 'stme-home-blocks';
    const canvas = doc.createElement('canvas');
    canvas.className = 'stme-home-canvas';
    root.append(blocksLayer, canvas);

    const textures = new Map();   // id -> ключ (html + масштаб), на котором построена текущая текстура
    let attached = false;
    let size = { width: 1, height: 1 };
    let lastQuads = '';
    let canvasDpr = 0;           // масштаб, в котором сейчас размечен холст

    const dpr = () => Math.max(1, getDevicePixelRatio());

    async function mount(parent) {
        parent.append(root);
        const result = await call('webglChat.attach', { canvas, width: size.width * dpr(), height: size.height * dpr() });
        attached = Boolean(result.ok && result.value);
        if (attached) canvasDpr = dpr();
        return attached;
    }

    /** Прямоугольник сцены в окне (CSS-пиксели). Канвас пересоздаёт размер по физическим пикселям. */
    async function setRect({ left, top, width, height }) {
        Object.assign(root.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
        // Пересоздаём холст и при смене размера, и при смене `devicePixelRatio` (масштаб страницы, другой монитор): иначе холст остаётся в старом разрешении, а
        // квады считаются по новому — WebGL-текст уезжает от плит (найдено живьём). Текстуры перерастеризуются сами: масштаб входит в их ключ.
        const changed = Math.round(width) !== size.width || Math.round(height) !== size.height || dpr() !== canvasDpr;
        size = { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
        if (attached && changed) {
            canvasDpr = dpr();
            await call('webglChat.resize', { canvas, width: size.width * canvasDpr, height: size.height * canvasDpr });
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
        const scale = dpr();
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
