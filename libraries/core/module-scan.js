// @ts-check
/**
 * Статический скан исходника Модуля (RUNTIME.md) + подготовка к запуску. Чистые функции над ТЕКСТОМ — код не исполняется.
 *
 * Скан — «лучшее из возможного», а не песочница: он ловит очевидное (сеть мимо Шины сети, eval, чужие импорты, обход через
 * `window[...]`), но решительный автор его обойдёт. Поэтому он решает только УРОВЕНЬ доверия, а настоящую границу держат права и Гейт.
 * Ложные срабатывания допустимы (хуже уровень доверия, не отказ); пропуск — нет, поэтому правила грубые и по сырому тексту.
 *
 * Серьёзность находки:
 *  - `block`  — Модуль не загружается вовсе (исполнение произвольной строки, импорт откуда попало, обход через computed-доступ).
 *  - `unsafe` — Модуль загружается, но уровень `scanned-unsafe` (сеть/хранилище/окно мимо движка).
 * Без находок — `scanned-safe`.
 */

/** @typedef {import('./module-types.js').ScanFinding} ScanFinding */
/** @typedef {import('./module-types.js').ScanResult} ScanResult */

/** @type {ReadonlyArray<{ rule: string, severity: 'block' | 'unsafe', re: RegExp, message: string }>} */
const RULES = [
    { rule: 'dynamic-eval', severity: 'block', re: /\beval\s*\(|\bnew\s+Function\b|(?<![.\w])Function\s*\(/, message: 'runs a string as code' },
    { rule: 'dynamic-import', severity: 'block', re: /\bimport\s*\(/, message: 'dynamic import() is not allowed' },
    { rule: 'import-scripts', severity: 'block', re: /\bimportScripts\s*\(/, message: 'importScripts is not allowed' },
    { rule: 'computed-global', severity: 'block', re: /\b(?:window|globalThis|self|top|parent|frames)\s*\[/, message: 'computed access to the global object hides what is reached' },
    { rule: 'constructor-escape', severity: 'block', re: /\.constructor\s*\.\s*constructor|\[\s*['"`]constructor['"`]\s*\]/, message: 'reaches Function through constructor' },
    { rule: 'network', severity: 'unsafe', re: /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b|\bRTCPeerConnection\b/, message: 'talks to the network outside the network bus' },
    { rule: 'browser-storage', severity: 'unsafe', re: /\b(?:localStorage|sessionStorage|indexedDB|document\.cookie)\b/, message: 'uses browser storage outside the storage cores' },
    { rule: 'window-reach', severity: 'unsafe', re: /\b(?:window\.(?:parent|top|opener)|document\.write)\b/, message: 'reaches other windows or rewrites the document' },
    { rule: 'st-direct', severity: 'unsafe', re: /\bSillyTavern\b|\bgetContext\s*\(/, message: 'talks to SillyTavern directly instead of through Services' },
];

const STATIC_IMPORT_RE = /(^|[;\n])\s*(?:import|export)\b[^'"`;]*?\bfrom\s*(['"`])([^'"`]+)\2|(^|[;\n])\s*import\s*(['"`])([^'"`]+)\5/g;
export const STME_RE = /^stme:[a-zA-Z0-9_\-/]+$/;

/**
 * @param {string} source
 * @param {number} index
 * @returns {number}  Номер строки (с 1) для смещения в тексте.
 */
function lineOf(source, index) {
    let line = 1;
    for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
    return line;
}

/**
 * Все статические импорты.
 * @param {string} source
 * @returns {Array<{ specifier: string, index: number }>}
 */
export function listImports(source) {
    /** @type {Array<{ specifier: string, index: number }>} */
    const found = [];
    for (const m of source.matchAll(STATIC_IMPORT_RE)) found.push({ specifier: m[3] ?? m[6], index: m.index });
    return found;
}

/**
 * `deniedContracts` в результате — что скан запрещает на уровне прав (сейчас: HTTP, если Модуль сеть не просил, но пытается ходить).
 * @param {unknown} source
 * @param {{ declaredNetwork?: boolean }} [options]  `declaredNetwork` — Модуль честно заявил сеть в шапке.
 * @returns {ScanResult}
 */
export function scanModuleSource(source, { declaredNetwork = false } = {}) {
    const text = String(source ?? '');
    /** @type {ScanFinding[]} */
    const findings = [];

    for (const imp of listImports(text)) {
        if (!STME_RE.test(imp.specifier)) {
            findings.push({ rule: 'bad-import', severity: 'block', message: `import "${imp.specifier}" — only "stme:<path>" is allowed`, line: lineOf(text, imp.index) });
        }
    }
    for (const { rule, severity, re, message } of RULES) {
        const match = re.exec(text);
        if (!match) continue;
        // Сеть, о которой Модуль честно заявил в шапке, — не нарушение: её всё равно проверит Гейт сети.
        if (rule === 'network' && declaredNetwork) continue;
        findings.push({ rule, severity, message, line: lineOf(text, match.index) });
    }

    const blocked = findings.some(f => f.severity === 'block');
    const tier = blocked ? 'rejected' : findings.length ? 'scanned-unsafe' : 'scanned-safe';
    const deniedContracts = findings.some(f => f.rule === 'network') ? ['http.request'] : [];
    return { tier, findings, deniedContracts };
}

/**
 * Подменяет `stme:<путь>` на реальные адреса. `resolve(path)` возвращает URL или null (неизвестный путь → ошибка, а не молчаливо
 * оставленный `stme:`). Исполняется ровно полученный текст.
 * @param {unknown} source
 * @param {(path: string) => string | null | undefined} resolve  `ui/tree` → адрес модуля.
 * @returns {{ ok: boolean, source: string, errors: string[] }}
 */
export function rewriteImports(source, resolve) {
    const text = String(source);
    /** @type {string[]} */
    const errors = [];
    // Подменяются ТОЛЬКО спецификаторы настоящих import/export-from: упоминание `stme:...` в комментарии или строке — не импорт.
    /** @type {Array<{ at: number, length: number, url: string }>} */
    const edits = [];
    for (const m of text.matchAll(STATIC_IMPORT_RE)) {
        const specifier = m[3] ?? m[6];
        if (!specifier.startsWith('stme:')) continue;
        if (!STME_RE.test(specifier)) { errors.push(`bad specifier "${specifier}"`); continue; }
        const url = resolve(specifier.slice('stme:'.length));
        if (!url) { errors.push(`unknown "${specifier}"`); continue; }
        edits.push({ at: m.index + m[0].lastIndexOf(specifier), length: specifier.length, url });
    }
    let out = text;
    for (const edit of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, edit.at) + edit.url + out.slice(edit.at + edit.length);
    return { ok: errors.length === 0, source: out, errors };
}

/**
 * SHA-256 исходника в hex — отпечаток для карантина «по хэшу» и проверки установленной копии.
 * @param {unknown} source
 * @param {{ subtle?: SubtleCrypto }} [options]  Подмена WebCrypto (тесты).
 * @returns {Promise<string>}
 */
export async function computeSourceHash(source, { subtle = globalThis.crypto?.subtle } = {}) {
    if (!subtle) throw new Error('computeSourceHash: WebCrypto is not available.');
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(String(source)));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
