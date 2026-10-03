import { parseModuleHeader } from './module-header.js';
import { scanModuleSource, computeSourceHash, rewriteImports } from './module-scan.js';

/**
 * Единый разбор исходника ВНЕШНЕГО Модуля: шапка + скан + хэш + правила допуска. Зовут и установщик (предпросмотр перед установкой),
 * и Раннер (при каждом запуске) — иначе «что показали пользователю» и «что реально проверено при загрузке» могли бы разойтись.
 */

/** Внешний Модуль живёт в своём неймспейсе: имя `module.*` принадлежит встроенным, подделать его нельзя. */
export const EXTERNAL_ID_PREFIX = 'community.';
export const MAX_MODULE_SOURCE_BYTES = 512 * 1024;

/**
 * @returns {Promise<{ ok: boolean, meta, tier, findings, deniedContracts, hash, errors: string[] }>}
 *   ok === false — устанавливать/загружать нельзя; `errors` — человеческие причины.
 */
export async function analyzeExternalModule(source, { reservedIds = [], resolveStme = null } = {}) {
    const text = String(source ?? '');
    const bytes = new TextEncoder().encode(text).byteLength;
    if (bytes > MAX_MODULE_SOURCE_BYTES) {
        return { ok: false, meta: null, tier: 'rejected', findings: [], deniedContracts: [], hash: null, errors: [`source is ${bytes} bytes, the limit is ${MAX_MODULE_SOURCE_BYTES}`] };
    }
    const header = parseModuleHeader(text);
    if (!header.ok) return { ok: false, meta: null, tier: 'rejected', findings: [], deniedContracts: [], hash: null, errors: header.errors };
    const { meta } = header;

    const errors = [];
    if (!meta.id.startsWith(EXTERNAL_ID_PREFIX)) errors.push(`an external module id must start with "${EXTERNAL_ID_PREFIX}" (got "${meta.id}")`);
    if (reservedIds.includes(meta.id)) errors.push(`id "${meta.id}" belongs to a built-in module`);

    // Если известно, во что превращаются `stme:`-импорты, проверяем это УЖЕ в предпросмотре: «предпросмотр ок» обязано значить «загрузится».
    if (resolveStme) errors.push(...rewriteImports(text, resolveStme).errors);

    const scan = scanModuleSource(text, { declaredNetwork: meta.network });
    for (const finding of scan.findings.filter(f => f.severity === 'block')) errors.push(`${finding.message} (line ${finding.line})`);
    const hash = await computeSourceHash(text);
    return { ok: errors.length === 0, meta, tier: errors.length ? 'rejected' : scan.tier, findings: scan.findings, deniedContracts: scan.deniedContracts, hash, errors };
}
