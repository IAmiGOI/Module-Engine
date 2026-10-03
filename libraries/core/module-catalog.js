// @ts-check
/**
 * Каталог Модулей (RUNTIME.md, фаза 3) — чистые функции над текстом и JSON, без сети.
 *
 * Репозиторий каталога устроен так:
 *   modules/<имя>/index.js   — подтверждённые Модули, по папке на Модуль (одним файлом: внешний Модуль — один \`index.js\`);
 *   third-party.txt          — по ссылке на GitHub в строке (\`#\` — комментарий): сторонние Модули, не прошедшие проверку каталога.
 *
 * Ссылка на сторонний Модуль — любая из форм:
 *   owner/repo                                  → index.js в корне, ветка по умолчанию
 *   https://github.com/owner/repo               → то же
 *   https://github.com/owner/repo/tree/ref/dir  → dir/index.js
 *   https://github.com/owner/repo/blob/ref/dir/file.js → именно этот файл
 */

/** @typedef {import('./module-types.js').ModuleLink} ModuleLink */
/** @typedef {import('./module-types.js').RepoRef} RepoRef */
/** @typedef {import('./module-types.js').CatalogEntry} CatalogEntry */

const RAW = 'https://raw.githubusercontent.com';
const API = 'https://api.github.com';
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SEGMENT_RE = /^[A-Za-z0-9._@+-]+$/;

/**
 * @param {string[]} parts
 * @returns {string[] | null}  Сегменты без пустых; `null`, если среди них есть `.`/`..` или недопустимые символы.
 */
function cleanSegments(parts) {
    const segments = parts.filter(Boolean);
    return segments.every(segment => segment !== '.' && segment !== '..' && SEGMENT_RE.test(segment)) ? segments : null;
}

/**
 * Ссылка на GitHub → { owner, repo, ref, path } или null. `path` — всегда путь к ФАЙЛУ Модуля.
 * @param {unknown} input
 * @returns {ModuleLink | null}
 */
export function parseModuleLink(input) {
    const text = String(input ?? '').trim().replace(/\/+$/, '').replace(/\.git$/i, '');
    if (!text) return null;
    const stripped = text.replace(/^https?:\/\/github\.com\//i, '').replace(/^git@github\.com:/i, '');
    const parts = stripped.split('/');
    if (parts.length < 2) return null;
    const [owner, repo, kind, ref, ...rest] = parts;
    if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) return null;
    if (parts.length === 2) return { owner, repo, ref: 'HEAD', path: 'index.js' };
    if (kind !== 'tree' && kind !== 'blob') return null;
    if (!ref || !SEGMENT_RE.test(ref)) return null;
    const segments = cleanSegments(rest);
    if (!segments) return null;
    if (kind === 'blob') return segments.length && /\.js$/.test(segments.at(-1) ?? '') ? { owner, repo, ref, path: segments.join('/') } : null;
    return { owner, repo, ref, path: [...segments, 'index.js'].join('/') };
}

/**
 * @param {ModuleLink} link
 * @returns {string}  Прямой адрес файла на raw.githubusercontent.com.
 */
export function rawModuleUrl({ owner, repo, ref, path }) {
    return `${RAW}/${owner}/${repo}/${ref}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Содержимое `third-party.txt` → { entries, errors }. Дубли ссылок схлопываются.
 * @param {unknown} text
 * @returns {{ entries: CatalogEntry[], errors: string[] }}
 */
export function parseThirdPartyList(text) {
    /** @type {CatalogEntry[]} */
    const entries = [];
    /** @type {string[]} */
    const errors = [];
    const seen = new Set();
    for (const [index, raw] of String(text ?? '').split(/\r?\n/).entries()) {
        const line = raw.replace(/\s+#.*$/, '').trim();
        if (!line || line.startsWith('#')) continue;
        const link = parseModuleLink(line);
        if (!link) { errors.push(`line ${index + 1}: not a GitHub module link: "${line}"`); continue; }
        const url = rawModuleUrl(link);
        if (seen.has(url)) continue;
        seen.add(url);
        entries.push({ kind: 'thirdParty', name: `${link.owner}/${link.repo}${link.path === 'index.js' ? '' : `/${link.path.replace(/\/?index\.js$/, '')}`}`, url, link });
    }
    return { entries, errors };
}

/**
 * Адрес списка папок `modules/` каталога через API GitHub.
 * @param {RepoRef} repository
 * @returns {string}
 */
export function catalogListingUrl({ owner, repo, ref = 'HEAD' }) {
    return `${API}/repos/${owner}/${repo}/contents/modules?ref=${encodeURIComponent(ref)}`;
}

/**
 * Ответ API (массив) → подтверждённые записи, по одной на папку. Не-папки и странные имена пропускаются.
 * @param {unknown} listing  Разобранный JSON ответа GitHub (чужие данные — форму не предполагаем).
 * @param {RepoRef} repository
 * @returns {CatalogEntry[]}
 */
export function buildVerifiedEntries(listing, { owner, repo, ref = 'HEAD' }) {
    if (!Array.isArray(listing)) return [];
    /** @type {CatalogEntry[]} */
    const entries = [];
    for (const item of listing) {
        const name = item?.name;
        if (item?.type !== 'dir' || typeof name !== 'string' || !SEGMENT_RE.test(name) || name.startsWith('.')) continue;
        /** @type {ModuleLink} */
        const link = { owner, repo, ref, path: `modules/${name}/index.js` };
        entries.push({ kind: 'verified', name, url: rawModuleUrl(link), link });
    }
    return entries.sort((x, y) => x.name.localeCompare(y.name));
}

/**
 * @param {RepoRef} repository
 * @returns {string}
 */
export function catalogThirdPartyUrl({ owner, repo, ref = 'HEAD' }) {
    return rawModuleUrl({ owner, repo, ref, path: 'third-party.txt' });
}
