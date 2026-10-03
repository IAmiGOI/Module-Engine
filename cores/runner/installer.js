// @ts-check
import { analyzeExternalModule } from '../../libraries/core/module-analyze.js';
import { parseThirdPartyList, buildVerifiedEntries, catalogListingUrl, catalogThirdPartyUrl, parseModuleLink, rawModuleUrl } from '../../libraries/core/module-catalog.js';

/** @typedef {import('../../libraries/core/module-types.js').InstallerOptions} InstallerOptions */
/** @typedef {import('../../libraries/core/module-types.js').InstallerCore} InstallerCore */
/** @typedef {import('../../libraries/core/module-types.js').InstalledModule} InstalledModule */
/** @typedef {import('../../libraries/core/module-types.js').QuarantineRecord} QuarantineRecord */
/** @typedef {import('../../libraries/core/module-types.js').Catalog} Catalog */
/** @typedef {import('../../libraries/core/module-types.js').CatalogEntry} CatalogEntry */
/** @typedef {import('../../libraries/core/module-types.js').PreviewResult} PreviewResult */
/** @typedef {import('../../libraries/core/module-types.js').RepoRef} RepoRef */

const INSTALLED_KEY = 'installedModules';
const QUARANTINE_KEY = 'quarantinedModules';
const CATALOG_KEY = 'catalogRepository';
/** Каталог по умолчанию: подтверждённые Модули движка. Пользователь может указать свой. */
export const DEFAULT_CATALOG_REPOSITORY = 'IAmiGOI/Module-Engine-Modules';

/**
 * @param {unknown} error
 * @returns {string}
 */
const messageOf = error => (error instanceof Error ? error.message : String(error));

/**
 * Установщик внешних Модулей (RUNTIME.md, фаза 3): каталог → предпросмотр → установка → хранилище → карантин.
 *
 * Сеть приходит инъекцией (`fetchText`) — настоящая идёт через сетевую Шину от Ядра с `networkAccess` (harness/module-runtime.js),
 * а не от самого Модуля: Модулю сеть не нужна, чтобы его скачали. Установка ничего не ИСПОЛНЯЕТ — только читает текст, разбирает
 * шапку, сканирует и хэширует; код попадёт в страницу не раньше, чем Раннер загрузит включённый Модуль.
 *
 * Хранилище (`store`) — два ключа: установленные Модули (с самим исходником — запуск не зависит от сети) и карантин. Карантин
 * привязан к id: исправленная версия под тем же именем не снимает его сама, только явное решение пользователя (`releaseQuarantine`).
 *
 * @param {InstallerOptions} options
 * @returns {InstallerCore}
 */
export function createModuleInstaller({ fetchText, store, reservedIds = () => [], resolveStme = null, now = Date.now }) {
    /** @type {InstalledModule[]} */
    let installed = [];
    /** @type {QuarantineRecord[]} */
    let quarantined = [];

    async function load() {
        // Данные пришли из хранилища пользователя, а не из нашего кода: форму проверяем, а не предполагаем.
        const storedInstalled = await store.read(INSTALLED_KEY, /** @type {InstalledModule[]} */ ([]));
        const storedQuarantine = await store.read(QUARANTINE_KEY, /** @type {QuarantineRecord[]} */ ([]));
        installed = storedInstalled.filter(item => item?.id && typeof item.source === 'string');
        quarantined = storedQuarantine.filter(item => item?.id);
        return { installed: list(), quarantined: [...quarantined] };
    }

    const saveInstalled = () => store.write(INSTALLED_KEY, installed);
    const saveQuarantine = () => store.write(QUARANTINE_KEY, quarantined);

    function list() {
        return installed.map(({ source, ...info }) => info);
    }

    /** Источники для Раннера: исходник берётся из хранилища, не из сети. */
    function sources() {
        return installed.map(item => /** @type {const} */ ({ origin: 'installed', path: item.url, source: item.source }));
    }

    /**
     * @param {string} url
     * @returns {Promise<string>}
     */
    async function getText(url) {
        const result = await fetchText(url);
        if (!result?.ok) throw new Error(`HTTP ${result?.status ?? '?'} for ${url}`);
        return result.text;
    }

    /**
     * Каталог: подтверждённые (папки `modules/*` репозитория каталога) + сторонние (`third-party.txt`). Каждая половина падает
     * отдельно — недоступный список сторонних не прячет подтверждённые.
     *
     * @param {string | RepoRef} repository  `owner/repo`, ссылка на репозиторий или уже разобранный адрес.
     * @returns {Promise<Catalog>}
     */
    async function fetchCatalog(repository) {
        /** @type {Catalog} */
        const catalog = { verified: [], thirdParty: [], errors: [] };
        const repo = typeof repository === 'string' ? parseModuleLink(repository) : repository;
        if (!repo) { catalog.errors.push('catalog repository is not a GitHub link'); return catalog; }
        try {
            catalog.verified = buildVerifiedEntries(JSON.parse(await getText(catalogListingUrl(repo))), repo);
        } catch (error) { catalog.errors.push(`verified modules: ${messageOf(error)}`); }
        try {
            const parsed = parseThirdPartyList(await getText(catalogThirdPartyUrl(repo)));
            catalog.thirdParty = parsed.entries;
            catalog.errors.push(...parsed.errors);
        } catch (error) { catalog.errors.push(`third-party list: ${messageOf(error)}`); }
        return catalog;
    }

    /**
     * Предпросмотр, который не удался до разбора (нет ссылки, 404): тот же вид результата, что и у разобранного.
     * @param {CatalogEntry | null} entry
     * @param {string[]} errors
     * @returns {PreviewResult}
     */
    function failedPreview(entry, errors) {
        return { ok: false, meta: null, tier: 'rejected', findings: [], deniedContracts: [], hash: null, errors, entry, source: null, requestedRights: [], requestsNetwork: false, replaces: null };
    }

    /**
     * Скачать и разобрать, НИЧЕГО не устанавливая — это то, что видит пользователь перед согласием.
     *
     * @param {CatalogEntry | string} entryOrLink  Запись каталога или ссылка GitHub.
     * @returns {Promise<PreviewResult>}
     */
    async function preview(entryOrLink) {
        /** @type {CatalogEntry | null} */
        let entry;
        if (typeof entryOrLink === 'string') {
            const link = parseModuleLink(entryOrLink);
            entry = link ? { kind: 'thirdParty', name: entryOrLink, url: rawModuleUrl(link), link } : null;
        } else entry = entryOrLink ?? null;
        if (!entry) return failedPreview(null, ['not a GitHub module link']);

        let source;
        try { source = await getText(entry.url); } catch (error) { return failedPreview(entry, [messageOf(error)]); }

        const analysis = await analyzeExternalModule(source, { reservedIds: reservedIds(), resolveStme });
        const existing = analysis.meta ? installed.find(item => item.id === analysis.meta?.id) : undefined;
        const extra = {
            entry, source,
            // Что получит пользователь: заявленное шапкой — запрос; итог — уровень доверия по скану.
            requestedRights: analysis.meta?.rights ?? [],
            requestsNetwork: Boolean(analysis.meta?.network),
            replaces: existing ? existing.version : null,
        };
        if (analysis.meta && isQuarantined(analysis.meta.id)) {
            return { ...analysis, ok: false, tier: 'rejected', errors: [...analysis.errors, `"${analysis.meta.id}" is quarantined for breaking its rights`], ...extra };
        }
        return { ...analysis, ...extra };
    }

    /**
     * Установить то, что показал `preview()`. Повторно разбирается исходник — на случай подмены объекта между шагами.
     *
     * @param {PreviewResult} previewResult
     * @returns {Promise<import('../../libraries/core/module-types.js').InstalledInfo>}
     */
    async function install(previewResult) {
        if (!previewResult?.source || !previewResult.entry) throw new Error('install() needs the result of preview().');
        const analysis = await analyzeExternalModule(previewResult.source, { reservedIds: reservedIds(), resolveStme });
        if (!analysis.ok) throw new Error(`cannot install: ${analysis.errors.join('; ')}`);
        if (isQuarantined(analysis.meta.id)) throw new Error(`"${analysis.meta.id}" is quarantined.`);
        /** @type {InstalledModule} */
        const record = {
            id: analysis.meta.id, title: analysis.meta.title, version: analysis.meta.version,
            url: previewResult.entry.url, kind: previewResult.entry.kind ?? 'thirdParty',
            hash: analysis.hash, source: previewResult.source, installedAt: now(),
        };
        installed = [...installed.filter(item => item.id !== record.id), record];
        await saveInstalled();
        const { source, ...info } = record;
        return info;
    }

    /**
     * @param {string} id
     * @returns {Promise<boolean>}  `false` — такого установленного Модуля не было.
     */
    async function uninstall(id) {
        const before = installed.length;
        installed = installed.filter(item => item.id !== id);
        if (installed.length === before) return false;
        await saveInstalled();
        return true;
    }

    /** @type {InstallerCore['isQuarantined']} */
    const isQuarantined = id => quarantined.some(item => item.id === id);

    /**
     * Вызывается слушателем нарушений прав (cores/rights `onViolation`). Хэш берётся у установленной копии.
     * @type {InstallerCore['recordQuarantine']}
     */
    async function recordQuarantine({ callerId, contract }) {
        if (isQuarantined(callerId)) return;
        quarantined = [...quarantined, { id: callerId, hash: installed.find(item => item.id === callerId)?.hash ?? null, contract, at: now() }];
        await saveQuarantine();
    }

    /**
     * @param {string} id
     * @returns {Promise<boolean>}
     */
    async function releaseQuarantine(id) {
        const before = quarantined.length;
        quarantined = quarantined.filter(item => item.id !== id);
        if (quarantined.length === before) return false;
        await saveQuarantine();
        return true;
    }

    const getCatalogRepository = async () => (await store.read(CATALOG_KEY, '')) || DEFAULT_CATALOG_REPOSITORY;
    /** @param {string} value */
    const setCatalogRepository = value => store.write(CATALOG_KEY, String(value ?? '').trim());

    return { getCatalogRepository, setCatalogRepository, load, list, sources, fetchCatalog, preview, install, uninstall, isQuarantined, recordQuarantine, releaseQuarantine, quarantineList: () => [...quarantined] };
}
