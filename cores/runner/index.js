// @ts-check
import { parseModuleHeader } from '../../libraries/core/module-header.js';
import { resolveLoadOrder } from '../../libraries/core/module-order.js';
import { rewriteImports } from '../../libraries/core/module-scan.js';
import { analyzeExternalModule } from '../../libraries/core/module-analyze.js';

/** @typedef {import('../../libraries/core/module-types.js').ModuleMeta} ModuleMeta */
/** @typedef {import('../../libraries/core/module-types.js').ModuleDefinition} ModuleDefinition */
/** @typedef {import('../../libraries/core/module-types.js').RunnerEntry} RunnerEntry */
/** @typedef {import('../../libraries/core/module-types.js').RunnerProblem} RunnerProblem */
/** @typedef {import('../../libraries/core/module-types.js').RunnerOptions} RunnerOptions */
/** @typedef {import('../../libraries/core/module-types.js').RunnerCore} RunnerCore */
/** @typedef {import('../../libraries/core/module-types.js').ScanFinding} ScanFinding */
/** @typedef {import('../../libraries/shared/bus-types.js').RightsConfig} RightsConfig */
/** @typedef {import('../../libraries/shared/bus-types.js').TrustTier} TrustTier */

/**
 * Разобранный и допущенный Модуль — всё, что нужно, чтобы собрать из него определение.
 * @typedef {Object} PreparedModule
 * @property {ModuleMeta} meta
 * @property {RunnerEntry} entry
 * @property {RightsConfig} rights
 * @property {TrustTier} tier
 * @property {string | null} hash
 * @property {ScanFinding[]} findings
 * @property {() => Promise<any>} loadExports  Загружает код Модуля и отдаёт его экспорты.
 */

/** `stme:<путь>` → путь внутри движка. Единственное, что внешний Модуль вправе импортировать. */
export const STME_PATHS = Object.freeze({
    'ui/tree': 'cores/ui/tree.js',
    'ui/reactive': 'cores/ui/reactive.js',
    'widgets': 'libraries/shared/widgets.js',
    'request': 'libraries/shared/request.js',
});

/**
 * Ядро Раннера (RUNTIME.md, фаза 2): превращает ИСТОЧНИКИ Модулей (встроенные из папки, установленные из репозиториев) в
 * определения, которые понимает реестр, — вместо захардкоженного списка. Само ничего не включает: включение/выключение остаётся
 * за реестром (`createModuleRegistry`), Раннер отвечает на вопросы «что есть», «в каком порядке», «с какими правами» и «почему
 * не загружается».
 *
 * Источник — { origin: 'builtin'|'installed', path, load(), source? }:
 *  - `builtin`: исходник читается как ТЕКСТ (`readSource`) только ради шапки; код приходит обычным `load()` (import). Права — из
 *    шапки, уровень `community` с явным списком контрактов (Модуль, едущий с движком, ходит тем же путём, что и чужой — иначе
 *    Гейт на этом пути никогда бы не проверялся; решение из engine-wiring.js).
 *  - `installed`: исходник пришёл как текст (из хранилища). Он хэшируется, сканируется, импорты `stme:` подменяются, и
 *    исполняется ровно проверенный текст (Blob URL). Права — по результату скана; сеть шапкой только ЗАПРАШИВАЕТСЯ, а не даётся.
 *
 * Сбой одного Модуля (плохая шапка, отказ скана, нет зависимости) не мешает остальным: он попадает в `problems()` с причиной.
 *
 * @param {RunnerOptions} options
 * @returns {RunnerCore}
 */
export function createRunnerCore({
    engineVersion,
    readSource,
    resolveStme = () => null,
    importBlob = async source => import(URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))),
    isQuarantined = () => false,
    available = new Map(),
}) {
    /** @type {ModuleDefinition[]} В порядке загрузки; ту же ссылку держит реестр. */
    const definitions = [];
    /** @type {RunnerProblem[]} */
    const problemList = [];
    /** @type {Map<string, { id: string, version: string, origin: string, tier: TrustTier, hash: string | null }>} Описание для статуса. */
    const known = new Map();
    /** @type {Set<string>} */
    const builtinIds = new Set();

    /**
     * @param {{ path: string, origin: string }} entry
     * @param {RunnerProblem['state']} state
     * @param {string} reason
     * @param {{ id?: string | null, findings?: ScanFinding[] }} [extra]
     */
    function problem(entry, state, reason, extra = {}) {
        problemList.push({ id: extra.id ?? null, path: entry.path, origin: entry.origin, state, reason, findings: extra.findings ?? [] });
    }

    /**
     * @param {RunnerEntry} entry
     * @returns {Promise<PreparedModule | null>}  `null` — Модуль не допущен (причина уже в `problems()`).
     */
    async function prepare(entry) {
        const source = entry.source ?? await readSource(entry.path);

        if (entry.origin === 'builtin') {
            const header = parseModuleHeader(source);
            if (!header.ok) { problem(entry, 'invalid', header.errors.join('; ')); return null; }
            const { meta } = header;
            builtinIds.add(meta.id);
            const load = entry.load;
            if (!load) { problem(entry, 'invalid', 'a built-in module needs a load() function', { id: meta.id }); return null; }
            return {
                meta, entry,
                rights: { tier: 'community', allowedContracts: meta.rights, networkAccess: meta.network },
                tier: 'community', hash: null, findings: [],
                loadExports: () => load(),
            };
        }

        // Внешний: тот же разбор, что видел пользователь в предпросмотре установки (module-analyze.js), — заново при КАЖДОМ запуске.
        const analysis = await analyzeExternalModule(source, { reservedIds: [...builtinIds], resolveStme });
        if (!analysis.ok) { problem(entry, analysis.meta ? 'rejected' : 'invalid', analysis.errors.join('; '), { id: analysis.meta?.id, findings: analysis.findings }); return null; }
        const { meta, hash, tier, findings, deniedContracts } = analysis;
        if (isQuarantined(meta.id, hash)) { problem(entry, 'quarantined', 'quarantined earlier for breaking its rights', { id: meta.id, findings }); return null; }
        const rewritten = rewriteImports(source, resolveStme);
        if (!rewritten.ok) { problem(entry, 'rejected', rewritten.errors.join('; '), { id: meta.id, findings }); return null; }
        return {
            meta, entry, hash,
            // Запрошенные шапкой права для внешнего — лишь пожелание: итоговое решает скан (default-allow минус запрещённое).
            // Любое обращение за пределы прав — карантин (cores/rights/index.js), сохраняется между запусками.
            rights: { tier, deniedContracts, networkAccess: false, quarantineOnViolation: true },
            tier, findings,
            loadExports: () => importBlob(rewritten.source),
        };
    }

    /**
     * Разобрать источники и заполнить `definitions` (на месте — ссылку уже держит реестр).
     * @param {RunnerEntry[]} entries
     * @returns {Promise<{ definitions: ModuleDefinition[], problems: RunnerProblem[] }>}
     */
    async function discover(entries) {
        definitions.length = 0;
        problemList.length = 0;
        known.clear();

        /** @type {PreparedModule[]} */
        const prepared = [];
        builtinIds.clear();
        // Встроенные разбираются первыми: их id нужны, чтобы внешний Модуль не мог выдать себя за встроенный.
        const ordered = [...entries].sort((a, b) => (a.origin === 'builtin' ? 0 : 1) - (b.origin === 'builtin' ? 0 : 1));
        for (const entry of ordered) {
            try {
                const item = await prepare(entry);
                if (item) prepared.push(item);
            } catch (error) {
                problem(entry, 'invalid', `could not read: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        const { order, blocked } = resolveLoadOrder(prepared.map(p => p.meta), { engineVersion, available });
        /** @type {Map<string, PreparedModule>} */
        const byId = new Map();
        for (const item of prepared) if (!byId.has(item.meta.id)) byId.set(item.meta.id, item);
        for (const { id, reason } of blocked) {
            const item = byId.get(id);
            problem(item?.entry ?? { path: '?', origin: 'unknown' }, 'blocked', reason, { id });
        }

        for (const id of order) {
            const item = byId.get(id);
            if (!item) continue;
            const { meta, entry, rights, tier, hash, findings, loadExports } = item;
            known.set(id, { id, version: meta.version, origin: entry.origin, tier, hash });
            definitions.push({
                id, title: meta.title, description: meta.description, folder: meta.folder ?? undefined,
                version: meta.version, origin: entry.origin, tier, hash, findings,
                rights,
                create: async host => {
                    const exports = await loadExports();
                    const factory = exports?.[meta.factory];
                    if (typeof factory !== 'function') throw new Error(`module "${id}" has no export "${meta.factory}" to create it from.`);
                    return factory(host);
                },
            });
        }
        return { definitions, problems: problems() };
    }

    /** @returns {RunnerProblem[]} */
    function problems() { return problemList.map(item => ({ ...item })); }

    return { discover, definitions, problems, info: id => known.get(id) ?? null };
}
