/**
 * Сервис WebGL-анимаций — вся «сырая» работа с WebGL для маленьких эффектов на канвасе: компиляция фрагментного
 * шейдера, единый полноэкранный квад, задание uniform'ов и один draw-вызов на кадр. Ничего не планирует и не знает,
 * ЧТО рисует — расписание кадров, лимит FPS и условия активности живут в Ядре `cores/ui/gl-animations.js`.
 *
 * Контракты (все на servicesBus):
 * - `glAnimation.create({ canvas, fragment, uniforms })` → `id | null`. `fragment` — GLSL-тело фрагментного шейдера,
 *   доступны `varying vec2 v` (0..1, начало снизу слева) и объявленные uniform'ы; `uniforms` — `{ имя: 'float' | 'vec2'
 *   | 'vec3' | 'vec4' }`. `null` — WebGL недоступен или шейдер не собрался (вызывающий откатывается на статичный вид).
 * - `glAnimation.draw({ id, values, width, height })` — ставит значения (число или массив), при смене размера
 *   подгоняет backing store и рисует кадр. Прозрачный фон (premultiplied alpha).
 * - `glAnimation.destroy({ id })` — освобождает программу и буфер.
 */

const VERTEX = 'attribute vec2 p; varying vec2 v; void main(){ v = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }';

function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

export function registerGlAnimationService(servicesBus) {
    let nextId = 1;
    const animations = new Map(); // id -> { gl, program, buffer, locations, types, width, height }

    function create({ canvas, fragment, uniforms = {} } = {}) {
        const gl = canvas?.getContext?.('webgl', { alpha: true, premultipliedAlpha: true, antialias: false });
        if (!gl) return null;
        const declarations = Object.entries(uniforms).map(([name, type]) => `uniform ${type} ${name};`).join('\n');
        const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
        const fs = compile(gl, gl.FRAGMENT_SHADER, `precision mediump float;\nvarying vec2 v;\n${declarations}\n${fragment}`);
        if (!vs || !fs) return null;
        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
        gl.useProgram(program);
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        const attribute = gl.getAttribLocation(program, 'p');
        gl.enableVertexAttribArray(attribute);
        gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
        const locations = {};
        for (const name of Object.keys(uniforms)) locations[name] = gl.getUniformLocation(program, name);
        const id = nextId;
        nextId += 1;
        animations.set(id, { gl, program, buffer, locations, types: uniforms, width: 0, height: 0, canvas });
        return id;
    }

    function setUniform(gl, location, type, value) {
        const list = Array.isArray(value) ? value : [value];
        if (type === 'float') gl.uniform1f(location, list[0]);
        else if (type === 'vec2') gl.uniform2f(location, list[0], list[1]);
        else if (type === 'vec3') gl.uniform3f(location, list[0], list[1], list[2]);
        else if (type === 'vec4') gl.uniform4f(location, list[0], list[1], list[2], list[3]);
    }

    function draw({ id, values = {}, width, height } = {}) {
        const animation = animations.get(id);
        if (!animation) return false;
        const { gl, locations, types, canvas } = animation;
        const w = Math.max(1, Math.round(width || canvas.width || 1));
        const h = Math.max(1, Math.round(height || canvas.height || 1));
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        gl.viewport(0, 0, w, h);
        for (const [name, value] of Object.entries(values)) if (locations[name] != null) setUniform(gl, locations[name], types[name], value);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        return true;
    }

    function destroy({ id } = {}) {
        const animation = animations.get(id);
        if (!animation) return false;
        animation.gl.deleteProgram(animation.program);
        animation.gl.deleteBuffer(animation.buffer);
        animations.delete(id);
        return true;
    }

    const unregisters = [
        servicesBus.register('glAnimation.create', params => create(params), { loadMetric: () => 1 }),
        servicesBus.register('glAnimation.draw', params => draw(params), { loadMetric: () => 1 }),
        servicesBus.register('glAnimation.destroy', params => destroy(params), { loadMetric: () => 0 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}
