/**
 * Сервис WebGL-рендера тела сообщения — GPU-изолированная поверхность, ради
 * которой затевалась гибридная архитектура Chat Viewport (план
 * `chat-viewport`): владелец проверил, что анимация рядом с DOM чата в этом
 * окружении форсирует полный reflow без обхода (см. память
 * `feedback-no-animated-effects-reflow`), поэтому тело сообщения (и любые
 * будущие эффекты над ним — подсветка, пульс) рисуется здесь, а не в DOM.
 *
 * Владеет ТОЛЬКО композитингом уже готовых текстур — сами текстуры даёт
 * [services/html-rasterizer.js](html-rasterizer.js) (растеризация HTML через
 * `foreignObject`), сам `<canvas>` создаётся и монтируется Ядром обычным
 * путём (`dom.createElement({tag:'canvas'})` → `h()`/diff.js, `canvas` — не
 * SVG-тег, значит обычный `document.createElement`), а этот Сервис лишь
 * привязывает к уже существующему DOM-узлу WebGL-контекст и рисует в него —
 * тот же разрез "Сервис не решает WHAT/WHERE, только HOW", что у остального
 * движка.
 *
 * Состояние (GL-контекст/программа/буфер/карта текстур) держится в
 * `WeakMap`, ключ — сам `<canvas>` DOM-узел: тот же приём, что `dom.js`'s
 * `resizeObservers`, чтобы Сервис не тёк памятью, если Ядро выбросит канвас
 * без явного `detach()`.
 *
 * `createContext` инжектируется (реальный `canvas.getContext('webgl2')`
 * недоступен в Node) — тот же приём, что `rasterizeToImage` в
 * html-rasterizer.js и `decodeImageToPixels` в modules/map/index.js.
 */

/** Простейший шейдер: текстурированный прямоугольник, один uniform `uOpacity` — эффекты (пульс/подсветка) позже становятся ДОПОЛНИТЕЛЬНЫМИ uniform'ами здесь же, не новым проходом рендера. */
const VERTEX_SHADER_SRC = `
attribute vec2 aPosition;
attribute vec2 aUv;
varying vec2 vUv;
void main() {
    vUv = aUv;
    gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const FRAGMENT_SHADER_SRC = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTexture;
uniform float uOpacity;
void main() {
    vec4 color = texture2D(uTexture, vUv);
    gl_FragColor = vec4(color.rgb, color.a * uOpacity);
}`;

/**
 * Пиксельный прямоугольник (`{x, y, width, height}`, y растёт вниз, как в
 * DOM) + размер канваса → 6 вершин (два треугольника) в clip-space (-1..1,
 * y растёт вверх — отсюда переворот) с UV. Чистая функция — тестируется как
 * данные, ни одного вызова WebGL внутри.
 */
export function computeQuadVertices(rect, canvasWidth, canvasHeight) {
    const w = Math.max(1, Number(canvasWidth) || 1);
    const h = Math.max(1, Number(canvasHeight) || 1);
    const x0 = (Number(rect?.x) || 0) / w * 2 - 1;
    const x1 = ((Number(rect?.x) || 0) + (Number(rect?.width) || 0)) / w * 2 - 1;
    const y0 = 1 - (Number(rect?.y) || 0) / h * 2;
    const y1 = 1 - ((Number(rect?.y) || 0) + (Number(rect?.height) || 0)) / h * 2;
    return new Float32Array([
        x0, y0, 0, 0,
        x1, y0, 1, 0,
        x0, y1, 0, 1,
        x1, y0, 1, 0,
        x1, y1, 1, 1,
        x0, y1, 0, 1,
    ]);
}

function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog?.(shader) ?? '';
        gl.deleteShader(shader);
        throw new Error(`webgl-renderer: shader compile failed — ${log}`);
    }
    return shader;
}

function createProgram(gl) {
    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SRC);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC);
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog?.(program) ?? '';
        gl.deleteProgram(program);
        throw new Error(`webgl-renderer: program link failed — ${log}`);
    }
    return program;
}

function defaultCreateContext(canvas) {
    return canvas.getContext('webgl2') ?? canvas.getContext('webgl') ?? null;
}

const attachments = new WeakMap(); // canvas -> { gl, program, buffer, positionLoc, uvLoc, opacityLoc, samplerLoc, textures: Map(id -> WebGLTexture) }

/** `false` — не исключение — на отсутствии WebGL (старый браузер, отключено флагом): Ядро решает, откатываться ли на нативный чат, а не ловит catch на каждый вызов. */
function attach(canvas, width, height, createContext) {
    if (!canvas) return false;
    const gl = createContext(canvas);
    if (!gl) return false;

    canvas.width = Math.max(1, Math.round(Number(width) || 0));
    canvas.height = Math.max(1, Math.round(Number(height) || 0));
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const program = createProgram(gl);
    gl.useProgram(program);
    const buffer = gl.createBuffer();

    attachments.set(canvas, {
        gl,
        program,
        buffer,
        positionLoc: gl.getAttribLocation(program, 'aPosition'),
        uvLoc: gl.getAttribLocation(program, 'aUv'),
        opacityLoc: gl.getUniformLocation(program, 'uOpacity'),
        samplerLoc: gl.getUniformLocation(program, 'uTexture'),
        textures: new Map(),
    });
    return true;
}

function detach(canvas) {
    const state = attachments.get(canvas);
    if (!state) return false;
    for (const texture of state.textures.values()) state.gl.deleteTexture(texture);
    attachments.delete(canvas);
    return true;
}

function resize(canvas, width, height) {
    const state = attachments.get(canvas);
    if (!state) return false;
    canvas.width = Math.max(1, Math.round(Number(width) || 0));
    canvas.height = Math.max(1, Math.round(Number(height) || 0));
    state.gl.viewport(0, 0, canvas.width, canvas.height);
    return true;
}

/** `textureId` реиспользуется как ключ на повторную загрузку (правка сообщения, новый токен стрима) — новый `WebGLTexture` создаётся только для НОВОГО id, не на каждый вызов. */
function uploadTexture(canvas, textureId, image) {
    const state = attachments.get(canvas);
    if (!state || !image) return false;
    const { gl } = state;
    let texture = state.textures.get(textureId);
    if (!texture) {
        texture = gl.createTexture();
        state.textures.set(textureId, texture);
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return true;
}

function releaseTexture(canvas, textureId) {
    const state = attachments.get(canvas);
    const texture = state?.textures.get(textureId);
    if (!texture) return false;
    state.gl.deleteTexture(texture);
    state.textures.delete(textureId);
    return true;
}

/**
 * `quads` — `[{ textureId, x, y, width, height, opacity? }]`, в ПИКСЕЛЯХ
 * канваса, y вниз (как везде в DOM — Ядро не должно пересчитывать в
 * clip-space само). Квад, чья текстура ещё не загружена (сообщение всё ещё
 * растеризуется), молча пропускается на ЭТОМ кадре — не ошибка, следующий
 * `drawFrame()` после `uploadTexture()` дорисует его.
 */
function drawFrame(canvas, quads) {
    const state = attachments.get(canvas);
    if (!state) return false;
    const { gl, buffer, positionLoc, uvLoc, opacityLoc, samplerLoc, textures, program } = state;

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);

    for (const quad of quads ?? []) {
        const texture = textures.get(quad?.textureId);
        if (!texture) continue;
        const vertices = computeQuadVertices(quad, canvas.width, canvas.height);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(positionLoc);
        gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 16, 0);
        gl.enableVertexAttribArray(uvLoc);
        gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(samplerLoc, 0);
        gl.uniform1f(opacityLoc, Number.isFinite(quad.opacity) ? quad.opacity : 1);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    return true;
}

export function registerWebglRendererService(servicesBus, { createContext = defaultCreateContext } = {}) {
    const unregisters = [
        servicesBus.register('webglChat.attach', ({ canvas, width, height }) => attach(canvas, width, height, createContext), { loadMetric: () => 0 }),
        servicesBus.register('webglChat.detach', ({ canvas }) => detach(canvas), { loadMetric: () => 0 }),
        servicesBus.register('webglChat.resize', ({ canvas, width, height }) => resize(canvas, width, height), { loadMetric: () => 0 }),
        servicesBus.register('webglChat.uploadTexture', ({ canvas, textureId, image }) => uploadTexture(canvas, textureId, image), { loadMetric: () => 1 }),
        servicesBus.register('webglChat.releaseTexture', ({ canvas, textureId }) => releaseTexture(canvas, textureId), { loadMetric: () => 0 }),
        servicesBus.register('webglChat.drawFrame', ({ canvas, quads }) => drawFrame(canvas, quads), { loadMetric: () => 1 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}

/** Exported for the unit-level fake-GL coverage in tests/webgl-renderer-service.test.js, independent of the contract/Gate plumbing. */
export const webglRendererOperations = { computeQuadVertices, attach, detach, resize, uploadTexture, releaseTexture, drawFrame };
