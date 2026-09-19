import { DEFAULT_GITHUB_MAX_FILE_BYTES, sanitizeGithubSettings } from './sync-github.js';

/**
 * Категории и настройки синхронизации — чистые функции без ввода-вывода.
 *
 * Категория — то, что пользователь включает галочкой («Chats», «Backgrounds»); раздел — первая часть пути файла
 * (`groupChats/…`). Несколько разделов могут принадлежать одной категории (все виды чатов — одна галочка).
 */

export const SYNC_CATEGORY_IDS = Object.freeze(['characters', 'chats', 'worlds', 'backgrounds', 'personas']);

const SECTION_TO_CATEGORY = Object.freeze({
    characters: 'characters',
    chats: 'chats',
    groups: 'chats',
    groupChats: 'chats',
    worlds: 'worlds',
    backgrounds: 'backgrounds',
    personas: 'personas',
});

export function categoryOfPath(path) {
    const slash = String(path).indexOf('/');
    return slash > 0 ? (SECTION_TO_CATEGORY[path.slice(0, slash)] ?? null) : null;
}

/** Фильтр путей по включённым категориям; неизвестные разделы не синхронизируются никогда. */
export function createCategoryFilter(enabled) {
    const set = new Set(enabled);
    return path => set.has(categoryOfPath(path));
}

/** Категории, включённые на ОБЕИХ сторонах. */
export function intersectCategories(a = [], b = []) {
    const other = new Set(b);
    return a.filter(id => other.has(id));
}

export function sanitizeCategories(raw) {
    if (!Array.isArray(raw)) return [...SYNC_CATEGORY_IDS];
    return SYNC_CATEGORY_IDS.filter(id => raw.includes(id));
}

const CLOUD_PROVIDERS = ['dropbox', 'google'];

/** STUN — узнать свой внешний адрес; нужен всегда. Прямое соединение через него проходит не везде (см. TURN ниже). */
export const DEFAULT_ICE_SERVERS = Object.freeze([{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }]);

const ICE_URL = /^(stuns?|turns?):[^\s]+$/i;

/** Свои серверы соединения: только корректные адреса; `null` — нет своих. */
export function sanitizeIceServers(raw) {
    if (!Array.isArray(raw)) return null;
    const servers = raw.map(server => {
        const urls = (Array.isArray(server?.urls) ? server.urls : [server?.urls]).map(String).filter(url => ICE_URL.test(url));
        if (!urls.length) return null;
        const clean = { urls };
        if (server.username) clean.username = String(server.username);
        if (server.credential) clean.credential = String(server.credential);
        return clean;
    }).filter(Boolean);
    return servers.length ? servers : null;
}

/** Всё, что отдаётся соединению: STUN по умолчанию плюс свой ретранслятор (если задан). */
export const buildIceServers = custom => [...DEFAULT_ICE_SERVERS, ...(custom ?? [])];

/** Один ретранслятор из полей карточки → список серверов (`null`, если адрес пуст или некорректен). */
export const relayToIceServers = ({ url, username, credential } = {}) => sanitizeIceServers([{ urls: [String(url ?? '').trim()], username, credential }]);

/** Облачный диск: провайдер, токены (обновляются Ядром), свои ключи приложений, включён ли и в фоне ли. */
export function sanitizeCloudSettings(raw = {}) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const tokens = input.tokens && typeof input.tokens.accessToken === 'string'
        ? { accessToken: input.tokens.accessToken, refreshToken: String(input.tokens.refreshToken ?? ''), expiresAt: Number(input.tokens.expiresAt) || 0 }
        : null;
    const app = value => ({ clientId: String(value?.clientId ?? '').trim(), clientSecret: String(value?.clientSecret ?? '').trim() });
    return {
        provider: CLOUD_PROVIDERS.includes(input.provider) ? input.provider : 'dropbox',
        enabled: Boolean(input.enabled) && Boolean(tokens),
        auto: Boolean(input.auto),
        tokens,
        apps: { dropbox: app(input.apps?.dropbox), google: app(input.apps?.google) },
    };
}

const clampInterval = value => (Number.isFinite(Number(value)) ? Math.min(240, Math.max(1, Math.round(Number(value)))) : 10);

/**
 * Приводит сохранённую (возможно устаревшую или испорченную) конфигурацию к рабочему виду. Ничего не бросает: мусор на диске
 * не должен мешать запуску, недостающее берётся из умолчаний.
 */
export function sanitizeSyncConfig(raw = {}, { generateDeviceId, defaultDeviceName = 'Device' } = {}) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const deviceId = typeof input.deviceId === 'string' && /^[0-9a-f]{16}$/.test(input.deviceId) ? input.deviceId : generateDeviceId();
    const pairs = (Array.isArray(input.pairs) ? input.pairs : [])
        .filter(pair => pair && typeof pair.id === 'string' && pair.id && typeof pair.secret === 'string' && pair.secret)
        .map(pair => ({ id: pair.id, name: String(pair.name ?? 'Device').slice(0, 60), secret: pair.secret, pairedAt: Number(pair.pairedAt) || 0, lastSync: Number(pair.lastSync) || null }));
    const github = sanitizeGithubSettings(input.github ?? {});
    return {
        deviceId,
        deviceName: String(input.deviceName ?? '').trim().slice(0, 60) || defaultDeviceName,
        categories: sanitizeCategories(input.categories),
        autoSync: input.autoSync !== false,
        intervalMin: clampInterval(input.intervalMin),
        signalServer: /^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(String(input.signalServer ?? '')) ? String(input.signalServer).replace(/\/+$/, '') : 'https://ntfy.sh',
        iceServers: sanitizeIceServers(input.iceServers),
        pairs,
        github: { ...github, auto: Boolean(input.github?.auto) },
        cloud: sanitizeCloudSettings(input.cloud),
    };
}

/** Часть конфигурации, безопасная для показа в интерфейсе: без секретов пар и без токена GitHub. */
export function describeConfigForUi(config) {
    return {
        deviceId: config.deviceId,
        deviceName: config.deviceName,
        categories: config.categories,
        autoSync: config.autoSync,
        intervalMin: config.intervalMin,
        signalServer: config.signalServer,
        customIceServers: Boolean(config.iceServers),
        relay: { url: config.iceServers?.[0]?.urls?.[0] ?? '', username: config.iceServers?.[0]?.username ?? '', hasCredential: Boolean(config.iceServers?.[0]?.credential) },
        pairs: config.pairs.map(pair => ({ id: pair.id, name: pair.name, pairedAt: pair.pairedAt, lastSync: pair.lastSync })),
        cloud: {
            provider: config.cloud.provider,
            connected: Boolean(config.cloud.tokens?.refreshToken),
            enabled: config.cloud.enabled,
            auto: config.cloud.auto,
            apps: Object.fromEntries(CLOUD_PROVIDERS.map(id => [id, { hasClientId: Boolean(config.cloud.apps[id].clientId), hasClientSecret: Boolean(config.cloud.apps[id].clientSecret) }])),
        },
        github: {
            enabled: config.github.enabled,
            repository: config.github.owner && config.github.repo ? `${config.github.owner}/${config.github.repo}` : '',
            branch: config.github.branch,
            rootDir: config.github.rootDir,
            maxFileMb: Math.round(config.github.maxFileBytes / 1048576),
            hasToken: Boolean(config.github.token),
            auto: config.github.auto,
        },
    };
}

export { DEFAULT_GITHUB_MAX_FILE_BYTES };
