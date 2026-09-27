/**
 * Настройки Модулей, которые гид вправе менять (cores/guide): чистые функции. Модуль САМ объявляет, что можно трогать, — списком «спецификаций» через
 * `guideSettings()` в своём возвращаемом объекте; всё, чего в списке нет, для гида не существует. Спецификация:
 *
 *   { key: 'minSimilarity', label: 'Min similarity', type: 'number' | 'boolean' | 'choice',
 *     min, max, step,            // number; `min`/`max` — число или функция (границы могут зависеть от соседней настройки)
 *     options: [{ value, label }], // choice
 *     get(), set(value) }        // читает и меняет ЖИВОЕ состояние Модуля (его сигналы), сохранение — отдельно (`save` в объявлении)
 *
 * Здесь — проверка значения по спецификации (модель может прислать что угодно), описание изменения для карточки «было → стало» и подсказка для промпта.
 */

const bound = (value, fallback) => (typeof value === 'function' ? value() : (Number.isFinite(value) ? value : fallback));
const fail = error => ({ ok: false, error });

/** Готовые спецификации по сигналу (`peek`/`set`): меньше кода в Модулях. */
export const numberSetting = (key, label, signal, { min, max, step = 1 } = {}) => ({ key, label, type: 'number', min, max, step, get: () => signal.peek(), set: value => signal.set(value) });
export const booleanSetting = (key, label, signal) => ({ key, label, type: 'boolean', get: () => signal.peek(), set: value => signal.set(value) });

/** Сырое значение → значение по спецификации либо `{ ok: false, error }`; числа зажимаются в границы и выравниваются по шагу. */
export function normalizeSettingValue(spec, raw) {
    if (spec.type === 'boolean') {
        if (typeof raw === 'boolean') return { ok: true, value: raw };
        const word = String(raw ?? '').trim().toLowerCase();
        if (['true', 'on', 'yes', '1'].includes(word)) return { ok: true, value: true };
        if (['false', 'off', 'no', '0'].includes(word)) return { ok: true, value: false };
        return fail(`"${spec.label}" is a switch: on or off.`);
    }
    if (spec.type === 'choice') {
        const wanted = String(raw ?? '').trim().toLowerCase();
        const option = (spec.options ?? []).find(item => String(item.value).toLowerCase() === wanted || String(item.label).toLowerCase() === wanted);
        return option ? { ok: true, value: option.value } : fail(`"${spec.label}" must be one of: ${(spec.options ?? []).map(item => item.label).join(', ')}.`);
    }
    const number = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
    if (!Number.isFinite(number) || raw === '' || raw === null) return fail(`"${spec.label}" must be a number.`);
    const min = bound(spec.min, -Infinity);
    const max = bound(spec.max, Infinity);
    const step = spec.step > 0 ? spec.step : 1;
    const origin = Number.isFinite(min) ? min : 0;
    const snapped = origin + Math.round((Math.min(max, Math.max(min, number)) - origin) / step) * step;
    const digits = (String(step).split('.')[1] ?? '').length;
    return { ok: true, value: Math.min(max, Math.max(min, Number(snapped.toFixed(digits)))) };
}

const show = (spec, value) => (spec.type === 'boolean' ? (value ? 'on' : 'off') : spec.type === 'choice' ? ((spec.options ?? []).find(item => item.value === value)?.label ?? String(value)) : String(value));

/**
 * `changes` — `{ key: значение }` → `{ ok, changes: [{ spec, from, to }] }` (все проверены, ничего не применено) либо ошибка по первому плохому ключу.
 * Неизвестный ключ — отказ со списком настоящих: гид не может менять то, что Модуль не объявил.
 */
export function planSettingChanges(specs, changes) {
    const list = Object.entries(changes && typeof changes === 'object' ? changes : {});
    if (!list.length) return fail('Nothing to change.');
    const plan = [];
    for (const [key, raw] of list) {
        const spec = specs.find(item => item.key === key);
        if (!spec) return fail(`There is no setting "${key}". Available: ${specs.map(item => item.key).join(', ') || 'none'}.`);
        const checked = normalizeSettingValue(spec, raw);
        if (!checked.ok) return checked;
        plan.push({ spec, from: spec.get(), to: checked.value });
    }
    return { ok: true, changes: plan };
}

/** Строки карточки: «Min similarity: 0.55 → 0.4». */
export const describePlan = plan => plan.map(({ spec, from, to }) => `${spec.label}: ${show(spec, from)} → ${show(spec, to)}`);

/** Что можно менять — строкой для системного промпта: `key (label): текущее, диапазон`. */
export function describeSpecs(specs) {
    return specs.map(spec => {
        const range = spec.type === 'number' ? `${bound(spec.min, '')}–${bound(spec.max, '')}` : spec.type === 'choice' ? (spec.options ?? []).map(item => item.value).join('/') : 'on/off';
        return `${spec.key} (${spec.label}) = ${show(spec, spec.get())} [${range}]`;
    }).join('; ');
}
