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
    let previousClass = null;
    const disposeEffect = effect(() => {
        const next = `stme-light-${activityState()}`;
        if (previousClass) zone.classList.remove(previousClass);
        zone.classList.add(next);
        previousClass = next;
    });
    return {
        dispose: () => {
            disposeEffect();
            if (previousClass) zone.classList.remove(previousClass);
        },
    };
}
