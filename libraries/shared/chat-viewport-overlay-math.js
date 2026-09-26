/**
 * Чистая математика оверлея Chat Viewport (`cores/ui/chat-viewport-overlay/`):
 * заужение с боков и «прижат ли чат к низу». Ни DOM, ни шин — тестируется как данные.
 */

/**
 * Отступ по бокам — owner: «Сделать ВО ВСЮ ширину страницы. Отступ чисто небольшой дефолтно,
 * чтобы было читаемо. Далее можно сузить до любой ширины, не меньше ДЕФОЛТНОЙ для ST».
 * `MIN_WIDTH_FRACTION` — эта самая «дефолтная для ST» ширина: `chat_width: 50` (половина страницы)
 * из `power-user.js` — захардкоженный ДЕФОЛТ ST, а не текущая настройка владельца (она может быть любой).
 */
export const DEFAULT_SIDE_MARGIN = 24;
export const MIN_WIDTH_FRACTION = 0.5;
/** Отступ колонки на телефоне (тач): широкая настройка с ПК там съедала бы половину ширины. */
export const PHONE_SIDE_MARGIN = 8;

/** «Почти у низа» — тоже прижат: иначе суб-пиксельные расхождения округления никогда не давали бы `true`. */
export const BOTTOM_THRESHOLD = 48;

/** Предел, дальше которого ручкой не утянуть: ширина не падает ниже `MIN_WIDTH_FRACTION` страницы. Отступ симметричный, поэтому делится на два края. */
export function computeMaxSideMargin(pageWidth) {
    return Math.max(0, pageWidth * (1 - MIN_WIDTH_FRACTION) / 2);
}

/**
 * Отступ не меньше `minMargin` — сколько нужно, чтобы колонка не наезжала на выезжающий левый док (см. `minSideMargin`); но не больше предела ширины (на узком окне минимум уступает).
 * Ширина колонки при этом всегда «ширина окна минус два отступа», то есть подстраивается под любое разрешение.
 */
export function clampSideMargin(margin, pageWidth, minMargin = 0) {
    const max = computeMaxSideMargin(pageWidth);
    // На узком окне (телефон) минимум не может съесть больше, чем позволяет предел ширины: колонка остаётся не уже половины страницы.
    return Math.max(Math.min(minMargin, max), Math.max(0, Math.min(margin, max)));
}

/** Ширина канваса при данном отступе: не меньше 1 px, чтобы WebGL-канвас никогда не получал нулевой размер. */
export function computeViewportWidth(pageWidth, margin) {
    return Math.max(1, pageWidth - margin * 2);
}

/**
 * Отступы колонки слева и справа. `linked: true` — прежнее поведение (один симметричный отступ, колонка по центру; так и остаётся, пока владелец не потянул ручку);
 * после первого перетаскивания одной из ручек отступы независимы (`linked: false`): левый край тянется влево/вправо сам по себе, правый — сам по себе, и колонку
 * можно сместить в одну сторону.
 */
export const DEFAULT_MARGINS = Object.freeze({ left: DEFAULT_SIDE_MARGIN, right: DEFAULT_SIDE_MARGIN, linked: true });

/**
 * Действующие отступы `{left, right}` для страницы `pageWidth`; ширина колонки не меньше `MIN_WIDTH_FRACTION` страницы. Связанные — как `clampSideMargin`, симметрично и
 * не меньше `minLeft` (место под выезжающий левый док, колонка по центру не наезжает на него). Независимые (владелец растянул сами) — от края окна, без этой границы:
 * выдвинутый док лишь ненадолго перекроет колонку. Если сумма велика, излишек срезается с обоих отступов пропорционально.
 */
export function resolveMargins(margins, pageWidth, minLeft = 0) {
    const max = Math.max(0, pageWidth * (1 - MIN_WIDTH_FRACTION));
    if (margins.linked) {
        const side = clampSideMargin(margins.left, pageWidth, minLeft);
        return { left: side, right: side };
    }
    let left = Math.max(0, margins.left);
    let right = Math.max(0, margins.right);
    const excess = left + right - max;
    if (excess > 0) {
        const shrinkLeft = excess * left / (left + right);
        left -= shrinkLeft;
        right -= excess - shrinkLeft;
    }
    return { left: Math.round(left), right: Math.round(right) };
}

/** Перетаскивание одной ручки: `start` — действующие отступы в начале жеста, `dx` — сдвиг указателя вправо. Левый край вправо — левый отступ растёт; правый край вправо — правый отступ уменьшается. Второй отступ не трогается. */
export function dragMargins(side, start, dx, pageWidth) {
    const max = Math.max(0, pageWidth * (1 - MIN_WIDTH_FRACTION));
    const clamp = (value, low, high) => Math.max(low, Math.min(value, Math.max(low, high)));
    if (side === 'left') return { left: Math.round(clamp(start.left + dx, 0, max - start.right)), right: start.right, linked: false };
    return { left: start.left, right: Math.round(clamp(start.right - dx, 0, max - start.left)), linked: false };
}

/** Ширина колонки при отступах `{left, right}`: не меньше 1 px. */
export const marginsWidth = (pageWidth, { left, right }) => Math.max(1, pageWidth - left - right);

/** Прижат ли низ окна к концу содержимого высотой `totalHeight` (с допуском `threshold`). */
export function isNearBottom({ scrollTop, clientHeight, totalHeight, threshold = BOTTOM_THRESHOLD }) {
    return scrollTop + clientHeight >= totalHeight - threshold;
}

/**
 * Левый док (styles/chrome/input-bar.css: `--stme-open-x` 8 + `--stme-dock-w` 147) выезжает от левого края окна на 155px; плюс зазор до колонки.
 * Пара к CSS — менять вместе.
 */
export const LEFT_DOCK_REACH = 155 + 12;

/** Наименьший симметричный отступ, при котором колонка не наезжает на открытый левый док: считается от левого края оверлея (`layoutLeft` — боковая панель). */
export const minSideMargin = layoutLeft => Math.max(0, LEFT_DOCK_REACH - layoutLeft);

/** Зазор между низом последнего сообщения и верхом собственной пилюли набора (владелец: «должен быть отступ от нижнего сообщения до блока ввода»), px. */
export const INPUT_PANEL_GAP = 12;

/**
 * Боковая панель ST (значки верхней полосы, вписанные в левый верхний угол, styles/chrome/side-bar.css) занимает слева `--stme-side-bar-w` (42px)
 * плюс зазор: оверлей чата начинается правее неё. Пара к CSS — менять вместе.
 */
export const SIDE_BAR_INSET = 52;
/** Небольшой отступ сверху: верхней полосы больше нет, и первое сообщение не должно липнуть к краю окна. */
export const SIDE_TOP_INSET = 8;
