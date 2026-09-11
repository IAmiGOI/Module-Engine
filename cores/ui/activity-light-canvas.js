import { effect } from './reactive.js';

/**
 * Canvas-полоска Светофора активности — замена CSS-градиента на ::before
 * пилюли ([panel.css](../../harness/panel.css)). Причина переноса: repaint
 * полоски в paint-конвейере DOM пересчитывал backdrop-filter стекла пилюли
 * каждый кадр (живой замер 2026-09-09: ~80% GPU, doc-comment у ::after).
 *
 * ВТОРАЯ ИТЕРАЦИЯ (2026-09-11, после живой проверки архитектора): первая
 * версия канваса нагрузку НЕ сняла — PaintFlashing подсвечивал весь фон.
 * Причина: каждый кадр здесь рисовался ТЯЖЁЛЫМ путём — createLinearGradient
 * + shadowBlur + roundRect заново, 60 раз в секунду, и растеризация этого
 * добра (особенно shadowBlur — Gauss на CPU) стоила столько же, сколько
 * старый paint. Теперь кадр — ОДИН drawImage готового спрайта:
 *
 * - Спрайт полоски (градиент + скругление + свечение) пре-рендерится
 *   ОДИН РАЗ на цвет в offscreen-canvas и кэшируется (6 состояний = ≤6
 *   спрайтов). Смена цвета — кроссфейд двух готовых спрайтов, не перерисовка.
 * - Переливка — бегущий белый блик (тоже готовый спрайт), alpha по фазе.
 * - rAF стоит, когда вкладка скрыта (visibilitychange) — как и раньше
 *   «сворачивание браузера снимало нагрузку», только теперь это нормально,
 *   а не счастливое совпадение.
 * - Кадры каплены на ~30fps: для 4px полоски 60 кадров — чистый перерасход.
 *
 * ГЕОМЕТРИЯ. CSS ставит канвас с запасом PAD=14px со всех сторон полоски
 * (левее пилюли на 14px, чтобы свечение жило В ЗАПАСЕ, а не обрезалось).
 * Сама полоска 4px, как прежний ::before. Размеры — через ResizeObserver:
 * первый вариант с разовым resize() поймал живой баг «полоска не видна»
 * (rect 0×0 при монтировании до layout).
 */

const STATE_COLORS = {
    idle: '#5b8dff',
    working: '#e8a13c',
    success: '#4fae7f',
    warning: '#d9c545',
    error: '#e5453f',
    notify: '#ffffff',
};

const STRIP_CSS_PX = 4; // ширина полоски — как было у ::before
const PAD_CSS_PX = 14;  // запас канваса под свечение (глубже старых box-shadow 10-14px)

const SHIMMER_PERIOD_MS = 3000;
const NOTIFY_BLINKS = 3;
const NOTIFY_BLINK_MS = 900;  // был animation: stme-dock-blink .9s steps(1) 3
const FRAME_BUDGET_MS = 1000 / 30; // 30fps — для 4px полоски за глазами хватает

export function createActivityLightCanvas(activityState, {
    document: doc = document,
    requestFrame = cb => requestAnimationFrame(cb),
    cancelFrame = id => cancelAnimationFrame(id),
    now = () => performance.now(),
} = {}) {
    const canvas = doc.createElement('canvas');
    canvas.className = 'stme-activity-light-canvas';
    const ctx = canvas.getContext('2d');

    let rafId = null;
    let running = false;
    let lastFrameAt = 0;
    let dpr = 1; // БЕЗ объявления resize() падал в ReferenceError — init умирал молча, UI пропадал целиком (инцидент 11.09)
    let current = STATE_COLORS[activityState.peek()] ?? STATE_COLORS.idle;
    let previous = current;
    let colorChangedAt = now();
    let blinkStart = 0; // 0 — мигание не активно
    let W = 0, H = 0;   // device-пиксели канваса

    /** steps(1): половину шага «погашена», половину «горит»; 3 шага — конец. */
    function notifyBlinkFactor(t) {
        if (!blinkStart) return 1;
        const elapsed = t - blinkStart;
        if (elapsed >= NOTIFY_BLINKS * NOTIFY_BLINK_MS) { blinkStart = 0; return 1; }
        return (elapsed % NOTIFY_BLINK_MS) < NOTIFY_BLINK_MS / 2 ? 0.15 : 1;
    }

    function mix(a, b, k) {
        const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
        const ch = shift => Math.round(((pa >> shift & 255) * (1 - k)) + ((pb >> shift & 255) * k));
        return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
    }

    /** Кэш готовых спрайтов: цвет -> offscreen canvas с полоской+свечением. */
    const sprites = new Map();
    function spriteFor(color) {
        let sprite = sprites.get(color);
        if (sprite) return sprite;
        sprite = document.createElement('canvas');
        sprite.width = W; sprite.height = H;
        const sctx = sprite.getContext('2d');
        const x = PAD_CSS_PX * (doc.defaultView?.devicePixelRatio || 1);
        const y = PAD_CSS_PX * (doc.defaultView?.devicePixelRatio || 1);
        const w = STRIP_CSS_PX * (doc.defaultView?.devicePixelRatio || 1);
        const h = H - 2 * y;
        // Тот же градиент, что был в CSS: базовый → светлее → темнее → базовый.
        const grad = sctx.createLinearGradient(0, y, 0, y + h);
        grad.addColorStop(0, color);
        grad.addColorStop(0.25, mix(color, '#ffffff', 0.55));
        grad.addColorStop(0.5, mix(color, '#000000', 0.7));
        grad.addColorStop(1, color);
        sctx.shadowColor = color;
        sctx.shadowBlur = PAD_CSS_PX * (doc.defaultView?.devicePixelRatio || 1);
        sctx.fillStyle = grad;
        sctx.beginPath();
        sctx.roundRect(x, y, w, h, w / 2);
        sctx.fill();
        sprites.set(color, sprite);
        return sprite;
    }

    /** Готовый блик для переливки: вертикальная белая полоска с мягкими краями. */
    let highlightSprite = null;
    function spriteHighlight() {
        if (highlightSprite && highlightSprite.height === H) return highlightSprite;
        highlightSprite = document.createElement('canvas');
        highlightSprite.width = W; highlightSprite.height = H;
        const sctx = highlightSprite.getContext('2d');
        const x = PAD_CSS_PX * (doc.defaultView?.devicePixelRatio || 1);
        const w = STRIP_CSS_PX * (doc.defaultView?.devicePixelRatio || 1);
        const grad = sctx.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0, 'rgba(255,255,255,0)');
        grad.addColorStop(0.5, 'rgba(255,255,255,.85)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        sctx.fillStyle = grad;
        sctx.beginPath();
        sctx.roundRect(x, 0, w, H, w / 2);
        sctx.fill();
        return highlightSprite;
    }

    /** Один кадр = два drawImage (кроссфейд цвета + бегущий блик). Больше ничего. */
    function draw(t) {
        if (!W || !H) return;
        ctx.clearRect(0, 0, W, H);

        const fadeK = Math.min(1, (t - colorChangedAt) / 350);
        if (fadeK < 1 && previous !== current) {
            ctx.globalAlpha = 1 - fadeK;
            ctx.drawImage(spriteFor(previous), 0, 0);
            ctx.globalAlpha = fadeK;
            ctx.drawImage(spriteFor(current), 0, 0);
        } else {
            ctx.drawImage(spriteFor(current), 0, 0);
        }

        // Переливка: блик едет сверху вниз, плотность колоколом по фазе.
        const phase = (t % SHIMMER_PERIOD_MS) / SHIMMER_PERIOD_MS;
        const bell = Math.sin(phase * Math.PI);
        if (bell > 0.05) {
            ctx.globalAlpha = 0.35 * bell;
            ctx.drawImage(spriteHighlight(), 0, 0);
        }

        ctx.globalAlpha = notifyBlinkFactor(t);
        if (notifyBlinkFactor(t) < 1) {
            // Мигание — гашение ВСЕГО кадра: поверх рисуем прозрачность,
            // очищая и перерисовывая с приглушением (globalAlpha выше уже
            // установлен, но рисовать больше нечего — гасим через.clearRect
            // + перерисовку спрайта с пониженной alpha).
            ctx.clearRect(0, 0, W, H);
            ctx.globalAlpha = 0.15 * notifyBlinkFactor(t);
            ctx.drawImage(spriteFor(current), 0, 0);
        }
        ctx.globalAlpha = 1;
    }

    function frame() {
        rafId = null;
        const t = now();
        if (t - lastFrameAt >= FRAME_BUDGET_MS - 1) {
            lastFrameAt = t;
            draw(t);
        }
        if (running) rafId = requestFrame(frame);
    }

    function start() {
        if (running) return;
        running = true;
        rafId = requestFrame(frame);
    }

    function stop() {
        running = false;
        if (rafId !== null) { cancelFrame(rafId); rafId = null; }
    }

    function resize() {
        dpr = doc.defaultView?.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        const w = Math.max(1, Math.round((rect.width || 32) * dpr));
        const h = Math.max(1, Math.round((rect.height || 260) * dpr));
        if (canvas.width !== w || canvas.height !== h) {
            W = w; H = h;
            canvas.width = w;
            canvas.height = h;
            sprites.clear();          // спрайты зависят от размера — пересобрать
            highlightSprite = null;
            if (!running) draw(now());
        }
    }

    const observer = typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => resize())
        : null;
    if (observer) observer.observe(canvas);

    const disposeEffect = effect(() => {
        const state = activityState();
        const next = STATE_COLORS[state] ?? STATE_COLORS.idle;
        if (next !== current) {
            previous = current;
            current = next;
            colorChangedAt = now();
            if (state === 'notify' && !blinkStart) blinkStart = now();
        }
    });

    // Скрытая вкладка — rAF не нужен: пиксели всё равно никто не видит.
    const onVisibility = () => { if (doc.hidden) stop(); else start(); };
    doc.addEventListener('visibilitychange', onVisibility);

    start();

    return {
        element: canvas,
        resize,
        start,
        stop,
        dispose: () => {
            disposeEffect();
            observer?.disconnect();
            doc.removeEventListener('visibilitychange', onVisibility);
            stop();
        },
    };
}