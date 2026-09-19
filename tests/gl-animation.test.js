import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerGlAnimationService } from '../services/gl-animation.js';
import { createGlAnimationsCore } from '../cores/ui/gl-animations.js';

function fakeGl() {
    const calls = [];
    const gl = {
        VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, ARRAY_BUFFER: 5, STATIC_DRAW: 6, FLOAT: 7, COLOR_BUFFER_BIT: 8, TRIANGLE_STRIP: 9,
        createShader: () => ({}), shaderSource: (_, src) => calls.push(['source', src]), compileShader() {}, getShaderParameter: () => true,
        createProgram: () => ({}), attachShader() {}, linkProgram() {}, getProgramParameter: () => true, useProgram() {},
        createBuffer: () => ({}), bindBuffer() {}, bufferData() {}, getAttribLocation: () => 0, enableVertexAttribArray() {}, vertexAttribPointer() {},
        getUniformLocation: (_, name) => name, viewport: (...a) => calls.push(['viewport', ...a]),
        uniform1f: (n, v) => calls.push(['u1', n, v]), uniform3f: (n, ...v) => calls.push(['u3', n, ...v]),
        clearColor() {}, clear() {}, drawArrays: () => calls.push(['draw']), deleteProgram: () => calls.push(['deleteProgram']), deleteBuffer() {},
    };
    return { gl, calls };
}

test('glAnimation service: create() compiles the fragment with declared uniforms, draw() sets values and renders, no WebGL -> null', async () => {
    const engine = createEngine();
    registerGlAnimationService(engine.buses.services);
    const { request } = await import('../libraries/shared/request.js');
    const caller = engine.registerCaller('test.caller', 'cores', { tier: 'official' });

    const { gl, calls } = fakeGl();
    const canvas = { width: 0, height: 0, getContext: () => gl };
    const created = await request(caller.services, 'glAnimation.create', { params: { canvas, fragment: 'void main(){}', uniforms: { uT: 'float', uC: 'vec3' } } });
    assert.ok(created.ok && Number.isInteger(created.value));
    assert.ok(calls.some(c => c[0] === 'source' && c[1].includes('uniform float uT;') && c[1].includes('uniform vec3 uC;')));

    await request(caller.services, 'glAnimation.draw', { params: { id: created.value, values: { uT: 0.5, uC: [1, 0, 0] }, width: 4, height: 40 } });
    assert.deepEqual(calls.filter(c => c[0] === 'u1'), [['u1', 'uT', 0.5]]);
    assert.deepEqual(calls.filter(c => c[0] === 'u3'), [['u3', 'uC', 1, 0, 0]]);
    assert.ok(calls.some(c => c[0] === 'draw'));
    assert.equal(canvas.width, 4);

    const none = await request(caller.services, 'glAnimation.create', { params: { canvas: { getContext: () => null }, fragment: '', uniforms: {} } });
    assert.equal(none.value, null);
});

test('glAnimations core: draws only while active, capped at the requested fps, and registers through the service', async () => {
    const engine = createEngine();
    const draws = [];
    engine.buses.services.register('glAnimation.create', () => 7);
    engine.buses.services.register('glAnimation.draw', params => { draws.push(params); return true; });
    engine.buses.services.register('glAnimation.destroy', () => true);
    let frameCallback = null;
    let active = false;
    const core = createGlAnimationsCore(engine.registerCaller('core.ui.glAnimations', 'cores', { tier: 'official' }), {
        document: { hidden: false, addEventListener() {} },
        requestFrame: cb => { frameCallback = cb; return 1; },
        cancelFrame: () => { frameCallback = null; },
        now: () => 0,
        setInterval: () => 1, clearInterval() {},
    });
    const canvas = { width: 4, height: 40, getBoundingClientRect: () => ({ width: 4, height: 40 }) };
    const result = await core.register({ id: 'fx', canvas, fragment: 'void main(){}', uniforms: { uT: 'float' }, fps: 30, isActive: () => active, values: ({ t }) => ({ uT: t }) });
    assert.equal(result.ok, true);

    assert.equal(frameCallback, null, 'inactive: no frame loop');
    active = true;
    core.refresh();
    assert.ok(frameCallback, 'active: loop starts');
    frameCallback(100); await new Promise(r => setTimeout(r, 0));
    frameCallback(110); await new Promise(r => setTimeout(r, 0));   // 10 мс — слишком рано для 30 fps
    frameCallback(140); await new Promise(r => setTimeout(r, 0));   // 40 мс — можно
    assert.equal(draws.length, 2, 'the 10ms tick was skipped by the fps cap');
    active = false;
    core.refresh();
    assert.equal(frameCallback, null, 'deactivated: loop stops');
});
