// @ts-check
import { parseVersion, isValidRange } from './semver.js';

/** @typedef {import('./module-types.js').ModuleMeta} ModuleMeta */
/** @typedef {import('./module-types.js').Requirement} Requirement */
/** @typedef {import('./module-types.js').HeaderResult} HeaderResult */

/**
 * Шапка Модуля (RUNTIME.md): блок-комментарий `@module` в самом начале файла, строки `ключ: значение`. Читается КАК ТЕКСТ, без
 * исполнения — чужой Модуль можно проверить, не запуская. Чистая функция: никогда не бросает, возвращает { ok, meta, errors }.
 */

const HEADER_RE = /^﻿?\s*\/\*@module\b([\s\S]*?)\*\//;
const ID_RE = /^[a-z][a-zA-Z0-9]*(?:[.-][a-zA-Z0-9]+)+$/;
const KNOWN_KEYS = new Set(['id', 'title', 'description', 'version', 'engine', 'requires', 'rights', 'network', 'folder', 'factory']);
const FACTORY_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * @param {string} value
 * @returns {string[]}
 */
function splitList(value) {
    return value.split(',').map(item => item.trim()).filter(Boolean);
}

/**
 * `module.tracker@^1.0` → { id, range }; без `@` — любая версия.
 * @param {string} text
 * @returns {Requirement}
 */
function parseRequirement(text) {
    const at = text.indexOf('@');
    const id = (at === -1 ? text : text.slice(0, at)).trim();
    const range = at === -1 ? '*' : text.slice(at + 1).trim();
    return { id, range };
}

/**
 * @param {unknown} source  Исходник Модуля целиком (нестроковое значение читается как пустое).
 * @returns {HeaderResult}
 */
export function parseModuleHeader(source) {
    /** @type {string[]} */
    const errors = [];
    const match = HEADER_RE.exec(String(source ?? ''));
    if (!match) return { ok: false, meta: null, errors: ['no /*@module ... */ header at the top of the file'] };

    /** @type {Map<string, string>} */
    const fields = new Map();
    /** @type {string | null} */
    let lastKey = null;
    for (const rawLine of match[1].split(/\r?\n/)) {
        const line = rawLine.trim();
        // Пустая строка и `#`-комментарий пропускаются: длинному списку прав нужно объяснять, зачем каждое.
        if (!line || line.startsWith('#')) continue;
        // Список, оборванный запятой в конце строки, продолжается на следующей.
        const previous = lastKey === null ? undefined : fields.get(lastKey);
        if (lastKey !== null && previous?.endsWith(',')) { fields.set(lastKey, `${previous} ${line}`); continue; }
        const colon = line.indexOf(':');
        if (colon <= 0) { errors.push(`malformed header line: "${line}"`); continue; }
        const key = line.slice(0, colon).trim();
        if (!KNOWN_KEYS.has(key)) { errors.push(`unknown header key "${key}"`); continue; }
        if (fields.has(key)) { errors.push(`duplicate header key "${key}"`); continue; }
        fields.set(key, line.slice(colon + 1).trim());
        lastKey = key;
    }

    const id = fields.get('id') ?? '';
    if (!ID_RE.test(id)) errors.push(`"id" must look like "module.name" (got "${id}")`);
    const version = fields.get('version') ?? '';
    if (!parseVersion(version)) errors.push(`"version" must be MAJOR.MINOR.PATCH (got "${version}")`);
    const engine = fields.get('engine') ?? '*';
    if (!isValidRange(engine)) errors.push(`"engine" is not a valid version range ("${engine}")`);

    const requires = splitList(fields.get('requires') ?? '').map(parseRequirement);
    for (const req of requires) {
        if (!ID_RE.test(req.id)) errors.push(`"requires" has a bad id "${req.id}"`);
        else if (!isValidRange(req.range)) errors.push(`"requires" has a bad range for "${req.id}" ("${req.range}")`);
    }

    const networkText = (fields.get('network') ?? 'false').toLowerCase();
    if (!['true', 'false'].includes(networkText)) errors.push(`"network" must be true or false (got "${networkText}")`);

    const factory = fields.get('factory') ?? 'default';
    if (!FACTORY_RE.test(factory)) errors.push(`"factory" must be an export name (got "${factory}")`);

    if (errors.length) return { ok: false, meta: null, errors };
    return {
        ok: true,
        errors: [],
        meta: {
            id,
            title: fields.get('title') || id,
            description: fields.get('description') ?? '',
            version,
            engine,
            requires,
            rights: splitList(fields.get('rights') ?? ''),
            network: networkText === 'true',
            folder: fields.get('folder') || null,
            factory,
        },
    };
}
