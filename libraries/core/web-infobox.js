/**
 * Инфобоксы вики-страниц: карточка с фактами справа («Age: 17», «Height: 164 cm») — самое ценное на странице персонажа, и обычная очистка HTML её выбрасывает
 * вместе с боковыми блоками. Здесь она разбирается в пары «поле: значение»: Fandom/«portable infobox» (`pi-data`) и Википедия/MediaWiki (`table.infobox`).
 * Чистые функции над HTML-строкой (без DOM: те же правила в браузере и в тестах).
 */

const ENTITIES = Object.freeze({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': '\'', '&#160;': ' ', '&nbsp;': ' ', '&#x27;': '\'' });
const decode = text => text.replace(/&(?:amp|lt|gt|quot|#39|#160|nbsp|#x27);/g, entity => ENTITIES[entity]).replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
const toText = html => decode(String(html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<sup[^>]*class="[^"]*reference[^"]*"[\s\S]*?<\/sup>/gi, ' ')
    .replace(/<\/(p|li|div|tr)>|<br\s*\/?>/gi, '; ')
    .replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').replace(/(?:\s*;\s*)+$/g, '').replace(/^(?:\s*;\s*)+/g, '').replace(/(?:;\s*){2,}/g, '; ').trim();

/** Факты Fandom-инфобокса: `[{ group, label, value }]`, группа — ближайший заголовок `pi-header` выше. */
function computePortableFacts(html) {
    const facts = [];
    const pattern = /<h2[^>]*class="[^"]*pi-header[^"]*"[^>]*>([\s\S]*?)<\/h2>|<h3[^>]*class="[^"]*pi-data-label[^"]*"[^>]*>([\s\S]*?)<\/h3>\s*<div[^>]*class="[^"]*pi-data-value[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
    let group = '';
    for (const [, header, label, value] of html.matchAll(pattern)) {
        if (header !== undefined) { group = toText(header); continue; }
        const text = toText(value);
        if (label && text) facts.push({ group, label: toText(label), value: text });
    }
    return facts;
}

/** Факты Википедии/MediaWiki: строки `<th class="infobox-label">…</th><td class="infobox-data">…</td>`. */
function computeTableFacts(html) {
    const start = html.search(/<table[^>]*class="[^"]*\binfobox\b/);
    if (start < 0) return [];
    const end = html.indexOf('</table>', start);
    const table = html.slice(start, end < 0 ? undefined : end);
    const facts = [];
    for (const [, label, value] of table.matchAll(/<th[^>]*class="[^"]*infobox-label[^"]*"[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*class="[^"]*infobox-data[^"]*"[^>]*>([\s\S]*?)<\/td>/g)) {
        const text = toText(value);
        if (text) facts.push({ group: '', label: toText(label), value: text });
    }
    return facts;
}

const MAX_IMAGES = 6;
const attribute = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(tag)?.[1] ?? '';

/**
 * Картинки инфобокса: `[{ label, url }]` — для аватара карточки (Mea выбирает по подписи, не глядя). Fandom: полноразмерные адреса из ссылок `class="image"` с подписью вкладки
 * («Anime», «Manga»); Википедия: картинка таблицы с `alt`/подписью. Не больше MAX_IMAGES, без повторов.
 */
export function computeInfoboxImages(html) {
    const source = String(html ?? '');
    const found = [];
    const add = (label, url) => { if (url && !found.some(item => item.url === url) && found.length < MAX_IMAGES) found.push({ label: label.trim() || 'image', url }); };
    const aside = /<aside[^>]*portable-infobox[\s\S]*?<\/aside>/i.exec(source)?.[0];
    if (aside) {
        for (const [tag] of aside.matchAll(/<a\b[^>]*>/gi)) {
            if (!/class="[^"]*\bimage\b/i.test(tag)) continue;
            const href = decode(attribute(tag, 'href'));
            if (/^https:\/\/static\.wikia\.nocookie\.net\//.test(href)) add(decode(attribute(tag, 'title')), href);
        }
        return found;
    }
    const start = source.search(/<table[^>]*class="[^"]*\binfobox\b/);
    if (start < 0) return found;
    const table = source.slice(start, source.indexOf('</table>', start) < 0 ? undefined : source.indexOf('</table>', start));
    for (const [tag] of table.matchAll(/<img\b[^>]*>/gi)) {
        const src = decode(attribute(tag, 'src')).replace(/^\/\//, 'https://').replace(/\?.*$/, '');
        if (/^https:\/\/upload\.wikimedia\.org\//.test(src) && !/\.svg(?:\.png)?$/i.test(src)) add(decode(attribute(tag, 'alt')), src);
    }
    return found;
}

export function computeInfoboxFacts(html) {
    const source = String(html ?? '');
    const portable = computePortableFacts(source);
    return portable.length ? portable : computeTableFacts(source);
}

/** Текст раздела «Infobox» для страницы: строки `Поле: значение`, группы — подзаголовками-строками; пусто, если инфобокса нет. */
export function computeInfoboxText(html) {
    const facts = computeInfoboxFacts(html);
    const images = computeInfoboxImages(html);
    if (!facts.length && !images.length) return '';
    const lines = ['## Infobox'];
    let group = '';
    for (const fact of facts) {
        if (fact.group && fact.group !== group) { group = fact.group; lines.push(`[${group}]`); }
        lines.push(`${fact.label}: ${fact.value}`);
    }
    if (images.length) lines.push('[Images — for character.avatar]', ...images.map(image => `Image (${image.label}): ${image.url}`));
    return lines.join('\n');
}
