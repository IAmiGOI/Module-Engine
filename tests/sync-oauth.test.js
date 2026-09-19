import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildDropboxAuthUrl, computeCodeChallenge, createTokenManager, exchangeDropboxCode, generateCodeVerifier, isTokenFresh,
    pollGoogleDeviceFlow, refreshDropboxToken, sanitizeTokenSet, startGoogleDeviceFlow,
} from '../libraries/core/sync-oauth.js';

const json = (status, data) => ({ status, ok: status >= 200 && status < 300, text: JSON.stringify(data) });

test('the PKCE challenge is the base64url SHA-256 of the verifier (RFC 7636 example)', async () => {
    assert.equal(await computeCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    const verifier = generateCodeVerifier();
    assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
    assert.notEqual(verifier, generateCodeVerifier());
});

test('the Dropbox sign-in link asks for offline access with PKCE and has no redirect address', () => {
    const url = new URL(buildDropboxAuthUrl({ clientId: 'KEY', challenge: 'CH' }));
    assert.equal(url.origin + url.pathname, 'https://www.dropbox.com/oauth2/authorize');
    assert.equal(url.searchParams.get('client_id'), 'KEY');
    assert.equal(url.searchParams.get('token_access_type'), 'offline');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.has('redirect_uri'), false);
});

test('a pasted Dropbox code is exchanged for tokens with the verifier, and a refused code gives a readable error', async () => {
    let sent;
    const http = async request => { sent = request; return json(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 14400 }); };
    const tokens = await exchangeDropboxCode({ http, clientId: 'KEY', code: '  abc123 ', verifier: 'VER', now: 1000 });
    assert.deepEqual(tokens, { accessToken: 'AT', refreshToken: 'RT', expiresAt: 1000 + 14400 * 1000 });
    assert.equal(sent.method, 'POST');
    assert.match(sent.body, /grant_type=authorization_code/);
    assert.match(sent.body, /code=abc123&/);
    assert.match(sent.body, /code_verifier=VER/);
    await assert.rejects(exchangeDropboxCode({ http: async () => json(400, { error: 'invalid_grant', error_description: 'code has expired' }), clientId: 'K', code: 'x', verifier: 'v' }), /code has expired/);
});

test('refreshing keeps the old refresh token when the provider does not send a new one', async () => {
    const tokens = await refreshDropboxToken({ http: async () => json(200, { access_token: 'NEW', expires_in: 100 }), clientId: 'K', tokens: { accessToken: 'OLD', refreshToken: 'RT', expiresAt: 0 }, now: 5 });
    assert.deepEqual(tokens, { accessToken: 'NEW', refreshToken: 'RT', expiresAt: 5 + 100000 });
    assert.equal(sanitizeTokenSet({}), null);
    assert.equal(isTokenFresh({ accessToken: 'a', expiresAt: 100000 }, 30000), true);
    assert.equal(isTokenFresh({ accessToken: 'a', expiresAt: 100000 }, 50000), false, 'inside the one-minute safety margin');
});

test('the Google device flow: a code for the user, then polling until they confirm', async () => {
    const started = await startGoogleDeviceFlow({ http: async () => json(200, { device_code: 'DC', user_code: 'ABCD-EFGH', verification_url: 'https://www.google.com/device', interval: 5, expires_in: 1800 }), clientId: 'CID' });
    assert.deepEqual(started, { deviceCode: 'DC', userCode: 'ABCD-EFGH', verificationUrl: 'https://www.google.com/device', intervalMs: 5000, expiresInMs: 1800000 });
    const answers = [json(428, { error: 'authorization_pending' }), json(403, { error: 'slow_down' }), json(400, { error: 'access_denied' }), json(400, { error: 'expired_token' }), json(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3599 })];
    const poll = () => pollGoogleDeviceFlow({ http: async () => answers.shift(), clientId: 'C', clientSecret: 'S', deviceCode: 'DC', now: 0 });
    assert.deepEqual((await poll()).status, 'pending');
    assert.deepEqual((await poll()).status, 'slow_down');
    assert.deepEqual((await poll()).status, 'denied');
    assert.deepEqual((await poll()).status, 'expired');
    const done = await poll();
    assert.equal(done.status, 'done');
    assert.equal(done.tokens.refreshToken, 'RT');
    await assert.rejects(pollGoogleDeviceFlow({ http: async () => json(500, { error: 'boom' }), clientId: 'C', clientSecret: 'S', deviceCode: 'D' }), /HTTP 500/);
});

test('the token manager reuses a fresh token, refreshes an expiring one once even for parallel callers, and saves the result', async () => {
    let tokens = { accessToken: 'A1', refreshToken: 'R', expiresAt: 200_000 };
    let refreshes = 0;
    const saved = [];
    const http = async () => { refreshes += 1; return json(200, { access_token: `A${refreshes + 1}`, expires_in: 3600 }); };
    const manager = createTokenManager({ provider: 'dropbox', http, clientId: 'K', getTokens: () => tokens, save: async next => { tokens = next; saved.push(next); }, now: () => 0 });
    assert.equal(await manager.accessToken(), 'A1', 'still fresh');
    tokens = { ...tokens, expiresAt: 30_000 };   // 30 s left: inside the one-minute margin
    const [a, b] = await Promise.all([manager.accessToken(), manager.accessToken()]);
    assert.equal(a, 'A2');
    assert.equal(b, 'A2');
    assert.equal(refreshes, 1);
    assert.equal(saved.length, 1);
    assert.equal(await manager.forceRefresh(), 'A3');
});

test('without a refresh token the manager asks to sign in again', async () => {
    const manager = createTokenManager({ provider: 'google', http: async () => json(200, {}), clientId: 'K', clientSecret: 'S', getTokens: () => ({ accessToken: 'x', refreshToken: '', expiresAt: 0 }), save: async () => {}, now: () => 1 });
    await assert.rejects(manager.accessToken(), /connect the account again/);
});
