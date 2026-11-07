/**
 * Модель вкладки «Files» окна The Court (часть 21): дерево папок, роль и место
 * каждого промпта в контексте, переменные `{{…}}`, размер в токенах, поиск.
 * Чистые функции — окно только рисует готовое.
 */

const text = value => String(value ?? '');

/** Роль встроенного промпта по имени константы. */
export function roleOfPrompt(name = '') {
    const n = String(name).toUpperCase();
    if (/^(GOD|CREATION|SCALE|PRAYER_ANSWER|SERAPH)/.test(n)) return 'god';
    if (/^WRITER|INSCRIPTION|^STORY_SETTINGS/.test(n)) return 'writer';
    if (/^RESOLVER|^ASSESS|^FORM_|^INSCRIBE/.test(n)) return 'resolver';
    if (/^COUNSELLOR|PETITION/.test(n)) return 'counsellor';
    if (/^BANK|^CHARACTER_BANK|^LOREBOOK|^RESEARCH/.test(n)) return 'banks';
    if (/^DIRECTOR|^DECREE|^BOOTSTRAP|^ASK_USER/.test(n)) return 'director';
    return 'engine';
}

export const ROLE_FOLDERS = Object.freeze({
    god: 'God', director: 'Director', counsellor: 'Counsellor', resolver: 'Resolver', writer: 'Writer', banks: 'Data banks', engine: 'Engine',
});

const KNOWN_USE = {
    DIRECTOR_SYSTEM: 'System prompt of the Director and the turn context — the first message.',
    WRITER_SYSTEM: 'System prompt of the Writer — the first message of every reply.',
    DIRECTOR_REASONING: 'How the Director thinks — at the very end of the task.',
    RESOLVER_THINK_TURN: 'How the Resolver thinks this turn — at the very end of the turn task.',
    RESOLVER_THINK_AFTER: 'How the Resolver thinks after the turn — at the end of the after-turn task.',
    RESOLVER_AFTER_TURN: 'The after-turn task — sent with the Writer reply.',
    COUNSELLOR_SYSTEM: 'System prompt of the Counsellor.',
    DIRECTOR_TURN: 'The turn task — the last message before the Resolver answers.',
};

/** Где этот промпт оказывается в контексте — человеческой строкой. */
export function usageOf(file) {
    if (file?.kind === 'block') return `Your ${file.section === 'writer' ? 'Writer' : 'Director'} block — added to that section of the context in the order of its tree.`;
    if (file?.kind === 'character') return file.part === 'decree' ? 'The Decree of this character — written by the Director, read by the Resolver (@10) and the Writer.' : `The ${file.part} part of the Great Bank — projections of it reach the roles.`;
    if (file?.name && KNOWN_USE[file.name]) return KNOWN_USE[file.name];
    if (file?.name) return `A built-in prompt of the ${ROLE_FOLDERS[roleOfPrompt(file.name)] ?? 'engine'}.`;
    return '';
}

/** Переменные `{{name}}` текста — движок подставляет их сам. */
export function placeholders(value) {
    return [...new Set([...text(value).matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)].map(match => match[1]))];
}

/** Правка встроенного промпта не может терять или выдумывать переменные: движок упал бы при подстановке. */
export function placeholderProblems(base, draft) {
    const before = new Set(placeholders(base));
    const after = new Set(placeholders(draft));
    return { missing: [...before].filter(name => !after.has(name)), unknown: [...after].filter(name => !before.has(name)) };
}

export const tokensOf = value => Math.ceil(text(value).length / 4);
export const linesOf = value => text(value).split('\n').length;

/**
 * Файлы → дерево: `path` — сегменты через «/», последний — имя файла.
 * Узел папки: { type: 'folder', name, path, children, count, changed }.
 */
export function buildTree(files) {
    const root = { type: 'folder', name: '', path: '', children: [], count: 0, changed: 0 };
    for (const file of Array.isArray(files) ? files : []) {
        const parts = String(file.path ?? file.id).split('/');
        let node = root;
        for (let index = 0; index < parts.length - 1; index += 1) {
            const path = parts.slice(0, index + 1).join('/');
            let next = node.children.find(child => child.type === 'folder' && child.path === path);
            if (!next) { next = { type: 'folder', name: parts[index], path, children: [], count: 0, changed: 0 }; node.children.push(next); }
            node = next;
        }
        node.children.push({ type: 'file', name: parts.at(-1), path: file.path ?? file.id, file });
    }
    const count = node => {
        if (node.type === 'file') return { files: 1, changed: node.file.changed ? 1 : 0 };
        const totals = node.children.map(count).reduce((sum, item) => ({ files: sum.files + item.files, changed: sum.changed + item.changed }), { files: 0, changed: 0 });
        node.count = totals.files;
        node.changed = totals.changed;
        return totals;
    };
    count(root);
    return root;
}

/** Поиск по имени и тексту: файл → число совпадений в тексте (имя совпало — хотя бы 1). */
export function searchFiles(files, query) {
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return null;
    const hits = new Map();
    for (const file of Array.isArray(files) ? files : []) {
        const body = text(file.text).toLowerCase();
        let n = 0;
        for (let at = body.indexOf(q); at >= 0; at = body.indexOf(q, at + q.length)) n += 1;
        if (String(file.path ?? file.id).toLowerCase().includes(q)) n = Math.max(n, 1);
        if (n) hits.set(file.id, n);
    }
    return hits;
}

/** Заголовок куска diff в стиле git: `@@ -a,b +c,d @@`. */
export function hunkHeader(hunk) {
    const old = hunk.lines.filter(line => line.type !== 'add');
    const now = hunk.lines.filter(line => line.type !== 'del');
    const first = (list, key) => (list.find(line => Number.isFinite(line[key]))?.[key] ?? 0);
    return `@@ −${first(old, 'oldNo')},${old.length} +${first(now, 'newNo')},${now.length} @@`;
}

/** Строки diff с номерами старой и новой версии. */
export function numberLines(diff) {
    let oldNo = 0;
    let newNo = 0;
    return diff.map(line => {
        if (line.type !== 'add') oldNo += 1;
        if (line.type !== 'del') newNo += 1;
        return { ...line, oldNo: line.type === 'add' ? null : oldNo, newNo: line.type === 'del' ? null : newNo };
    });
}
