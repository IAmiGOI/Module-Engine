import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerWebglRendererService, webglRendererOperations, computeQuadVertices } from '../services/webgl-renderer.js';

// --- Unit level: computeQuadVertices is pure — pixel rect + canvas size in, clip-space vertices out ---

test('computeQuadVertices maps a rect filling the whole canvas to the full clip-space square (-1..1)', () => {
    const vertices = computeQuadVertices({ x: 0, y: 0, width: 100, height: 100 }, 100, 100);
    // 6 vertices * (x,y,u,v) = 24 numbers.
    assert.equal(vertices.length, 24);
    // First vertex: top-left in pixel space (0,0) -> clip-space top-left (-1, 1), uv (0,0).
    assert.deepEqual([...vertices.slice(0, 4)], [-1, 1, 0, 0]);
    // Second vertex: top-right pixel (100,0) -> clip-space (1, 1), uv (1,0).
    assert.deepEqual([...vertices.slice(4, 8)], [1, 1, 1, 0]);
});

test('computeQuadVertices flips Y — pixel-space grows down, clip-space grows up', () => {
    // A rect pinned to the BOTTOM of a 200-tall canvas must land in the LOWER half of clip space (negative Y).
    const vertices = computeQuadVertices({ x: 0, y: 100, width: 50, height: 100 }, 50, 200);
    const ys = [vertices[1], vertices[5], vertices[9], vertices[13], vertices[17], vertices[21]];
    assert.ok(ys.every(y => y <= 0), `expected every Y to be <= 0 for a bottom-pinned rect, got ${ys}`);
});

test('computeQuadVertices guards against a zero-size canvas rather than dividing by zero into Infinity/NaN', () => {
    const vertices = computeQuadVertices({ x: 0, y: 0, width: 10, height: 10 }, 0, 0);
    assert.ok([...vertices].every(Number.isFinite), 'no coordinate may be Infinity/NaN even with a degenerate canvas size');
});

// --- Fake GL context — enough of the real WebGL surface to drive attach/upload/draw, none of the actual rendering ---

function makeFakeCanvas() {
    return { width: 0, height: 0 };
}

function makeFakeGl() {
    const calls = [];
    let shaderCounter = 0;
    let textureCounter = 0;
    const gl = {
        VERTEX_SHADER: 'VERTEX_SHADER', FRAGMENT_SHADER: 'FRAGMENT_SHADER',
        COMPILE_STATUS: 'COMPILE_STATUS', LINK_STATUS: 'LINK_STATUS',
        BLEND: 'BLEND', SRC_ALPHA: 'SRC_ALPHA', ONE_MINUS_SRC_ALPHA: 'ONE_MINUS_SRC_ALPHA',
        ARRAY_BUFFER: 'ARRAY_BUFFER', DYNAMIC_DRAW: 'DYNAMIC_DRAW', FLOAT: 'FLOAT',
        TEXTURE_2D: 'TEXTURE_2D', TEXTURE0: 'TEXTURE0', RGBA: 'RGBA', UNSIGNED_BYTE: 'UNSIGNED_BYTE',
        TEXTURE_WRAP_S: 'TEXTURE_WRAP_S', TEXTURE_WRAP_T: 'TEXTURE_WRAP_T', CLAMP_TO_EDGE: 'CLAMP_TO_EDGE',
        TEXTURE_MIN_FILTER: 'TEXTURE_MIN_FILTER', TEXTURE_MAG_FILTER: 'TEXTURE_MAG_FILTER', LINEAR: 'LINEAR',
        COLOR_BUFFER_BIT: 'COLOR_BUFFER_BIT', TRIANGLES: 'TRIANGLES',
        createShader: type => ({ __shader: shaderCounter += 1, type }),
        shaderSource: () => {},
        compileShader: () => {},
        getShaderParameter: () => true,
        deleteShader: () => {},
        createProgram: () => ({ __program: true }),
        attachShader: () => {},
        linkProgram: () => {},
        getProgramParameter: () => true,
        useProgram: () => calls.push(['useProgram']),
        createBuffer: () => ({ __buffer: true }),
        getAttribLocation: (_p, name) => name,
        getUniformLocation: (_p, name) => name,
        enable: () => {},
        blendFunc: () => {},
        viewport: (...args) => calls.push(['viewport', ...args]),
        createTexture: () => ({ __texture: textureCounter += 1 }),
        deleteTexture: texture => calls.push(['deleteTexture', texture]),
        bindTexture: (_t, texture) => calls.push(['bindTexture', texture]),
        texImage2D: (...args) => calls.push(['texImage2D', args[args.length - 1]]),
        texParameteri: () => {},
        clearColor: () => {},
        clear: () => calls.push(['clear']),
        bindBuffer: () => {},
        bufferData: (_target, data) => calls.push(['bufferData', data]),
        enableVertexAttribArray: () => {},
        vertexAttribPointer: () => {},
        activeTexture: () => {},
        uniform1i: () => {},
        uniform1f: (_loc, value) => calls.push(['uniform1f', value]),
        drawArrays: () => calls.push(['drawArrays']),
    };
    return { gl, calls };
}

test('attach() returns false without throwing when the platform has no WebGL at all', () => {
    const canvas = makeFakeCanvas();
    const ok = webglRendererOperations.attach(canvas, 100, 100, () => null);
    assert.equal(ok, false);
});

test('attach() sizes the canvas drawing buffer and sets up the GL program', () => {
    const canvas = makeFakeCanvas();
    const { gl, calls } = makeFakeGl();

    const ok = webglRendererOperations.attach(canvas, 320.7, 200.2, () => gl);

    assert.equal(ok, true);
    assert.equal(canvas.width, 321);
    assert.equal(canvas.height, 200);
    assert.deepEqual(calls.find(c => c[0] === 'viewport'), ['viewport', 0, 0, 321, 200]);
});

test('uploadTexture() creates one texture per NEW textureId, and reuses it on a second upload for the same id (e.g. a streaming re-rasterization)', () => {
    const canvas = makeFakeCanvas();
    const { gl, calls } = makeFakeGl();
    webglRendererOperations.attach(canvas, 100, 100, () => gl);
    const fakeImage = { __image: true };

    webglRendererOperations.uploadTexture(canvas, 'mesid-1', fakeImage);
    webglRendererOperations.uploadTexture(canvas, 'mesid-1', fakeImage);

    const texImageCalls = calls.filter(c => c[0] === 'texImage2D');
    assert.equal(texImageCalls.length, 2, 'both uploads must call texImage2D (content changed on re-rasterization)');
    assert.equal(texImageCalls[0][1], fakeImage);

    const bindCalls = calls.filter(c => c[0] === 'bindTexture').map(c => c[1]);
    assert.equal(bindCalls[0], bindCalls[1], 'the SECOND upload for the same mesid must reuse the same WebGLTexture object, not allocate a new one');
});

test('uploadTexture() before attach() is a harmless no-op, not a throw', () => {
    const canvas = makeFakeCanvas();
    assert.equal(webglRendererOperations.uploadTexture(canvas, 'mesid-1', {}), false);
});

test('drawFrame() silently skips a quad whose texture has not been uploaded yet — a message still rasterizing must not crash the frame', () => {
    const canvas = makeFakeCanvas();
    const { gl, calls } = makeFakeGl();
    webglRendererOperations.attach(canvas, 100, 100, () => gl);

    const ok = webglRendererOperations.drawFrame(canvas, [{ textureId: 'not-uploaded-yet', x: 0, y: 0, width: 50, height: 50 }]);

    assert.equal(ok, true);
    assert.equal(calls.some(c => c[0] === 'drawArrays'), false);
});

test('drawFrame() draws exactly one quad per uploaded texture, passing its opacity through as a uniform', () => {
    const canvas = makeFakeCanvas();
    const { gl, calls } = makeFakeGl();
    webglRendererOperations.attach(canvas, 100, 100, () => gl);
    webglRendererOperations.uploadTexture(canvas, 'a', {});
    webglRendererOperations.uploadTexture(canvas, 'b', {});

    webglRendererOperations.drawFrame(canvas, [
        { textureId: 'a', x: 0, y: 0, width: 50, height: 50, opacity: 0.5 },
        { textureId: 'b', x: 0, y: 50, width: 50, height: 50 },
    ]);

    assert.equal(calls.filter(c => c[0] === 'drawArrays').length, 2);
    const opacities = calls.filter(c => c[0] === 'uniform1f').map(c => c[1]);
    assert.deepEqual(opacities, [0.5, 1], 'a quad with no explicit opacity must default to fully opaque (1), not 0/undefined');
});

test('releaseTexture() deletes the GL texture and forgets it, so a later drawFrame() referencing it skips the quad again', () => {
    const canvas = makeFakeCanvas();
    const { gl, calls } = makeFakeGl();
    webglRendererOperations.attach(canvas, 100, 100, () => gl);
    webglRendererOperations.uploadTexture(canvas, 'a', {});

    const released = webglRendererOperations.releaseTexture(canvas, 'a');

    assert.equal(released, true);
    assert.ok(calls.some(c => c[0] === 'deleteTexture'));
    calls.length = 0;
    webglRendererOperations.drawFrame(canvas, [{ textureId: 'a', x: 0, y: 0, width: 10, height: 10 }]);
    assert.equal(calls.some(c => c[0] === 'drawArrays'), false);
});

test('detach() deletes every remaining texture and forgets the canvas entirely — a later drawFrame() is then a no-op, not a crash on stale state', () => {
    const canvas = makeFakeCanvas();
    const { gl, calls } = makeFakeGl();
    webglRendererOperations.attach(canvas, 100, 100, () => gl);
    webglRendererOperations.uploadTexture(canvas, 'a', {});

    const detached = webglRendererOperations.detach(canvas);

    assert.equal(detached, true);
    assert.equal(webglRendererOperations.drawFrame(canvas, []), false);
});

// --- Contract level: registerWebglRendererService() wires all 6 contracts through the real engine/Gate ---

function buildService(createContext) {
    const engine = createEngine();
    registerWebglRendererService(engine.buses.services, { createContext });
    const caller = engine.registerCaller('module.probe', 'modules', {
        tier: 'community',
        allowedContracts: ['webglChat.attach', 'webglChat.uploadTexture', 'webglChat.drawFrame'],
    });
    return { engine, caller };
}

function call(caller, contract, params) {
    return new Promise(resolve => caller.services.subscribe(contract, { params }, resolve));
}

test('registerWebglRendererService() wires attach/uploadTexture/drawFrame as real, Gate-checked contracts', async () => {
    const { gl } = makeFakeGl();
    const canvas = makeFakeCanvas();
    const { caller } = buildService(() => gl);

    const attached = await call(caller, 'webglChat.attach', { canvas, width: 100, height: 100 });
    assert.equal(attached.ok, true);
    assert.equal(attached.value, true);

    const uploaded = await call(caller, 'webglChat.uploadTexture', { canvas, textureId: '0', image: {} });
    assert.equal(uploaded.value, true);

    const drawn = await call(caller, 'webglChat.drawFrame', { canvas, quads: [{ textureId: '0', x: 0, y: 0, width: 10, height: 10 }] });
    assert.equal(drawn.value, true);
});
