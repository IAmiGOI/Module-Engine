/**
 * Переопределения параметров генерации (решение владельца: «по персонажу / чату / модели, по умолчанию ВЫКЛЮЧЕНО»).
 * Чистая функция: базовые параметры пресета + слои переопределений по приоритету модель < персонаж < чат.
 *
 *   overrides: { enabled, byModel: { [модель]: params }, byCharacter: { [имя]: params }, byChat: { [id чата]: params } }
 * Возвращает { params, sources } — sources показывает, какие слои реально сработали (для подсказки в окне).
 */
export const DEFAULT_OVERRIDES = Object.freeze({ enabled: false, byModel: {}, byCharacter: {}, byChat: {} });

export function resolveParams(base, overrides, { model, char, chatId } = {}) {
    const config = { ...DEFAULT_OVERRIDES, ...(overrides ?? {}) };
    if (!config.enabled) return { params: { ...(base ?? {}) }, sources: [] };
    const layers = [['model', config.byModel?.[model]], ['character', config.byCharacter?.[char]], ['chat', config.byChat?.[chatId]]];
    const params = { ...(base ?? {}) };
    const sources = [];
    for (const [name, layer] of layers) {
        if (!layer || typeof layer !== 'object') continue;
        const defined = Object.entries(layer).filter(([, value]) => value !== undefined && value !== null && value !== '');
        if (!defined.length) continue;
        for (const [key, value] of defined) params[key] = value;
        sources.push(name);
    }
    return { params, sources };
}

/** Записывает (или стирает при пустых `params`) слой переопределения; возвращает новую конфигурацию. */
export function setOverride(overrides, scope, key, params) {
    const map = { model: 'byModel', character: 'byCharacter', chat: 'byChat' }[scope];
    if (!map) throw new Error(`overrides: unknown scope "${scope}" (expected model, character or chat).`);
    const next = { ...DEFAULT_OVERRIDES, ...(overrides ?? {}) };
    next[map] = { ...next[map] };
    if (!params || !Object.keys(params).length) delete next[map][key];
    else next[map][key] = { ...params };
    return next;
}
