/**
 * Минимальный semver для Раннера: версии `MAJOR.MINOR.PATCH` (хвост `-pre`/`+build` отбрасывается) и диапазоны из операторов
 * `^ ~ >= <= > < =`, wildcard (`1.x`, `*`) и пробела как «И». Диапазоны с `||` не поддерживаются намеренно — Модулю хватает
 * одного условия, а сложность здесь не окупается.
 */

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export function parseVersion(text) {
    const match = VERSION_RE.exec(String(text ?? '').trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareVersions(a, b) {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
}

/** Недостающие части («1.2», «1») считаются нулями; `x`/`*` — шаблон. Возвращает { parts, wild } или null. */
function parsePartial(text) {
    const pieces = text.replace(/^v/, '').split('.');
    if (pieces.length > 3 || pieces[0] === '') return null;
    const parts = [];
    let wild = pieces.length;
    for (let i = 0; i < pieces.length; i++) {
        if (/^[xX*]$/.test(pieces[i])) { wild = Math.min(wild, i); parts.push(0); continue; }
        if (!/^\d+$/.test(pieces[i])) return null;
        parts.push(Number(pieces[i]));
    }
    while (parts.length < 3) parts.push(0);
    return { parts, wild };
}

/** [нижняя включительно, верхняя исключительно] для одного терма, либо null, если терм не разобрать. */
function termToBounds(term) {
    const op = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(term);
    if (!op) return null;
    const partial = parsePartial(op[2]);
    if (!partial) return null;
    const { parts, wild } = partial;
    const base = parts;
    const upperFrom = level => { const u = [0, 0, 0]; for (let i = 0; i < level; i++) u[i] = base[i]; u[level] = base[level] + 1; return u; };
    switch (op[1] ?? '=') {
        case '=': {
            if (wild === 0) return { lo: null, hi: null };
            if (wild >= 3) return { lo: base, hi: [base[0], base[1], base[2] + 1] };
            return { lo: base, hi: upperFrom(wild - 1) };
        }
        case '^': {
            if (wild === 0) return { lo: null, hi: null };
            const level = base[0] > 0 || wild <= 1 ? 0 : base[1] > 0 || wild <= 2 ? 1 : 2;
            return { lo: base, hi: upperFrom(level) };
        }
        case '~': return { lo: base, hi: upperFrom(wild <= 1 ? 0 : 1) };
        case '>=': return { lo: base, hi: null };
        case '>': return { lo: wild >= 3 ? [base[0], base[1], base[2] + 1] : upperFrom(Math.max(wild - 1, 0)), hi: null };
        case '<': return { lo: null, hi: base };
        case '<=': return { lo: null, hi: wild >= 3 ? [base[0], base[1], base[2] + 1] : upperFrom(Math.max(wild - 1, 0)) };
        default: return null;
    }
}

/** Пустой диапазон / `*` подходит любой версии. Непонятный диапазон не подходит никому — лучше отказ, чем молчаливое «да». */
export function satisfies(version, range) {
    const parsed = Array.isArray(version) ? version : parseVersion(version);
    if (!parsed) return false;
    const text = String(range ?? '').trim();
    if (text === '' || text === '*') return true;
    // «>= 1.2.0» с пробелом после оператора склеиваем обратно в один терм.
    const terms = text.replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1').split(/\s+/);
    for (const term of terms) {
        const bounds = termToBounds(term);
        if (!bounds) return false;
        if (bounds.lo && compareVersions(parsed, bounds.lo) < 0) return false;
        if (bounds.hi && compareVersions(parsed, bounds.hi) >= 0) return false;
    }
    return true;
}

export function isValidRange(range) {
    const text = String(range ?? '').trim();
    if (text === '' || text === '*') return true;
    return text.replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1').split(/\s+/).every(term => termToBounds(term) !== null);
}
