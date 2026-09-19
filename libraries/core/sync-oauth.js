import { toBase64Url } from './sync-secrets.js';

/**
 * Вход в облачный диск (Dropbox, Google Drive) без своего сервера и без адреса возврата. Расширение живёт на произвольном
 * адресе ST (localhost, IP в сети, туннель), а провайдеры требуют заранее зарегистрированный redirect — поэтому обходимся без него:
 *  - **Dropbox**: авторизация с PKCE и БЕЗ redirect — Dropbox сам показывает код, пользователь вставляет его в карточку;
 *  - **Google**: «device flow» — пользователь открывает google.com/device и вводит показанный код, расширение опрашивает токен.
 *    Доступно только право `drive.file` (приложение видит лишь файлы, созданные им самим), которое Google не считает чувствительным.
 * Секретов приложения в коде нет: у Dropbox с PKCE секрет не нужен, у Google «TV/устройство»-клиента секрет по определению
 * публичный. Ключи (`clientId`) регистрирует автор расширения один раз (или пользователь подставляет свой).
 *
 * Сеть приходит инъекцией (`http({ url, method, headers, body }) → { status, ok, text }`) — всё тестируется на фейках.
 */

export const DROPBOX_AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
export const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
export const GOOGLE_DEVICE_URL = 'https://oauth2.googleapis.com/device/code';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Вход по коду допускает у Google только `drive.file` (проверено: `drive.appdata` → `invalid_scope`): приложение видит лишь созданные им самим файлы. */
export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

const encoder = new TextEncoder();
const form = values => Object.entries(values).filter(([, value]) => value != null && value !== '').map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
const FORM_HEADERS = { 'Content-Type': 'application/x-www-form-urlencoded' };

export function generateCodeVerifier({ random = globalThis.crypto } = {}) {
    return toBase64Url(random.getRandomValues(new Uint8Array(48)));
}

export async function computeCodeChallenge(verifier, { subtle = globalThis.crypto?.subtle } = {}) {
    return toBase64Url(new Uint8Array(await subtle.digest('SHA-256', encoder.encode(verifier))));
}

export function buildDropboxAuthUrl({ clientId, challenge }) {
    return `${DROPBOX_AUTHORIZE_URL}?${form({ client_id: clientId, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', token_access_type: 'offline' })}`;
}

/** Ответ провайдера → набор токенов; `refreshToken` при обновлении может не прийти — тогда остаётся прежний. */
export function sanitizeTokenSet(raw, { now = Date.now(), previous } = {}) {
    if (!raw || typeof raw.access_token !== 'string' || !raw.access_token) return null;
    const lifetime = Number.isFinite(Number(raw.expires_in)) ? Number(raw.expires_in) : 3600;
    return { accessToken: raw.access_token, refreshToken: raw.refresh_token ?? previous?.refreshToken ?? '', expiresAt: now + lifetime * 1000 };
}

export const isTokenFresh = (tokens, now, skewMs = 60000) => Boolean(tokens?.accessToken) && tokens.expiresAt - skewMs > now;

function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }

function describeAuthFailure(response, what) {
    const data = parseJson(response.text);
    const detail = data?.error_description ?? data?.error ?? '';
    return new Error(`${what} failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`);
}

async function tokenRequest(http, url, values, { now, previous, what }) {
    const response = await http({ url, method: 'POST', headers: FORM_HEADERS, body: form(values) });
    if (!response.ok) throw describeAuthFailure(response, what);
    const tokens = sanitizeTokenSet(parseJson(response.text), { now, previous });
    if (!tokens) throw new Error(`${what}: the provider answered without a token`);
    return tokens;
}

export const exchangeDropboxCode = ({ http, clientId, code, verifier, now = Date.now() }) =>
    tokenRequest(http, DROPBOX_TOKEN_URL, { grant_type: 'authorization_code', code: String(code).trim(), client_id: clientId, code_verifier: verifier }, { now, what: 'Dropbox sign-in' });

export const refreshDropboxToken = ({ http, clientId, tokens, now = Date.now() }) =>
    tokenRequest(http, DROPBOX_TOKEN_URL, { grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: clientId }, { now, previous: tokens, what: 'Dropbox token refresh' });

export async function startGoogleDeviceFlow({ http, clientId }) {
    const response = await http({ url: GOOGLE_DEVICE_URL, method: 'POST', headers: FORM_HEADERS, body: form({ client_id: clientId, scope: GOOGLE_SCOPE }) });
    if (!response.ok) throw describeAuthFailure(response, 'Google sign-in');
    const data = parseJson(response.text);
    if (!data?.device_code || !data.user_code) throw new Error('Google sign-in: unexpected answer');
    return { deviceCode: data.device_code, userCode: data.user_code, verificationUrl: data.verification_url ?? 'https://www.google.com/device', intervalMs: (Number(data.interval) || 5) * 1000, expiresInMs: (Number(data.expires_in) || 1800) * 1000 };
}

/** Один опрос. `pending` — пользователь ещё не подтвердил; `slow_down` — опрашивать реже; `done` — токены получены. */
export async function pollGoogleDeviceFlow({ http, clientId, clientSecret, deviceCode, now = Date.now() }) {
    const response = await http({ url: GOOGLE_TOKEN_URL, method: 'POST', headers: FORM_HEADERS, body: form({ client_id: clientId, client_secret: clientSecret, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }) });
    const data = parseJson(response.text);
    if (response.ok) {
        const tokens = sanitizeTokenSet(data, { now });
        if (!tokens) throw new Error('Google sign-in: the provider answered without a token');
        return { status: 'done', tokens };
    }
    const error = data?.error;
    if (error === 'authorization_pending') return { status: 'pending' };
    if (error === 'slow_down') return { status: 'slow_down' };
    if (error === 'access_denied') return { status: 'denied' };
    if (error === 'expired_token') return { status: 'expired' };
    throw describeAuthFailure(response, 'Google sign-in');
}

export const refreshGoogleToken = ({ http, clientId, clientSecret, tokens, now = Date.now() }) =>
    tokenRequest(http, GOOGLE_TOKEN_URL, { grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: clientId, client_secret: clientSecret }, { now, previous: tokens, what: 'Google token refresh' });

/**
 * Держатель токенов: отдаёт действующий access-токен, обновляя его заранее (за минуту до конца) и один раз по требованию
 * (после ответа 401). `save(tokens)` — куда записать обновлённое (настройки Ядра).
 */
export function createTokenManager({ provider, http, clientId, clientSecret, getTokens, save, now = () => Date.now() }) {
    let pending = null;
    async function refresh() {
        const tokens = getTokens();
        if (!tokens?.refreshToken) throw new Error('Not signed in: connect the account again.');
        const next = provider === 'google'
            ? await refreshGoogleToken({ http, clientId, clientSecret, tokens, now: now() })
            : await refreshDropboxToken({ http, clientId, tokens, now: now() });
        await save(next);
        return next;
    }
    const refreshOnce = () => { pending ??= refresh().finally(() => { pending = null; }); return pending; };
    return {
        async accessToken() {
            const tokens = getTokens();
            if (isTokenFresh(tokens, now())) return tokens.accessToken;
            return (await refreshOnce()).accessToken;
        },
        async forceRefresh() { return (await refreshOnce()).accessToken; },
    };
}
