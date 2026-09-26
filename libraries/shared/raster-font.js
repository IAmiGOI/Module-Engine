/**
 * Шрифт для текстуры тела сообщения. Растр рисуется в ИЗОЛИРОВАННОМ `data:`-документе (`foreignObject`), куда веб-шрифты страницы (`@font-face` темы ST — Noto Sans)
 * не попадают: из списка семейств там работают только УСТАНОВЛЕННЫЕ в системе, остальное — запасной. Зеркало же (по которому меряется высота) стоит на странице, видит
 * веб-шрифт, и его метрики шире/уже системного запасного — текст в текстуре получался на несколько процентов короче отмеренного (под сообщением — пустота, у длинных
 * сообщений в сотни пикселей). Выход: и зеркало, и текстура берут ОДИН и тот же список — только установленные семейства и общие ключевые слова.
 * (Встраивать шрифт в каждую текстуру не годится: ~185 КБ на начертание, декодировалось бы с каждым сообщением.)
 */

const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', '-apple-system', 'blinkmacsystemfont', 'emoji', 'math', 'fangsong']);

/** `"Noto Sans", sans-serif` → ['"Noto Sans"', 'sans-serif'] (запятые внутри кавычек не делят). */
export function splitFontFamilies(stack) {
    const parts = [];
    let current = '';
    let quote = null;
    for (const char of String(stack ?? '')) {
        if (quote) { current += char; if (char === quote) quote = null; continue; }
        if (char === '"' || char === "'") { quote = char; current += char; continue; }
        if (char === ',') { if (current.trim()) parts.push(current.trim()); current = ''; continue; }
        current += char;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

const bareName = family => family.replace(/^["']|["']$/g, '').trim();

/**
 * Оставляет в списке только то, что растр точно нарисует: общие ключевые слова и установленные семейства (`isInstalled(имя)` — асинхронная проверка). Если не осталось
 * ничего — `sans-serif`, как и у самого растра.
 */
export async function resolveRasterFontFamily(stack, isInstalled) {
    const kept = [];
    for (const family of splitFontFamilies(stack)) {
        const name = bareName(family);
        if (GENERIC_FAMILIES.has(name.toLowerCase()) || await isInstalled(name)) kept.push(family);
    }
    return kept.length ? kept.join(', ') : 'sans-serif';
}
