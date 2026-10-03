import { analyzeExternalModule } from '../../libraries/core/module-analyze.js';
import { parseThirdPartyList, buildVerifiedEntries, catalogListingUrl, catalogThirdPartyUrl, parseModuleLink, rawModuleUrl } from '../../libraries/core/module-catalog.js';

/**
 * Установщик внешних Модулей (RUNTIME.md, фаза 3): каталог → предпросмотр → установка → хранилище → карантин.
 *
 * Сеть приходит инъекцией (`fetchText`) — настоящая идёт через сетевую Шину от Ядра с `networkAccess` (harness/engine-wiring.js),
 * а не от самого Модуля: Модулю сеть не нужна, чтобы его скачали. Установка ничего не ИСПОЛНЯЕТ — только читает текст, разбирает
 * шапку, сканирует и хэширует; код попадёт в страницу не раньше, чем Раннер загрузит включённый Модуль.
 *
 * Хранилище (`store`) — два ключа: установленные Модули (с самим исходником — запуск не зависит от сети) и карантин. Карантин
 * привязан к id: исправленная версия под тем же именем не снимает его сама, только явное решение пользователя (`releaseQuarantine`).
 */

const INSTALLED_KEY = 'installedModules';
const QUARANTINE_KEY = 'quarantinedModules';
const CATALOG_KEY = 'catalogRepository';
/** Каталог по умолчанию: подтверждённые Модули движка. Пользователь может указать свой. */
export const DEFAULT_CATALOG_REPOSITORY = 'IAmiGOI/Module-Engine-Modules';

export function createModuleInstaller({ fetchText, store, reservedIds = () => [], resolveStme = null, now = Date.now }) {
    let installed = [];     // [{ id, title, version, url, kind, hash, source, installedAt }]
    let quarantined = [];   // [{ id, hash, contract, at }]

    async function load() {
        installed = (await store.read(INSTALLED_KEY, [])).filter(item => item?.id && typeof item.source === 'string');
        quarantined = (await store.read(QUARANTINE_KEY, [])).filter(item => item?.id);
        return { installed: list(), quarantined: [...quarantined] };
    }

    const saveInstalled = () => store.write(INSTALLED_KEY, installed);
    const saveQuarantine = () => store.write(QUARANTINE_KEY, quarantined);

    function list() {
        return installed.map(({ source, ...info }) => info);
    }

    /** Источники для Раннера: исходник берётся из хранилища, не из сети. */
    function sources() {
        return installed.map(item => ({ origin: 'installed', path: item.url, source: item.source }));
    }

    async function getText(url) {
        const result = await fetchText(url);
        if (!result?.ok) throw new Error(`HTTP ${result?.status ?? '?'} for ${url}`);
        return result.text;
    }

    /**
     * Каталог: подтверждённые (папки `modules/*` репозитория каталога) + сторонние (`third-party.txt`). Каждая половина падает
     * отдельно — недоступный список сторонних не прячет подтверждённые.
     */
    async function fetchCatalog(repository) {
        const catalog = { verified: [], thirdParty: [], errors: [] };
        const repo = typeof repository === 'string' ? parseModuleLink(repository) : repository;
        if (!repo) { catalog.errors.push('catalog repository is not a GitHub link'); return catalog; }
        try {
            catalog.verified = buildVerifiedEntries(JSON.parse(await getText(catalogListingUrl(repo))), repo);
        } catch (error) { catalog.errors.push(`verified modules: ${error.message}`); }
        try {
            const parsed = parseThirdPartyList(await getText(catalogThirdPartyUrl(repo)));
            catalog.thirdParty = parsed.entries;
            catalog.errors.push(...parsed.errors);
        } catch (error) { catalog.errors.push(`third-party list: ${error.message}`); }
        return catalog;
    }

    /** Скачать и разобрать, НИЧЕГО не устанавливая — это то, что видит пользователь перед согласием. */
    async function preview(entryOrLink) {
        const entry = entryOrLink?.url ? entryOrLink : (() => { const link = parseModuleLink(entryOrLink); return link ? { kind: 'thirdParty', name: String(entryOrLink), url: rawModuleUrl(link), link } : null; })();
        if (!entry) return { ok: false, errors: ['not a GitHub module link'], entry: null };
        let source;
        try { source = await getText(entry.url); } catch (error) { return { ok: false, errors: [error.message], entry }; }
        const analysis = await analyzeExternalModule(source, { reservedIds: reservedIds(), resolveStme });
        const blockedByQuarantine = analysis.meta && isQuarantined(analysis.meta.id);
        const errors = blockedByQuarantine ? [...analysis.errors, `"${analysis.meta.id}" is quarantined for breaking its rights`] : analysis.errors;
        const existing = analysis.meta ? installed.find(item => item.id === analysis.meta.id) : null;
        return {
            ...analysis, ok: analysis.ok && !blockedByQuarantine, errors, entry, source,
            // Что получит пользователь: заявленное шапкой — запрос; итог — уровень доверия по скану.
            requestedRights: analysis.meta?.rights ?? [],
            requestsNetwork: Boolean(analysis.meta?.network),
            replaces: existing ? existing.version : null,
        };
    }

    /** Установить то, что показал `preview()`. Повторно разбирается исходник — на случай подмены объекта между шагами. */
    async function install(previewResult) {
        if (!previewResult?.source || !previewResult.entry) throw new Error('install() needs the result of preview().');
        const analysis = await analyzeExternalModule(previewResult.source, { reservedIds: reservedIds(), resolveStme });
        if (!analysis.ok) throw new Error(`cannot install: ${analysis.errors.join('; ')}`);
        if (isQuarantined(analysis.meta.id)) throw new Error(`"${analysis.meta.id}" is quarantined.`);
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

    async function uninstall(id) {
        const before = installed.length;
        installed = installed.filter(item => item.id !== id);
        if (installed.length === before) return false;
        await saveInstalled();
        return true;
    }

    const isQuarantined = id => quarantined.some(item => item.id === id);

    /** Вызывается слушателем нарушений прав (cores/rights `onViolation`). Хэш берётся у установленной копии. */
    async function recordQuarantine({ callerId, contract }) {
        if (isQuarantined(callerId)) return;
        quarantined = [...quarantined, { id: callerId, hash: installed.find(item => item.id === callerId)?.hash ?? null, contract, at: now() }];
        await saveQuarantine();
    }

    async function releaseQuarantine(id) {
        const before = quarantined.length;
        quarantined = quarantined.filter(item => item.id !== id);
        if (quarantined.length === before) return false;
        await saveQuarantine();
        return true;
    }

    const getCatalogRepository = async () => (await store.read(CATALOG_KEY, '')) || DEFAULT_CATALOG_REPOSITORY;
    const setCatalogRepository = value => store.write(CATALOG_KEY, String(value ?? '').trim());

    return { getCatalogRepository, setCatalogRepository, load, list, sources, fetchCatalog, preview, install, uninstall, isQuarantined, recordQuarantine, releaseQuarantine, quarantineList: () => [...quarantined] };
}
