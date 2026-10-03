// @ts-check
import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';
import { Button, HoldButton, TextInput, Field, Row, Section, Badge, EmptyState } from '../../../libraries/shared/widgets.js';

/** @typedef {import('../../../libraries/core/module-types.js').ModuleRegistry} ModuleRegistry */
/** @typedef {import('../../../libraries/core/module-types.js').RegistryListItem} RegistryListItem */
/** @typedef {import('../../../libraries/core/module-types.js').PreviewResult} PreviewResult */
/** @typedef {import('../../../libraries/core/module-types.js').Catalog} Catalog */
/** @typedef {import('../../../libraries/core/module-types.js').CatalogEntry} CatalogEntry */
/** @typedef {import('../../../libraries/core/module-types.js').RunnerProblem} RunnerProblem */
/** @typedef {import('../ui-types.js').UiNode} UiNode */
/** @typedef {import('../ui-types.js').UiChild} UiChild */

/** @type {Readonly<Record<string, string>>} */
const TIER_TONE = { 'scanned-safe': 'ok', 'scanned-unsafe': 'error', community: 'muted', official: 'muted' };
/** @type {Readonly<Record<string, string>>} */
const TIER_LABEL = { 'scanned-safe': 'scanned: safe', 'scanned-unsafe': 'scanned: unsafe', community: 'built-in', official: 'official' };

/**
 * Установка внешних Модулей и разбор того, что не загрузилось (RUNTIME.md, фаза 4). Панель по-прежнему НЕ знает, как Модуль грузится:
 * она показывает то, что отдаёт реестр (`installer`, `problems()`), и просит его сделать. Пользователь всегда сначала видит
 * предпросмотр — уровень доверия, запрошенные права, находки скана — и только потом нажимает «Install».
 *
 * @param {{ registry: ModuleRegistry | null | undefined, notify: (tone: string, text: string) => unknown, refresh: () => void }} deps
 *   `registry` может отсутствовать (упрощённые хосты и тесты панели): тогда секции просто ничего не делают.
 * @returns {{
 *   installSection: () => UiNode,
 *   problemsSection: () => import('../ui-types.js').Signal<UiNode | null>,
 *   installedBadges: (entry: RegistryListItem) => UiNode | null,
 *   loadSavedRepository: () => Promise<void>,
 *   reloadProblems: () => void }}
 */
export function createModulesInstall({ registry, notify, refresh }) {
    const catalogRepository = signal('');
    const link = signal('');
    const busy = signal(false);
    /** @type {import('../ui-types.js').Signal<Catalog | null>} */
    const catalog = signal(/** @type {Catalog | null} */ (null));
    /** @type {import('../ui-types.js').Signal<PreviewResult | null>} */
    const preview = signal(/** @type {PreviewResult | null} */ (null));
    /** @type {import('../ui-types.js').Signal<RunnerProblem[]>} */
    const problems = signal(/** @type {RunnerProblem[]} */ ([]));

    /**
     * Одно действие за раз и только если установщик подключён; любой сбой — уведомление, а не необработанная ошибка.
     * @param {(installer: NonNullable<ModuleRegistry['installer']>, registry: ModuleRegistry) => Promise<void>} task
     */
    async function guarded(task) {
        const installer = registry?.installer;
        if (busy.peek() || !registry || !installer) return;
        busy.set(true);
        try { await task(installer, registry); }
        catch (error) { notify('error', error instanceof Error ? error.message : String(error)); }
        finally { busy.set(false); }
    }

    function reloadProblems() { problems.set(registry?.problems?.() ?? []); }

    async function loadSavedRepository() {
        if (registry?.installer) catalogRepository.set(await registry.installer.getCatalogRepository());
        reloadProblems();
    }

    const browseCatalog = () => guarded(async installer => {
        await installer.setCatalogRepository(catalogRepository.peek());
        catalog.set(await installer.fetchCatalog(catalogRepository.peek()));
    });

    /** @param {CatalogEntry | string} source */
    const showPreview = source => guarded(async installer => {
        preview.set(await installer.preview(source));
    });

    const confirmInstall = () => guarded(async (_installer, reg) => {
        const current = preview.peek();
        if (!current) return;
        const record = await reg.installModule(current);
        notify('ok', `Installed ${record.title} ${record.version}. Switch it on in the list above.`);
        preview.set(null);
        link.set('');
        reloadProblems();
        refresh();
    });

    /** @param {string} id */
    const removeModule = id => guarded(async (_installer, reg) => {
        await reg.uninstallModule(id);
        reloadProblems();
        refresh();
    });

    /** @param {string} id */
    const allowAgain = id => guarded(async (_installer, reg) => {
        await reg.releaseQuarantine(id);
        reloadProblems();
        refresh();
    });

    /**
     * @param {CatalogEntry} entry
     * @returns {UiNode}
     */
    function catalogRow(entry) {
        return h('div', { class: 'stme-install-row', key: entry.url },
            h('span', {}, entry.name),
            Button('Preview', () => showPreview(entry)),
        );
    }

    /**
     * @param {PreviewResult} result
     * @returns {UiNode}
     */
    function previewPanel(result) {
        const meta = result.meta;
        return h('div', { class: 'stme-install-preview' },
            h('strong', {}, meta ? `${meta.title} ${meta.version}` : (result.entry?.name ?? 'Module')),
            meta ? h('small', {}, meta.id) : null,
            result.tier !== 'rejected' ? Row(Badge(TIER_LABEL[result.tier] ?? result.tier, { tone: TIER_TONE[result.tier] ?? 'muted' })) : null,
            ...result.errors.map(text => h('p', { class: 'stme-error' }, text)),
            result.replaces ? h('small', {}, `Replaces the installed version ${result.replaces}.`) : null,
            result.requestedRights.length ? h('small', {}, `Asks for: ${result.requestedRights.join(', ')}`) : null,
            result.requestsNetwork ? h('small', {}, 'Asks for network access — this is never granted automatically.') : null,
            ...result.findings.map(f => h('small', { class: 'stme-finding' }, `line ${f.line}: ${f.message}`)),
            Row(
                Button('Install', confirmInstall, { disabled: !result.ok }),
                Button('Cancel', () => preview.set(null)),
            ),
        );
    }

    /**
     * Секция «Install a module»: репозиторий каталога + произвольная ссылка + предпросмотр.
     * @returns {UiNode}
     */
    function installSection() {
        return Section('Install a module', { key: 'install-module', subtitle: 'Verified modules from a catalog, or any GitHub link. Nothing runs until you install it and switch it on.' },
            Field('Catalog repository', TextInput(catalogRepository, { placeholder: 'owner/repo' })),
            Row(Button('Browse catalog', browseCatalog, { disabled: false })),
            computed(() => {
                const data = catalog();
                if (!data) return null;
                return h('div', { class: 'stme-install-catalog' },
                    data.verified.length ? h('strong', {}, 'Verified') : null,
                    ...data.verified.map(catalogRow),
                    data.thirdParty.length ? h('strong', {}, 'Third-party (not reviewed)') : null,
                    ...data.thirdParty.map(catalogRow),
                    !data.verified.length && !data.thirdParty.length ? EmptyState('The catalog has no modules.') : null,
                    ...data.errors.map(text => h('small', { class: 'stme-error' }, text)),
                );
            }),
            Field('GitHub link', TextInput(link, { placeholder: 'https://github.com/owner/repo' })),
            Row(Button('Preview', () => showPreview(link.peek()))),
            computed(() => {
                const current = preview();
                return current ? previewPanel(current) : null;
            }),
        );
    }

    /**
     * Модули, которые Раннер не смог поднять: причина обязательна, у карантина — «Allow again».
     * @returns {import('../ui-types.js').Signal<UiNode | null>}
     */
    function problemsSection() {
        return computed(() => {
            const items = problems();
            if (!items.length) return null;
            return Section('Could not load', { key: 'module-problems', subtitle: 'The rest of the engine is not affected.' },
                items.map(item => {
                    const id = item.id;
                    return h('div', { class: 'stme-install-row', key: `${item.origin}:${item.path}:${id}` },
                        h('span', {}, `${id ?? item.path}`),
                        Badge(item.state, { tone: item.state === 'quarantined' ? 'error' : 'muted' }),
                        h('small', {}, item.reason),
                        // У записи в карантине id есть всегда; проверка нужна типу — и защищает от кнопки, которой нечего снимать.
                        item.state === 'quarantined' && id ? Button('Allow again', () => allowAgain(id)) : null,
                        item.origin === 'installed' && id ? HoldButton('Remove', () => removeModule(id)) : null,
                    );
                }));
        });
    }

    /**
     * Строка под названием установленного Модуля: версия, уровень доверия, «Remove». Встроенным — ничего лишнего.
     * @param {RegistryListItem} entry
     * @returns {UiNode | null}
     */
    function installedBadges(entry) {
        if (entry.origin !== 'installed') return null;
        const tier = entry.tier ?? '';
        return Row(
            Badge(entry.version ?? '', { tone: 'muted' }),
            Badge(TIER_LABEL[tier] ?? tier, { tone: TIER_TONE[tier] ?? 'muted' }),
            entry.error ? Badge('failed to start', { tone: 'error' }) : null,
            HoldButton('Remove', () => removeModule(entry.id)),
        );
    }

    return { installSection, problemsSection, installedBadges, loadSavedRepository, reloadProblems };
}
