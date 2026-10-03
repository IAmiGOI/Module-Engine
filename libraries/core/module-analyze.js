// @ts-check
import { parseModuleHeader } from './module-header.js';
import { scanModuleSource, computeSourceHash, rewriteImports } from './module-scan.js';

/** @typedef {import('./module-types.js').Analysis} Analysis */
/** @typedef {import('./module-types.js').ModuleMeta} ModuleMeta */

/**
 * Единый разбор исходника ВНЕШНЕГО Модуля: шапка + скан + хэш + правила допуска. Зовут и установщик (предпросмотр перед установкой),
 * и Раннер (при каждом запуске) — иначе «что показали пользователю» и «что реально проверено при загрузке» могли бы разойтись.
 */

/** Внешний Модуль живёт в своём неймспейсе: имя `module.*` принадлежит встроенным, подделать его нельзя. */
export const EXTERNAL_ID_PREFIX = 'community.';
export const MAX_MODULE_SOURCE_BYTES = 512 * 1024;

/**
 * @param {unknown} source
 * @param {{ reservedIds?: string[], resolveStme?: ((path: string) => string | null | undefined) | null }} [options]
 *   `reservedIds` — id встроенных Модулей, которые занять нельзя. `resolveStme` — во что превращается `stme:<путь>`: если задан,
 *   неизвестный путь отклоняется уже здесь («предпросмотр ок» обязано значить «загрузится»).
 * @returns {Promise<Analysis>}
 */
export async function analyzeExternalModule(source, { reservedIds = [], resolveStme = null } = {}) {
    const text = String(source ?? '');

    const bytes = new TextEncoder().encode(text).byteLength;
    if (bytes > MAX_MODULE_SOURCE_BYTES) {
        return rejected(null, [`source is ${bytes} bytes, the limit is ${MAX_MODULE_SOURCE_BYTES}`]);
    }
    const header = parseModuleHeader(text);
    if (!header.ok) return rejected(null, header.errors);
    const { meta } = header;

    /** @type {string[]} */
    const errors = [];
    if (!meta.id.startsWith(EXTERNAL_ID_PREFIX)) errors.push(`an external module id must start with "${EXTERNAL_ID_PREFIX}" (got "${meta.id}")`);
    if (reservedIds.includes(meta.id)) errors.push(`id "${meta.id}" belongs to a built-in module`);

    if (resolveStme) errors.push(...rewriteImports(text, resolveStme).errors);

    const scan = scanModuleSource(text, { declaredNetwork: meta.network });
    for (const finding of scan.findings.filter(f => f.severity === 'block')) errors.push(`${finding.message} (line ${finding.line})`);
    const hash = await computeSourceHash(text);

    const { tier, findings, deniedContracts } = scan;
    if (errors.length || tier === 'rejected') return { ok: false, meta, tier: 'rejected', findings, deniedContracts, hash, errors };
    return { ok: true, meta, tier, findings, deniedContracts, hash, errors };
}

/**
 * @param {ModuleMeta | null} meta
 * @param {string[]} errors
 * @returns {Analysis}
 */
function rejected(meta, errors) {
    return { ok: false, meta, tier: 'rejected', findings: [], deniedContracts: [], hash: null, errors };
}
