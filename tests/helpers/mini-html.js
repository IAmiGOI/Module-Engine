/**
 * Минимальный HTML-парсер для тестов раскладки в Node: строит дерево с тем же интерфейсом, что читает `libraries/shared/text-layout/parse.js`
 * (`nodeType`, `tagName`, `childNodes`, `data`, `getAttribute`, `attributes`). Только то, что пишут сами тесты: теги, атрибуты в кавычках,
 * пустые элементы (`br`, `img`, `hr`), сущности `&amp; &lt; &gt; &quot; &nbsp; &#NNN;`. Настоящий браузерный парсер — в Сервисе.
 */

const VOID = new Set(['br', 'img', 'hr']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(text) {
    return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, name) => {
        if (name[0] === '#') return String.fromCodePoint(name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
        return ENTITIES[name] ?? match;
    });
}

function element(tagName, attributes) {
    return {
        nodeType: 1,
        tagName: tagName.toUpperCase(),
        childNodes: [],
        attributes: Object.entries(attributes).map(([name, value]) => ({ name, value })),
        getAttribute(name) { return Object.hasOwn(attributes, name) ? attributes[name] : null; },
    };
}

export function parseMiniHtml(html) {
    const root = element('body', {});
    const stack = [root];
    const pattern = /<\/([a-z0-9]+)\s*>|<([a-z0-9]+)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*\/?>|<!--[\s\S]*?-->|([^<]+)/gi;
    for (const match of html.matchAll(pattern)) {
        const top = stack[stack.length - 1];
        if (match[1]) {
            const name = match[1].toUpperCase();
            const index = stack.findLastIndex(node => node.tagName === name);
            if (index > 0) stack.length = index;
        } else if (match[2]) {
            const attributes = {};
            for (const attribute of (match[3] ?? '').matchAll(/([a-z-]+)(?:="([^"]*)")?/gi)) attributes[attribute[1].toLowerCase()] = decode(attribute[2] ?? '');
            const node = element(match[2], attributes);
            top.childNodes.push(node);
            if (!VOID.has(match[2].toLowerCase())) stack.push(node);
        } else if (match[4]) {
            top.childNodes.push({ nodeType: 3, data: decode(match[4]) });
        }
    }
    return root;
}
