/**
 * Переопределения встроенных промптов — «промпты как файлы» (часть 21).
 * Каталог встроенных текстов по id файла и подмена текста при сборке: правка
 * пользователя хранится в настройках (`promptOverrides`), основа неизменна.
 * Модульное состояние — одно на движок, его ставит ядро decision при загрузке
 * и правке настроек.
 */
let byOriginal = new Map();
let catalogCache = null;
const kebab = name => name.toLowerCase().replace(/_/g, '-');

/** [{ id, folder, name, text }] — все длинные строковые экспорты модулей промптов, без повторов. */
export function promptCatalog(groups) {
    if (!groups && catalogCache) return catalogCache;
    const seen = new Set();
    const files = [];
    for (const [folder, module] of groups ?? []) {
        for (const [name, value] of Object.entries(module)) {
            if (typeof value !== 'string' || value.length < 60 || seen.has(value)) continue;
            seen.add(value);
            files.push({ id: `built-in/${folder}/${kebab(name)}.md`, folder, name, text: value });
        }
    }
    if (groups) catalogCache = files;
    return files;
}

/** Ставит переопределения: `{ fileId: text }` → подмена по исходному тексту. */
export function setPromptOverrides(overrides = {}, catalog = catalogCache ?? []) {
    const next = new Map();
    for (const file of catalog) {
        const text = overrides?.[file.id];
        if (typeof text === 'string' && text.trim() && text !== file.text) next.set(file.text, text);
    }
    byOriginal = next;
}

/** Текст встроенного промпта с учётом правки пользователя. */
export function promptText(original) {
    return byOriginal.get(original) ?? original;
}

export function cleanOverrides(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([id, text]) => id.startsWith('built-in/') && typeof text === 'string'));
}
