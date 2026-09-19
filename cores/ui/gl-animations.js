import { request } from '../../libraries/shared/request.js';

/**
 * Ядро WebGL-анимаций — ОДНО место, которое решает КОГДА рисовать маленькие эффекты на канвасах: общий цикл кадров,
 * лимит FPS у каждого эффекта, условие активности, пауза при скрытой вкладке. Сам WebGL (шейдер, uniform'ы, draw)
 * делает Сервис `services/gl-animation.js`; здесь — только расписание и реестр.
 *
 * Чтобы добавить новый эффект, достаточно одного вызова (см. `cores/ui/activity-light-gl.js` — образец):
 *
 *     glAnimations.register({
 *         id: 'my-effect',
 *         canvas,                                   // готовый <canvas> в DOM
 *         fragment: 'void main(){ gl_FragColor = vec4(v, uT, 1.0); }',   // GLSL: v (0..1) и объявленные uniform'ы
 *         uniforms: { uT: 'float' },                // float | vec2 | vec3 | vec4
 *         fps: 30,                                  // потолок кадров в секунду (по умолчанию 30)
 *         values: ({ t, dt }) => ({ uT: t % 1 }),   // значения uniform'ов на кадр (t — секунды с запуска)
 *         isActive: () => true,                     // рисуем, только пока true (опрос раз в 500 мс)
 *         onStart, onStop,                          // колбэки на переходы активен/неактивен (например, класс на зоне)
 *     });
 *
 * Возвращает `{ dispose() }`. Если WebGL недоступен или шейдер не собрался — эффект НЕ стартует, `register()` вернёт
 * `{ ok: false }`, и вызывающий остаётся на статичном виде.
 */

const DEFAULT_FPS = 30;
const ACTIVE_POLL_MS = 500;

export function createGlAnimationsCore(host, {
    document: doc = globalThis.document,
    requestFrame = cb => globalThis.requestAnimationFrame(cb),
    cancelFrame = id => globalThis.cancelAnimationFrame(id),
    now = () => globalThis.performance.now(),
    setInterval: setIntervalFn = globalThis.setInterval,
    clearInterval: clearIntervalFn = globalThis.clearInterval,
} = {}) {
    const effects = new Map(); // id -> { def, glId, active, lastFrame, startedAt, lastTick }
    let rafId = null;
    let pollTimer = null;

    function anyActive() {
        for (const effect of effects.values()) if (effect.active) return true;
        return false;
    }

    function syncLoop() {
        if (anyActive() && !doc?.hidden) {
            if (rafId === null) rafId = requestFrame(tick);
        } else if (rafId !== null) {
            cancelFrame(rafId);
            rafId = null;
        }
    }

    function refreshActivity() {
        for (const effect of effects.values()) {
            const next = Boolean(effect.def.isActive ? effect.def.isActive() : true);
            if (next === effect.active) continue;
            effect.active = next;
            if (next) { effect.startedAt = now(); effect.lastTick = 0; effect.def.onStart?.(); } else effect.def.onStop?.();
        }
        syncLoop();
    }

    function tick(t) {
        rafId = requestFrame(tick);
        for (const effect of effects.values()) {
            if (!effect.active) continue;
            const interval = 1000 / (effect.def.fps ?? DEFAULT_FPS);
            if (t - effect.lastFrame < interval - 1) continue;
            const dt = effect.lastTick ? Math.min(0.1, (t - effect.lastTick) / 1000) : 0;
            effect.lastFrame = t;
            effect.lastTick = t;
            const ctx = { t: (t - effect.startedAt) / 1000, dt, now: t };
            const canvas = effect.def.canvas;
            const dpr = globalThis.devicePixelRatio || 1;
            const rect = canvas.getBoundingClientRect?.();
            request(host.services, 'glAnimation.draw', {
                params: {
                    id: effect.glId,
                    values: effect.def.values(ctx),
                    width: Math.round((rect?.width || canvas.width || 1) * dpr),
                    height: Math.round((rect?.height || canvas.height || 1) * dpr),
                },
            });
        }
    }

    async function register(def) {
        if (!def?.id || !def.canvas || !def.fragment || typeof def.values !== 'function') return { ok: false, error: 'invalid definition' };
        if (effects.has(def.id)) unregister(def.id);
        const created = await request(host.services, 'glAnimation.create', { params: { canvas: def.canvas, fragment: def.fragment, uniforms: def.uniforms ?? {} } });
        if (!created.ok || created.value == null) return { ok: false, error: 'WebGL unavailable' };
        effects.set(def.id, { def, glId: created.value, active: false, lastFrame: 0, startedAt: now(), lastTick: 0 });
        if (pollTimer === null) pollTimer = setIntervalFn(refreshActivity, ACTIVE_POLL_MS);
        refreshActivity();
        return { ok: true, dispose: () => unregister(def.id) };
    }

    function unregister(id) {
        const effect = effects.get(id);
        if (!effect) return false;
        if (effect.active) effect.def.onStop?.();
        effects.delete(id);
        request(host.services, 'glAnimation.destroy', { params: { id: effect.glId } });
        if (!effects.size && pollTimer !== null) { clearIntervalFn(pollTimer); pollTimer = null; }
        syncLoop();
        return true;
    }

    doc?.addEventListener?.('visibilitychange', syncLoop);

    host.own.register('glAnimations.register', def => register(def), { loadMetric: () => 0 });
    host.own.register('glAnimations.unregister', ({ id }) => unregister(id), { loadMetric: () => 0 });

    return {
        register,
        unregister,
        /** id зарегистрированных эффектов и признак, идёт ли сейчас цикл кадров — для отладки/тестов. */
        state: () => ({ ids: [...effects.keys()], running: rafId !== null, active: [...effects].filter(([, e]) => e.active).map(([id]) => id) }),
        refresh: refreshActivity,
    };
}
