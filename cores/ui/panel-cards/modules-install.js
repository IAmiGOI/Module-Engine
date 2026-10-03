import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';
import { Button, HoldButton, TextInput, Field, Row, Section, Badge, EmptyState } from '../../../libraries/shared/widgets.js';

/**
 * Установка внешних Модулей и разбор того, что не загрузилось (RUNTIME.md, фаза 4). Панель по-прежнему НЕ знает, как Модуль грузится:
 * она показывает то, что отдаёт реестр (`installer`, `problems()`), и просит его сделать. Пользователь всегда сначала видит
 * предпросмотр — уровень доверия, запрошенные права, находки скана — и только потом нажимает «Install».
 */

const TIER_TONE = { 'scanned-safe': 'ok', 'scanned-unsafe': 'error', community: 'muted', official: 'muted' };
const TIER_LABEL = { 'scanned-safe': 'scanned: safe', 'scanned-unsafe': 'scanned: unsafe', community: 'built-in', official: 'official' };

export function createModulesInstall({ registry, notify, refresh }) {
    const catalogRepository = signal('');
    const link = signal('');
    const busy = signal(false);
    const catalog = signal(null);          // { verified, thirdParty, errors }
    const preview = signal(null);          // результат installer.preview()
    const problems = signal([]);

    async function guarded(task) {
        if (busy.peek() || !registry?.installer) return;
        busy.set(true);
        try { await task(); } catch (error) { notify('error', error?.message ?? String(error)); } finally { busy.set(false); }
    }

    function reloadProblems() { problems.set(registry?.problems?.() ?? []); }

    async function loadSavedRepository() {
        if (registry?.installer) catalogRepository.set(await registry.installer.getCatalogRepository());
        reloadProblems();
    }

    const browseCatalog = () => guarded(async () => {
        await registry.installer.setCatalogRepository(catalogRepository.peek());
        catalog.set(await registry.installer.fetchCatalog(catalogRepository.peek()));
    });

    const showPreview = source => guarded(async () => {
        preview.set(await registry.installer.preview(source));
    });

    const confirmInstall = () => guarded(async () => {
        const record = await registry.installModule(preview.peek());
        notify('ok', `Installed ${record.title} ${record.version}. Switch it on in the list above.`);
        preview.set(null);
        link.set('');
        reloadProblems();
        refresh();
    });

    const removeModule = id => guarded(async () => {
        await registry.uninstallModule(id);
        reloadProblems();
        refresh();
    });

    const allowAgain = id => guarded(async () => {
        await registry.releaseQuarantine(id);
        reloadProblems();
        refresh();
    });

    function catalogRow(entry) {
        return h('div', { class: 'stme-install-row', key: entry.url },
            h('span', {}, entry.name),
            Button('Preview', () => showPreview(entry)),
        );
    }

    function previewPanel(result) {
        const meta = result.meta;
        return h('div', { class: 'stme-install-preview' },
            h('strong', {}, meta ? `${meta.title} ${meta.version}` : (result.entry?.name ?? 'Module')),
            meta ? h('small', {}, meta.id) : null,
            result.tier && result.tier !== 'rejected' ? Row(Badge(TIER_LABEL[result.tier] ?? result.tier, { tone: TIER_TONE[result.tier] ?? 'muted' })) : null,
            ...result.errors.map(text => h('p', { class: 'stme-error' }, text)),
            result.replaces ? h('small', {}, `Replaces the installed version ${result.replaces}.`) : null,
            result.requestedRights?.length ? h('small', {}, `Asks for: ${result.requestedRights.join(', ')}`) : null,
            result.requestsNetwork ? h('small', {}, 'Asks for network access — this is never granted automatically.') : null,
            ...(result.findings ?? []).map(f => h('small', { class: 'stme-finding' }, `line ${f.line}: ${f.message}`)),
            Row(
                Button('Install', confirmInstall, { disabled: !result.ok }),
                Button('Cancel', () => preview.set(null)),
            ),
        );
    }

    /** Секция «Install a module»: репозиторий каталога + произвольная ссылка + предпросмотр. */
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
            computed(() => (preview() ? previewPanel(preview()) : null)),
        );
    }

    /** Модули, которые Раннер не смог поднять: причина обязательна, у карантина — «Allow again». */
    function problemsSection() {
        return computed(() => {
            const items = problems();
            if (!items.length) return null;
            return Section('Could not load', { key: 'module-problems', subtitle: 'The rest of the engine is not affected.' },
                items.map(item => h('div', { class: 'stme-install-row', key: `${item.origin}:${item.path}:${item.id}` },
                    h('span', {}, `${item.id ?? item.path}`),
                    Badge(item.state, { tone: item.state === 'quarantined' ? 'error' : 'muted' }),
                    h('small', {}, item.reason),
                    item.state === 'quarantined' ? Button('Allow again', () => allowAgain(item.id)) : null,
                    item.origin === 'installed' && item.id ? HoldButton('Remove', () => removeModule(item.id)) : null,
                )));
        });
    }

    /** Строка под названием установленного Модуля: версия, уровень доверия, «Remove». Встроенным — ничего лишнего. */
    function installedBadges(entry) {
        if (entry.origin !== 'installed') return null;
        return Row(
            Badge(entry.version, { tone: 'muted' }),
            Badge(TIER_LABEL[entry.tier] ?? entry.tier, { tone: TIER_TONE[entry.tier] ?? 'muted' }),
            entry.error ? Badge('failed to start', { tone: 'error' }) : null,
            HoldButton('Remove', () => removeModule(entry.id)),
        );
    }

    return { installSection, problemsSection, installedBadges, loadSavedRepository, reloadProblems };
}
