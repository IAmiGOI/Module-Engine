/**
 * Построчный diff и мягкое применение правок `old → new` — для «промптов как
 * файлов» в окне The Court (часть 21). Чистые функции, без DOM.
 */

const lines = value => String(value ?? '').replace(/\r\n/g, '\n').split('\n');
const loose = value => String(value ?? '').toLowerCase().replace(/[\s.,;:!?"'`*_—–-]+/g, ' ').trim();

/** Строки двух текстов → [{ type: 'same' | 'add' | 'del', text }] по наибольшей общей подпоследовательности. */
export function diffLines(before, after) {
    const a = lines(before);
    const b = lines(after);
    const n = a.length;
    const m = b.length;
    const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
    const out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i += 1; j += 1; }
        else if (table[i + 1][j] >= table[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i += 1; }
        else { out.push({ type: 'add', text: b[j] }); j += 1; }
    }
    while (i < n) out.push({ type: 'del', text: a[i++] });
    while (j < m) out.push({ type: 'add', text: b[j++] });
    return out;
}

/** Diff → куски с `context` строками вокруг изменений; без изменений — пустой список. */
export function diffHunks(before, after, { context = 2 } = {}) {
    const diff = diffLines(before, after);
    const changed = diff.map((line, index) => (line.type === 'same' ? -1 : index)).filter(index => index >= 0);
    if (!changed.length) return [];
    const hunks = [];
    let current = null;
    for (const index of changed) {
        const from = Math.max(0, index - context);
        const to = Math.min(diff.length - 1, index + context);
        if (current && from <= current.to + 1) current.to = Math.max(current.to, to);
        else { current = { from, to }; hunks.push(current); }
    }
    return hunks.map(({ from, to }) => ({ from, lines: diff.slice(from, to + 1) }));
}

/** Сколько строк добавлено и убрано. */
export function diffStats(before, after) {
    const diff = diffLines(before, after);
    return { added: diff.filter(line => line.type === 'add').length, removed: diff.filter(line => line.type === 'del').length };
}

/**
 * Правка `old → new` без отказов: точное совпадение; иначе строка, совпадающая
 * без учёта пробелов, регистра и знаков; иначе `new` дописывается в конец.
 * Пустой `new` удаляет найденное. Возвращает текст и как применилась правка.
 */
export function applyEdit(source, { old = '', new: next = '' } = {}) {
    const text = String(source ?? '');
    const from = String(old ?? '');
    const to = String(next ?? '');
    if (from && text.includes(from)) return { text: text.replace(from, to), how: 'exact' };
    if (from) {
        const all = lines(text);
        const wanted = lines(from).map(loose).filter(Boolean);
        for (let start = 0; start < all.length && wanted.length; start += 1) {
            const window = all.slice(start, start + wanted.length);
            if (window.length === wanted.length && window.every((line, index) => loose(line) === wanted[index])) {
                const replaced = [...all.slice(0, start), ...(to ? lines(to) : []), ...all.slice(start + wanted.length)];
                return { text: replaced.join('\n'), how: 'loose' };
            }
        }
    }
    if (!to) return { text, how: 'nothing' };
    return { text: `${text.replace(/\s+$/, '')}\n${to}`, how: 'appended' };
}

/** Несколько правок по очереди. */
export function applyEdits(source, edits = []) {
    let text = String(source ?? '');
    const results = [];
    for (const edit of Array.isArray(edits) ? edits : []) {
        const applied = applyEdit(text, edit);
        text = applied.text;
        results.push(applied.how);
    }
    return { text, results };
}

/** Ответ модели → правки: JSON-массив `[{old, new}]`, объект `{edits: [...]}` или в ```json-обёртке. */
export function parseEdits(answer) {
    const raw = String(answer ?? '').replace(/^[\s\S]*?```(?:json)?\s*/i, match => (match.includes('```') ? '' : match)).replace(/```[\s\S]*$/, '').trim();
    for (const candidate of [raw, String(answer ?? '').trim()]) {
        try {
            const value = JSON.parse(candidate);
            const list = Array.isArray(value) ? value : value?.edits;
            if (Array.isArray(list)) return list.filter(item => item && typeof item === 'object').map(item => ({ old: String(item.old ?? ''), new: String(item.new ?? '') }));
        } catch { /* next */ }
    }
    return [];
}
