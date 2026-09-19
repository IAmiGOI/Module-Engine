import { effect } from './reactive.js';

/**
 * Светофор активности пилюли-дока: покраска ЗОНЫ классом stme-light-<state>
 * по сигналу Ядра (cores/ui/activity-light.js). Возвращает статичную
 * DOM-полоску (::before в panel.css): градиент и свечение живут в CSS на
 * переменной --stme-light, которую перекрашивают классы состояний — обычный
 * `transition`, без бесконечного `animation`.
 *
 * ПОЧЕМУ ВЕРНУЛИСЬ ОТ CANVAS (11.09, решение архитектора): канвас-версия
 * (activity-light-canvas.js) по замерам всё равно красила пол-окна каждый
 * кадр — ЛЮБОЙ canvas в DOM в этом окружении (Thorium 138) инвалидирует
 * paint вверх по дереву. Финальная схема: статичный градиент без
 * анимации + смена цвета только классом состояния. «Переливка» больше не
 * рисуется вовсе — полоска стала чистым индикатором-светофором.
 *
 * При смене состояния класс-строка целиком заменяется, так что конечные
 * состояния (success/warning/error/notify) честно возвращаются к idle,
 * когда Ядро вернёт сигнал.
 */
export function createActivityLightDom(zone, activityState) {
    // Бегущая переливка: `transform` (только композитор, без перерисовки и без шейдера) — см. `.stme-light-flow-strip`
    // в panel.css. Включается CSS'ом, пока активен Chat Viewport; сам элемент создаётся один раз.
    const dock = zone.querySelector?.('.stme-launcher-dock');
    let flow = null;
    if (dock && zone.ownerDocument) {
        flow = zone.ownerDocument.createElement('div');
        flow.className = 'stme-light-flow-strip';
        flow.append(zone.ownerDocument.createElement('div'));
        flow.firstChild.className = 'stme-light-flow';
        // Полоска — ребёнок ЗОНЫ, а не дока: док — скруглённый `overflow: hidden` с размытым стеклом, и всё анимированное
        // внутри него заставляло композитор пересобирать маску и размытие дока на каждом кадре (замер владельца: 16% GPU,
        // раскрытие дока при наведении скрывает полоску — и нагрузка пропадает). Снаружи — чистый слой без эффектов.
        zone.append(flow);
        const place = () => {
            const zoneRect = zone.getBoundingClientRect();
            const dockRect = dock.getBoundingClientRect();
            if (!dockRect.height) return;
            flow.style.left = `${Math.round(dockRect.left - zoneRect.left + 2)}px`;
            flow.style.top = `${Math.round(dockRect.top - zoneRect.top + dockRect.height * 0.1)}px`;
            flow.style.height = `${Math.round(dockRect.height * 0.8)}px`;
        };
        if (typeof zone.ownerDocument.defaultView?.requestAnimationFrame === 'function') zone.ownerDocument.defaultView.requestAnimationFrame(place);
        if (typeof globalThis.ResizeObserver === 'function') new globalThis.ResizeObserver(place).observe(dock);
    }
    let previousClass = null;
    const disposeEffect = effect(() => {
        const next = `stme-light-${activityState()}`;
        if (previousClass) zone.classList.remove(previousClass);
        zone.classList.add(next);
        previousClass = next;
    });
    return {
        dispose: () => {
            flow?.remove();
            disposeEffect();
            if (previousClass) zone.classList.remove(previousClass);
        },
    };
}
