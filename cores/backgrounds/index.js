import { request } from '../../libraries/shared/request.js';
import { planBackgroundSync, encodeRepoPath, DEFAULT_MAX_BYTES } from '../../libraries/core/background-sync.js';

/**
 * Ядро фонов — держит в SillyTavern те фоны, что лежат в отдельном репозитории (по умолчанию `IAmiGOI/Module-Engine-Backgrounds`).
 * Кинул файл в репозиторий — при следующем запуске он сам оказывается в списке фонов ST под именем `stme-<папка>-<файл>`.
 *
 * Механика: дерево репозитория (GitHub `git/trees/HEAD?recursive=1`, с ETag — пока в репозитории ничего не менялось, ответ
 * «304» и работы нет) → план [`background-sync.js`](../../libraries/core/background-sync.js) → скачать новое/изменённое
 * (`raw.githubusercontent.com`) → положить в ST её же эндпоинтом загрузки (`stBackgrounds.upload`) → запомнить, что поставили.
 * Что именно ставили МЫ, хранится в настройках (`state.installed`): только это можно потом убрать и только это не воскресает,
 * если пользователь удалил его руками.
 *
 * Молчит, когда сказать нечего: нет сети, GitHub отказал, репозиторий пуст — ничего в интерфейсе и без последствий, повторится
 * при следующем запуске. Сеть — только через сетевую Шину (у Ядра выдано право `networkAccess`), как у самообновления.
 */

const NAMESPACE = 'core.backgrounds';
const STATE_KEY = 'state';
const GITHUB_API = 'https://api.github.com';
const RAW_HOST = 'https://raw.githubusercontent.com';
const NETWORK_TIMEOUT_MS = 20000;
const DOWNLOAD_TIMEOUT_MS = 60000;

const DEFAULT_STATE = Object.freeze({ enabled: true, removeDeleted: true, etag: null, installed: {}, lastSync: null });

export function createBackgroundsCore(host, {
    owner,
    repo,
    log = console,
    now = () => Date.now(),
    maxBytes = DEFAULT_MAX_BYTES,
    publish,
    networkTimeoutMs = NETWORK_TIMEOUT_MS,
    downloadTimeoutMs = DOWNLOAD_TIMEOUT_MS,
} = {}) {
    const publishEvent = publish ?? ((event, payload) => host.events.emit(event, payload));
    let state = { ...DEFAULT_STATE, installed: {} };
    let loaded = false;
    let running = false;
    let lastOutcome = null;

    const service = (contract, params, options = {}) => request(host.services, contract, { params, ...options });

    async function load() {
        if (loaded) return state;
        const result = await request(host.own, 'storage.settings.get', { params: { namespace: NAMESPACE, key: STATE_KEY, fallback: null } });
        const stored = result.ok && result.value && typeof result.value === 'object' ? result.value : {};
        state = { ...DEFAULT_STATE, ...stored, installed: { ...(stored.installed ?? {}) } };
        loaded = true;
        return state;
    }

    async function save() {
        await request(host.own, 'storage.settings.set', { params: { namespace: NAMESPACE, key: STATE_KEY, value: state } });
    }

    /** Дерево репозитория. `{ status: 'unchanged' | 'empty' | 'failed' | 'ok', ... }` — никогда не бросает. */
    async function fetchTree({ force }) {
        const headers = { Accept: 'application/vnd.github+json' };
        if (!force && state.etag) headers['If-None-Match'] = state.etag;
        const result = await request(host.network, 'http.request', {
            params: { url: `${GITHUB_API}/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`, method: 'GET', headers },
            timeoutMs: networkTimeoutMs,
        });
        if (!result.ok || !result.value) return { status: 'failed', reason: result.error?.message ?? 'no response' };
        const { status, text, headers: responseHeaders } = result.value;
        if (status === 304) return { status: 'unchanged' };
        if (status === 409) return { status: 'empty' };
        if (!result.value.ok) return { status: 'failed', reason: `GitHub answered HTTP ${status}` };
        try {
            const data = JSON.parse(text);
            return { status: 'ok', tree: Array.isArray(data?.tree) ? data.tree : [], truncated: Boolean(data?.truncated), etag: responseHeaders?.etag ?? null };
        } catch {
            return { status: 'failed', reason: 'unreadable tree response' };
        }
    }

    async function download(path) {
        const result = await request(host.network, 'http.request', {
            params: { url: `${RAW_HOST}/${owner}/${repo}/HEAD/${encodeRepoPath(path)}`, method: 'GET', responseType: 'blob' },
            timeoutMs: downloadTimeoutMs,
        });
        if (!result.ok || !result.value?.ok || !result.value.blob) throw new Error(result.error?.message ?? `download HTTP ${result.value?.status ?? '?'}`);
        return result.value.blob;
    }

    /**
     * Один полный ход. `force` — игнорировать ETag (кнопка «Sync now»). Возвращает `{ outcome, installed, removed, skipped, error? }`.
     * Отдельные файлы, которые не удалось скачать/положить, не валят ход: остальные ставятся, а неудачные повторятся в следующий раз
     * (их запись в индекс не попадает).
     */
    async function sync({ force = false } = {}) {
        if (running) return { outcome: 'busy' };
        running = true;
        try {
            await load();
            if (!state.enabled && !force) return remember({ outcome: 'disabled' });
            if (!owner || !repo) return remember({ outcome: 'unconfigured' });

            const tree = await fetchTree({ force });
            if (tree.status === 'unchanged') return remember({ outcome: 'unchanged' });
            if (tree.status === 'empty') return remember({ outcome: 'empty' });
            if (tree.status === 'failed') {
                log.info?.('[ST Module Engine (Beta)] Backgrounds: sync skipped —', tree.reason);
                return remember({ outcome: 'unavailable', error: tree.reason });
            }

            const listed = await service('stBackgrounds.list', {});
            if (!listed.ok) return remember({ outcome: 'unavailable', error: listed.error.message });

            const plan = planBackgroundSync({ tree: tree.tree, installed: state.installed, existing: listed.value, removeDeleted: state.removeDeleted, maxBytes });
            let installed = 0;
            let removed = 0;
            let failed = 0;

            for (const path of plan.markUserRemoved) if (state.installed[path]) state.installed[path] = { ...state.installed[path], userRemoved: true };

            const total = plan.install.length;
            for (const [index, item] of plan.install.entries()) {
                publishEvent('backgrounds.progress', { done: index, total, name: item.name });
                try {
                    const blob = await download(item.path);
                    const uploaded = await service('stBackgrounds.upload', { name: item.name, blob });
                    if (!uploaded.ok) throw new Error(uploaded.error.message);
                    state.installed[item.path] = { sha: item.sha, name: item.name };
                    installed += 1;
                    await save();
                } catch (error) {
                    failed += 1;
                    log.warn?.(`[ST Module Engine (Beta)] Backgrounds: could not install "${item.path}":`, error?.message ?? error);
                }
            }

            for (const item of plan.remove) {
                const deleted = await service('stBackgrounds.delete', { name: item.name });
                if (deleted.ok) { delete state.installed[item.path]; removed += 1; }
            }
            for (const path of plan.forget) delete state.installed[path];

            // ETag запоминаем, только если всё, что нужно, легло: иначе следующий запуск получит «304» и не докачает недостающее.
            state.etag = failed === 0 ? tree.etag : null;
            state.lastSync = now();
            await save();

            if (installed || removed) await service('stBackgrounds.refresh', {});
            publishEvent('backgrounds.synced', { installed, removed, failed, skipped: plan.skipped.length, total: plan.remoteCount });
            if (installed || removed) log.info?.(`[ST Module Engine (Beta)] Backgrounds: +${installed} / -${removed}${failed ? ` (${failed} failed)` : ''}.`);
            return remember({ outcome: 'synced', installed, removed, failed, skipped: plan.skipped.length, total: plan.remoteCount });
        } catch (error) {
            log.warn?.('[ST Module Engine (Beta)] Backgrounds: sync failed:', error?.message ?? error);
            return remember({ outcome: 'failed', error: error?.message ?? String(error) });
        } finally {
            running = false;
        }
    }

    function remember(result) {
        lastOutcome = { ...result, at: now() };
        return result;
    }

    async function status() {
        await load();
        return {
            enabled: state.enabled,
            removeDeleted: state.removeDeleted,
            installedCount: Object.keys(state.installed).length,
            lastSync: state.lastSync,
            lastOutcome,
            running,
            repository: { owner, repo },
        };
    }

    async function setSettings({ enabled, removeDeleted } = {}) {
        await load();
        if (typeof enabled === 'boolean') state.enabled = enabled;
        if (typeof removeDeleted === 'boolean') state.removeDeleted = removeDeleted;
        await save();
        return status();
    }

    const unregisters = [
        host.own.register('backgrounds.sync', params => sync(params)),
        host.own.register('backgrounds.status', () => status()),
        host.own.register('backgrounds.setSettings', params => setSettings(params)),
    ];

    return { sync, status, setSettings, unregister: () => { for (const unregister of unregisters) unregister(); } };
}
