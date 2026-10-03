/**
 * Облачные бэкапы: чистая логика без сети и диска — имена, манифест с проверкой и ротация трёх слотов.
 *
 * **Три слота — три папки в облаке, по одной на слот:** `hourly` (последний), `daily` (суточный), `weekly` (недельный). Новый бэкап всегда
 * входит в `hourly`; предыдущий `hourly` либо повышается до `daily` (если суточный слот старше суток или пуст), либо удаляется; прежний
 * `daily` так же повышается до `weekly` (если недельный слот старше недели или пуст) либо удаляется. Повышение — переименование папки,
 * без повторной загрузки. Поэтому слоты охватывают: `hourly` — последний час, `daily` — от часа до суток, `weekly` — от суток до недели.
 * Ничего не удаляется, пока новый бэкап не залит И не проверен (`planRotation` зовут только после проверки).
 *
 * **Имя папки несёт всё нужное для проверки:**
 *   `STME-backup_20261003T183005Z_hourly_PC_1243f_886MB_3fa91c2e`
 *   префикс · время создания по UTC · слот · устройство · число файлов · размер · первые 8 hex SHA-256 файла `SHA256SUMS` внутри.
 * Файлы внутри лежат под своими настоящими путями (`characters/Anna.png`), плюс `SHA256SUMS` в стандартном формате (`sha256sum -c`) и
 * `manifest.json` с описанием. Пока бэкап не проверен, папка называется `…_INCOMPLETE` и в ротации не участвует.
 */

export const BACKUP_PREFIX = 'STME-backup';
export const BACKUP_KINDS = Object.freeze(['hourly', 'daily', 'weekly']);
export const SUMS_FILE = 'SHA256SUMS';
export const MANIFEST_FILE = 'manifest.json';
export const HOUR_MS = 3600000;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;

const two = value => String(value).padStart(2, '0');

/** `20261003T183005Z` — время по UTC без разделителей, которые не любят файловые системы. */
export const stampOf = ms => { const d = new Date(ms); return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}T${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`; };
export function parseStamp(stamp) {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(stamp));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

const safeDevice = name => String(name ?? 'device').replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'device';
const humanSize = bytes => (bytes >= 1048576 ? `${Math.round(bytes / 1048576)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`);

export function backupName({ at, kind, device, files, bytes, sums, incomplete = false }) {
    if (!BACKUP_KINDS.includes(kind)) throw new Error(`unknown backup kind "${kind}"`);
    return `${BACKUP_PREFIX}_${stampOf(at)}_${kind}_${safeDevice(device)}_${files}f_${humanSize(bytes)}_${String(sums).slice(0, 8)}${incomplete ? '_INCOMPLETE' : ''}`;
}

/** Имя → части; не наше имя → `null`. `sums` — 8 hex для сверки с `SHA256SUMS`. */
export function parseBackupName(name) {
    const m = /^STME-backup_(\d{8}T\d{6}Z)_(hourly|daily|weekly)_([A-Za-z0-9-]+)_(\d+)f_(\d+(?:MB|KB))_([0-9a-f]{8})(_INCOMPLETE)?$/.exec(String(name));
    if (!m) return null;
    return { at: parseStamp(m[1]), kind: m[2], device: m[3], files: Number(m[4]), size: m[5], sums: m[6], incomplete: Boolean(m[7]) };
}

const hex = buffer => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');
export const sha256Hex = async data => hex(await globalThis.crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data));

/** Содержимое `SHA256SUMS` (формат `sha256sum`: «хеш␣␣путь», по одному на файл, пути по возрастанию). */
export function buildSums(entries) {
    return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map(entry => `${entry.sha256}  ${entry.path}`).join('\n') + '\n';
}
export function parseSums(text) {
    const entries = [];
    for (const line of String(text).split('\n')) {
        const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
        if (m) entries.push({ sha256: m[1], path: m[2] });
    }
    return entries;
}

/**
 * Сверка содержимого папки в облаке с `SHA256SUMS`: у каждого файла совпали путь, размер и SHA-256 (его сообщает сам облачный диск —
 * мы ничего не скачиваем), лишних и недостающих файлов нет. `remote` — [{ path, size, sha256 }], `expected` — [{ path, size, sha256 }].
 * @returns {{ ok: boolean, missing: string[], extra: string[], mismatched: string[] }}
 */
export function verifyListing(expected, remote) {
    const have = new Map(remote.map(file => [file.path, file]));
    const want = new Map(expected.map(file => [file.path, file]));
    const missing = [...want.keys()].filter(path => !have.has(path)).sort();
    const extra = [...have.keys()].filter(path => !want.has(path)).sort();
    const mismatched = [...want.values()].filter(file => have.has(file.path) && (have.get(file.path).sha256 !== file.sha256 || Number(have.get(file.path).size) !== Number(file.size))).map(file => file.path).sort();
    return { ok: !missing.length && !extra.length && !mismatched.length, missing, extra, mismatched };
}

/** Что изменилось относительно прошлого бэкапа: что залить, что скопировать на стороне облака, сколько байт реально пойдёт по сети. */
export function planTransfer(current, previous) {
    const before = new Map((previous ?? []).map(file => [file.path, file.sha256]));
    const upload = [], copy = [];
    for (const file of current) (before.get(file.path) === file.sha256 ? copy : upload).push(file);
    return { upload, copy, uploadBytes: upload.reduce((sum, file) => sum + file.size, 0), copyBytes: copy.reduce((sum, file) => sum + file.size, 0) };
}

/**
 * Ротация слотов ПОСЛЕ успешно залитого и проверенного нового бэкапа.
 * @param {object} input
 * @param {Array<{id:string, kind:string, at:number}>} input.existing — полные (не INCOMPLETE) бэкапы, УЖЕ без нового
 * @param {number} input.now
 * @returns {{ promote: Array<{id:string, to:string}>, remove: string[] }} — повышения (переименование слота) и удаления; порядок — как выполнять
 */
export function planRotation({ existing = [], now }) {
    const slot = kind => existing.filter(item => item.kind === kind).sort((a, b) => b.at - a.at);
    const [hourly, daily, weekly] = [slot('hourly'), slot('daily'), slot('weekly')];
    const promote = [], remove = [];
    const keep = { daily: daily[0] ?? null, weekly: weekly[0] ?? null };
    // Лишние в слоте (после сбоя их могло остаться несколько) — только самый свежий остаётся кандидатом, остальные уходят.
    for (const list of [hourly, daily, weekly]) remove.push(...list.slice(1).map(item => item.id));
    const outgoingHourly = hourly[0] ?? null;
    // Сначала освобождаем недельный слот (daily → weekly), потом суточный (hourly → daily): иначе переименование упрётся в занятый слот.
    const dailyDue = Boolean(outgoingHourly) && (!keep.daily || now - keep.daily.at >= DAY_MS);
    if (dailyDue) {
        if (keep.daily) {
            const weeklyDue = !keep.weekly || now - keep.weekly.at >= WEEK_MS;
            if (weeklyDue) { if (keep.weekly) remove.push(keep.weekly.id); promote.push({ id: keep.daily.id, to: 'weekly' }); } else remove.push(keep.daily.id);
        }
        promote.push({ id: outgoingHourly.id, to: 'daily' });
    } else if (outgoingHourly) {
        remove.push(outgoingHourly.id);
    }
    return { promote, remove };
}

/** Нужен ли новый бэкап: ничего не изменилось с последнего (одинаковый `SHA256SUMS`) — не создаём. */
export const isUnchanged = (latest, sums) => Boolean(latest) && latest.sums === String(sums).slice(0, 8);
