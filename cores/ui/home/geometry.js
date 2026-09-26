import { SIDE_BAR_INSET, SIDE_TOP_INSET } from '../../../libraries/shared/chat-viewport-overlay-math.js';
import { FLOW_MAX_WIDTH } from '../../../libraries/shared/home-model.js';

/** Отступ сцены от нижнего края окна (пилюли набора на главном экране нет). */
export const HOME_BOTTOM_MARGIN = 12;
/** Зазор под родной верхней полосой ST на телефоне. */
const TOP_STRIP_GAP = 6;

/**
 * Прямоугольник сцены в окне. Широкий экран с боковой панелью: окно минус боковая панель слева и небольшой отступ сверху. Телефон/узкий экран (родная
 * горизонтальная полоса значков ST сверху): сцена начинается ПОД этой полосой (иначе она перекрывала первые блоки), на всю ширину. Снизу — небольшой отступ.
 */
export function computeStageRect({ doc, win }) {
    const side = doc.documentElement.classList.contains('stme-side-bar-active');
    let top = side ? SIDE_TOP_INSET : 0;
    if (!side) {
        const strip = doc.getElementById?.('top-settings-holder');
        const bottom = strip?.getBoundingClientRect?.().bottom ?? 0;
        if (bottom > 0) top = Math.ceil(bottom) + TOP_STRIP_GAP;
    }
    const left = side ? SIDE_BAR_INSET : 0;
    return { left, top, width: Math.max(1, win.innerWidth - left), height: Math.max(1, win.innerHeight - top - HOME_BOTTOM_MARGIN) };
}

/** Стол идёт потоком с прокруткой (а не раскладкой по сцене): на касании и в узком окне. */
export const useFlowLayout = ({ touch, width }) => Boolean(touch) || width < FLOW_MAX_WIDTH;

/** Цвета растра. `foreignObject` не видит переменных страницы, а `getPropertyValue` отдаёт их НЕразрешёнными (`var(--SmartThemeBodyColor, …)`) — цвет разрешает браузер на пробном узле. */
export function resolveTokens({ doc, win }) {
    const probe = doc.createElement('span');
    probe.style.cssText = 'position:fixed;left:-9999px;top:0;visibility:hidden;pointer-events:none';
    doc.body.append(probe);
    const resolve = (value, fallback) => {
        probe.style.color = '';
        probe.style.color = value;
        return win.getComputedStyle(probe).color || fallback;
    };
    const tokens = {
        text: resolve('var(--stme-text)', '#e8e6df'),
        muted: resolve('color-mix(in srgb, var(--stme-text) 62%, transparent)', 'rgba(232,230,223,.62)'),
        accent: resolve('var(--stme-accent)', '#f5c518'),
        font: win.getComputedStyle(doc.body).fontFamily || 'system-ui, sans-serif',
    };
    probe.remove();
    return tokens;
}
