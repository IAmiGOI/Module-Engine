import { request } from '../../libraries/shared/request.js';
import { createBackupDrive } from '../../libraries/core/backup-drive.js';
import { SYNC_CATEGORY_IDS } from '../../libraries/core/sync-config.js';
import { backupName, buildSums, HOUR_MS, MANIFEST_FILE, parseBackupName, parseSums, planRotation, planTransfer, sha256Hex, SUMS_FILE, verifyListing } from '../../libraries/core/backup-plan.js';

/**
 * Ядро облачных бэкапов (Google Drive) — отдельный механизм рядом с синхронизацией: своя папка `ST Module Engine Backups`, в ней ровно
 * три бэкапа — `hourly` (последний), `daily`, `weekly` (ротация и имена — libraries/core/backup-plan.js). Берёт ВСЁ, что видит синхронизация
 * (категории `SYNC_CATEGORY_IDS`) через Сервис `stUserData`, независимо от того, какие галочки синхронизации включены. API-ключи моделей в
 * бэкап не попадают (их вырезает Сервис настроек), как и при синхронизации.
 *
 * Порядок, не дающий потерять хороший бэкап: папка создаётся как `…_INCOMPLETE` → заливка (неизменившиеся файлы копируются внутри Диска,
 * а не загружаются заново) → `SHA256SUMS` и `manifest.json` → ПРОВЕРКА по SHA-256, которые сообщает сам Диск → только тогда
 * переименование в итоговое имя → и лишь после этого ротация (повышение/удаление старых). Любой сбой оставляет прежние бэкапы нетронутыми.
 * Если с прошлого бэкапа ничего не изменилось (одинаковый `SHA256SUMS`), новый не создаётся.
 *
 * Контракты: `cloudBackup.run` · `.status` · `.list` · `.verify` · `.restore` · `.configure`. События: `cloudBackup.progress`, `cloudBackup.changed`.
 * Доступ к Диску — через инъектируемый `http` (в движке это `sync.cloud.request` Ядра синхронизации: токены остаются у него).
 */

const NAMESPACE = 'core.cloudBackup';
const CONFIG_KEY = 'config';
const HASH_STATE_KEY = 'cloudBackup:hashes';
const DEFAULT_CONFIG = Object.freeze({ enabled: true, intervalMin: 60 });
const CONCURRENCY = 4;
const RETRIES = 3;
const SPACE_MARGIN = 1.05;

const sanitizeConfig = raw => ({ enabled: raw?.enabled !== false, intervalMin: Math.min(1440, Math.max(5, Math.round(Number(raw?.intervalMin) || DEFAULT_CONFIG.intervalMin))) });

async function mapLimit(items, limit, fn) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const index = next; next += 1; await fn(items[index], index); } }));
}

export function createCloudBackupCore(host, {
    http,
    getDeviceName = () => 'device',
    isConnected = async () => true,
    now = () => Date.now(),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    setRepeating = (fn, ms) => setInterval(fn, ms),
    clearRepeating = handle => clearInterval(handle),
    publish,
    log = console,
} = {}) {
    const publishEvent = publish ?? ((event, payload) => host.events?.emit?.(event, payload));
    const service = (contract, params) => request(host.services, contract, { params }).then(result => { if (!result.ok) throw new Error(result.error?.message ?? 'request failed'); return result.value; });
    const own = (contract, params) => request(host.own, contract, { params }).then(result => (result.ok ? result.value : null));

    let config = null;
    let running = false;
    let last = null;      // итог последнего прохода
    let progress = null;
    let timer = null;

    async function loadConfig() {
        if (config) return config;
        config = sanitizeConfig(await own('storage.settings.get', { namespace: NAMESPACE, key: CONFIG_KEY, fallback: null }));
        return config;
    }
    const setProgress = state => { progress = state; publishEvent('cloudBackup.progress', { progress }); };
    const withRetry = async task => {
        let failure;
        for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
            try { return await task(); } catch (error) { failure = error; if (error?.fatal || error?.name === 'FatalSyncError' || attempt === RETRIES) break; await sleep(attempt * 500); }
        }
        throw failure;
    };

    /** Локальный снимок: [{ path, size, sha256 }]. SHA-256 берётся из кэша по штампу файла — читаются и хешируются только изменившиеся. */
    async function snapshot() {
        const listing = await service('stUserData.list', { categories: SYNC_CATEGORY_IDS });
        const cache = (await service('syncState.get', { key: HASH_STATE_KEY })) ?? {};
        const next = {};
        const files = [];
        let done = 0;
        await mapLimit(listing, CONCURRENCY, async item => {
            const cached = cache[item.path];
            if (item.stamp != null && cached?.stamp === item.stamp) { next[item.path] = cached; files.push({ path: item.path, size: cached.size, sha256: cached.sha256 }); }
            else {
                const blob = await service('stUserData.read', { path: item.path });
                const sha256 = await sha256Hex(await blob.arrayBuffer());
                if (item.stamp != null) next[item.path] = { stamp: item.stamp, size: blob.size, sha256 };
                files.push({ path: item.path, size: blob.size, sha256 });
            }
            done += 1;
            if (done % 25 === 0 || done === listing.length) setProgress({ phase: 'scanning', done, total: listing.length });
        });
        await service('syncState.set', { key: HASH_STATE_KEY, value: next });
        return files.sort((a, b) => (a.path < b.path ? -1 : 1));
    }

    const splitPath = path => { const parts = path.split('/'); return { dirs: parts.slice(0, -1), file: parts[parts.length - 1] }; };

    async function createBackup(drive, { force }) {
        const device = await getDeviceName();
        const files = await snapshot();
        if (!files.length) return { outcome: 'empty' };
        const wanted = await sha256Hex(buildSums(files));
        const existing = await drive.listBackups();
        for (const stale of existing.filter(item => item.incomplete)) await drive.remove(stale.id).catch(() => {});   // остатки оборванного прохода
        const complete = existing.filter(item => !item.incomplete).sort((a, b) => b.at - a.at);
        if (!force && complete[0]?.appProperties?.sums === wanted) return { outcome: 'unchanged', latest: complete[0].name };

        const previous = complete.find(item => item.kind === 'hourly') ?? complete[0] ?? null;
        const previousTree = previous ? new Map((await drive.listTree(previous.id)).map(file => [file.path, file])) : new Map();
        const transfer = planTransfer(files, [...previousTree.values()].filter(file => file.sha256));
        const quota = await drive.quota();
        const needed = Math.ceil((transfer.uploadBytes + transfer.copyBytes) * SPACE_MARGIN);
        if (quota.free != null && quota.free < needed) {
            return { outcome: 'failed', error: `Not enough space on Google Drive for a new backup: it needs about ${Math.ceil(needed / 1048576)} MB, ${Math.floor(quota.free / 1048576)} MB are free. Free some space (or delete old files) and run the backup again — the existing backups were not touched.` };
        }

        const startedAt = now();
        const bytes = files.reduce((sum, file) => sum + file.size, 0);
        const root = await drive.ensureRoot();
        const folderId = await drive.createFolder(backupName({ at: startedAt, kind: 'hourly', device, files: files.length, bytes, sums: wanted, incomplete: true }), root, { kind: 'hourly', sums: wanted, state: 'incomplete' });
        const dirCache = new Map();
        const final = new Map();
        let done = 0, uploaded = 0, copied = 0;
        const total = files.length;
        const uploadSet = new Set(transfer.upload.map(file => file.path));
        await mapLimit(files, CONCURRENCY, async file => {
            const { dirs, file: name } = splitPath(file.path);
            const parent = await drive.ensureDir(folderId, dirs, dirCache);
            if (!uploadSet.has(file.path)) {
                await withRetry(() => drive.copy(previousTree.get(file.path).id, parent, name));
                final.set(file.path, file); copied += file.size;
            } else {
                const blob = await service('stUserData.read', { path: file.path });
                const actual = { path: file.path, size: blob.size, sha256: await sha256Hex(await blob.arrayBuffer()) };   // манифест описывает то, что реально ушло
                await withRetry(() => drive.upload(parent, name, blob));
                final.set(file.path, actual); uploaded += blob.size;
            }
            done += 1;
            if (done % 10 === 0 || done === total) setProgress({ phase: 'uploading', done, total, uploadedBytes: uploaded, copiedBytes: copied });
        });

        const entries = [...final.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
        const sumsText = buildSums(entries);
        const sums = await sha256Hex(sumsText);
        const manifest = { format: 'stme-backup', version: 1, createdAt: new Date(startedAt).toISOString(), device, files: entries.length, bytes: entries.reduce((s, f) => s + f.size, 0), sha256sums: sums, note: 'Verify after download with: sha256sum -c SHA256SUMS' };
        await withRetry(() => drive.upload(folderId, SUMS_FILE, new Blob([sumsText], { type: 'text/plain' })));
        await withRetry(() => drive.upload(folderId, MANIFEST_FILE, new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' })));

        setProgress({ phase: 'verifying', done: total, total });
        const check = verifyListing(entries, (await drive.listTree(folderId)).filter(file => file.path !== SUMS_FILE && file.path !== MANIFEST_FILE));
        if (!check.ok) {
            return { outcome: 'failed', error: `The backup was uploaded but did not pass verification (missing: ${check.missing.length}, unexpected: ${check.extra.length}, damaged: ${check.mismatched.length}). The new backup was NOT activated and the existing ones were not touched.`, check };
        }
        const finalName = backupName({ at: startedAt, kind: 'hourly', device, files: entries.length, bytes: manifest.bytes, sums });
        await drive.rename(folderId, finalName, { kind: 'hourly', sums, state: 'verified', verifiedAt: String(now()) });

        // Ротация — только теперь, когда новый бэкап залит и проверен.
        const rotation = planRotation({ existing: complete.map(item => ({ id: item.id, kind: item.kind, at: item.at })), now: now() });
        const byId = new Map(complete.map(item => [item.id, item]));
        for (const step of rotation.promote) {
            const item = byId.get(step.id);
            await drive.rename(item.id, backupName({ at: item.at, kind: step.to, device: item.device, files: item.files, bytes: sizeToBytes(item.size), sums: item.sums }), { kind: step.to });
        }
        for (const id of rotation.remove) await drive.remove(id).catch(error => log.warn?.('[cloud backup] could not remove an old backup', error?.message));
        return { outcome: 'created', name: finalName, files: entries.length, bytes: manifest.bytes, uploadedBytes: uploaded, copiedBytes: copied, promoted: rotation.promote.length, removed: rotation.remove.length };
    }

    // «886MB» → байты (имя хранит округлённый размер; для переименования важно лишь оставить то же самое число в названии)
    const sizeToBytes = size => { const m = /^(\d+)(MB|KB)$/.exec(size); return m ? Number(m[1]) * (m[2] === 'MB' ? 1048576 : 1024) : 0; };

    async function run({ force = false } = {}) {
        await loadConfig();
        if (running) return { outcome: 'busy' };
        if (!http) return { outcome: 'unconfigured', error: 'Google Drive is not connected.' };
        running = true;
        publishEvent('cloudBackup.changed', {});
        try {
            const result = await createBackup(createBackupDrive({ http }), { force });
            last = { at: now(), ...result };
        } catch (error) {
            last = { at: now(), outcome: 'failed', error: error?.message ?? String(error) };
        } finally {
            running = false; setProgress(null);
        }
        publishEvent('cloudBackup.changed', {});
        return last;
    }

    const driveOrThrow = () => { if (!http) throw new Error('Google Drive is not connected.'); return createBackupDrive({ http }); };
    const publicItem = item => ({ id: item.id, name: item.name, kind: item.kind, at: item.at, files: item.files, size: item.size, device: item.device, incomplete: item.incomplete, verified: item.appProperties?.state === 'verified' });

    async function list() { return (await driveOrThrow().listBackups()).sort((a, b) => b.at - a.at).map(publicItem); }

    async function readSums(drive, id) {
        const tree = await drive.listTree(id);
        const sumsFile = tree.find(file => file.path === SUMS_FILE);
        if (!sumsFile) throw new Error('This backup has no SHA256SUMS file.');
        const text = await (await drive.download(sumsFile.id)).text();
        return { tree, text, expected: parseSums(text) };
    }

    /** Проверка бэкапа в облаке: имя ↔ SHA256SUMS ↔ реальные файлы (размер и SHA-256 сообщает сам Диск, скачивать не нужно). */
    async function verify({ id }) {
        const drive = driveOrThrow();
        const backup = (await drive.listBackups()).find(item => item.id === id);
        if (!backup) throw new Error('Backup not found.');
        const { tree, text, expected } = await readSums(drive, id);
        const sizes = new Map(tree.map(file => [file.path, file.size]));
        const nameMatches = (await sha256Hex(text)).startsWith(backup.sums);
        const check = verifyListing(expected.map(entry => ({ ...entry, size: sizes.get(entry.path) ?? -1 })), tree.filter(file => file.path !== SUMS_FILE && file.path !== MANIFEST_FILE));
        return { name: backup.name, ok: check.ok && nameMatches, nameMatchesSums: nameMatches, files: expected.length, ...check };
    }

    /**
     * Восстановление: по умолчанию ТОЛЬКО показывает, что изменилось бы (`dryRun`). Запись — с `confirm: true`; каждый файл перед записью
     * сверяется с SHA256SUMS. После записи обычная синхронизация сочтёт восстановленное локальной правкой и разнесёт его на устройства.
     */
    async function restore({ id, paths, confirm = false }) {
        const drive = driveOrThrow();
        const { tree, expected } = await readSums(drive, id);
        const local = new Map((await snapshot()).map(file => [file.path, file.sha256]));
        const wanted = expected.filter(entry => !paths || paths.includes(entry.path));
        const byPath = new Map(tree.map(file => [file.path, file]));
        const differs = wanted.filter(entry => local.has(entry.path) && local.get(entry.path) !== entry.sha256).map(entry => entry.path);
        const missing = wanted.filter(entry => !local.has(entry.path)).map(entry => entry.path);
        const same = wanted.length - differs.length - missing.length;
        if (!confirm) return { dryRun: true, total: wanted.length, same, differs, missing };
        const restored = [], failed = [];
        for (const entry of wanted.filter(item => differs.includes(item.path) || missing.includes(item.path))) {
            try {
                const blob = await drive.download(byPath.get(entry.path).id);
                if (await sha256Hex(await blob.arrayBuffer()) !== entry.sha256) throw new Error('checksum mismatch after download');
                await service('stUserData.write', { path: entry.path, blob });
                restored.push(entry.path);
            } catch (error) { failed.push({ path: entry.path, error: error?.message ?? String(error) }); }
        }
        return { dryRun: false, restored, failed };
    }

    async function status() {
        await loadConfig();
        return { ...config, connected: Boolean(http) && await isConnected().catch(() => false), running, progress, last };
    }

    const unregisters = [
        host.own.register('cloudBackup.run', params => run(params ?? {})),
        host.own.register('cloudBackup.status', () => status()),
        host.own.register('cloudBackup.start', () => start().then(() => true)),
        host.own.register('cloudBackup.list', () => list()),
        host.own.register('cloudBackup.verify', params => verify(params ?? {})),
        host.own.register('cloudBackup.restore', params => restore(params ?? {})),
        host.own.register('cloudBackup.configure', async params => {
            await loadConfig();
            config = sanitizeConfig({ ...config, ...params });
            await own('storage.settings.set', { namespace: NAMESPACE, key: CONFIG_KEY, value: config });
            schedule();
            return config;
        }),
    ];

    function schedule() {
        if (timer) { clearRepeating(timer); timer = null; }
        if (config?.enabled && http) timer = setRepeating(() => { run().catch(() => {}); }, config.intervalMin * 60000);
    }

    /** Запуск по расписанию + один проход сразу, если последний бэкап в облаке старше интервала. */
    async function start() {
        await loadConfig();
        schedule();
        if (!config.enabled || !http) return;
        try {
            const newest = (await list())[0];
            if (!newest || now() - newest.at >= config.intervalMin * 60000 - HOUR_MS / 12) await run();
        } catch { /* нет сети — повторит по расписанию */ }
    }

    return { run, status, list, verify, restore, start, stop() { if (timer) clearRepeating(timer); timer = null; for (const off of unregisters) off(); } };
}
