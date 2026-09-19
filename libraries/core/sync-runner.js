import { computeSyncPlan, SYNC_ACTIONS } from './sync-plan.js';
import { isFatalError } from './sync-errors.js';

/**
 * Исполнитель синхронизации — один на оба направления (другое устройство и репозиторий GitHub). Знает только форму двух
 * «сторон» и план из [sync-plan.js](sync-plan.js); как именно читаются и пишутся файлы, решают адаптеры сторон (Ядро собирает их
 * из Сервисов). Сеть, диск и часы сюда приходят только через адаптеры, поэтому исполнитель целиком тестируется на памяти.
 *
 * Сторона:
 *   manifest()                      → { путь: { hash, size, modified } }
 *   read(path)                      → Blob
 *   write(path, blob, { hash, modified })
 *   remove(path)
 *   batched?: true + commit()       → сторона копит изменения и применяет их одним махом (GitHub: один коммит на весь проход).
 *   checkpointEvery?: N             → пакетная сторона просит делать `commit()` каждые N изменений, а не только в конце (облако: индекс —
 *                                     единственный список «что где лежит», и без промежуточных записей оборванный проход оставлял бы
 *                                     на диске данные, которых другое устройство не видит, потому что индекса нет).
 *
 * Отказ одного файла не валит проход: остальные доезжают, а неудачный остаётся в прежнем состоянии базы и повторится в
 * следующий раз. Базу (что было у обеих сторон при прошлой удачной синхронизации) исполнитель отдаёт целиком — сохраняет вызывающий.
 */

/**
 * Пометка «отложено» (файл сейчас нельзя записать — например, открытый в ST чат): это не сбой, а «повторим в следующий раз».
 * Живёт В ТЕКСТЕ сообщения, а не флагом на объекте ошибки: ошибка проходит через Шину контрактов и через провод между устройствами,
 * и там от неё остаётся только сообщение.
 */
export const DEFERRED_PREFIX = '[deferred] ';
export const isDeferredError = error => Boolean(error?.deferred) || String(error?.message ?? '').startsWith(DEFERRED_PREFIX);

const TRANSFER_ORDER = { [SYNC_ACTIONS.settle]: 0, [SYNC_ACTIONS.pull]: 1, [SYNC_ACTIONS.push]: 1, [SYNC_ACTIONS.conflict]: 1, [SYNC_ACTIONS.deleteLocal]: 2, [SYNC_ACTIONS.deleteRemote]: 2 };

export async function runSync({
    local,
    remote,
    base = {},
    include,
    conflictLabel,
    onProgress = () => {},
    isAborted = () => false,
    localManifest,
    remoteManifest,
} = {}) {
    const [localEntries, remoteEntries] = await Promise.all([localManifest ?? local.manifest(), remoteManifest ?? remote.manifest()]);
    const plan = computeSyncPlan({ local: localEntries, remote: remoteEntries, base, conflictLabel, include });
    const actions = [...plan.actions].sort((a, b) => TRANSFER_ORDER[a.op] - TRANSFER_ORDER[b.op]);
    const nextBase = { ...base };
    const errors = [];
    const counts = { pushed: 0, pulled: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, failed: 0, deferred: 0 };
    const deferred = [];   // изменения базы, которые вступают в силу только после удачного commit() у пакетной стороны
    const applyBase = changes => { for (const [path, hash] of Object.entries(changes)) { if (hash === null) delete nextBase[path]; else nextBase[path] = hash; } };
    const finishOne = (changes, remoteTouched) => (remote.batched && remoteTouched ? deferred.push(changes) : applyBase(changes));
    /** Контрольная точка: записать накопленное у пакетной стороны и только после успеха считать это синхронизированным. */
    const flushBatch = async () => { await remote.commit(); for (const changes of deferred.splice(0)) applyBase(changes); };
    const total = actions.filter(action => action.op !== SYNC_ACTIONS.settle).length;
    let done = 0;
    let aborted = false;
    let stopped = null;   // { reason, remaining } — проход остановлен фатальной ошибкой (нет места, токен отклонён, лимит запросов)

    for (const [index, action] of actions.entries()) {
        if (isAborted()) { aborted = true; break; }
        if (action.op !== SYNC_ACTIONS.settle) onProgress({ done, total, path: action.path, op: action.op });
        try {
            switch (action.op) {
                case SYNC_ACTIONS.settle:
                    applyBase({ [action.path]: action.hash });
                    break;
                case SYNC_ACTIONS.push:
                    await remote.write(action.path, await local.read(action.path), { hash: action.hash, modified: action.modified });
                    counts.pushed += 1;
                    finishOne({ [action.path]: action.hash }, true);
                    break;
                case SYNC_ACTIONS.pull:
                    await local.write(action.path, await remote.read(action.path), { hash: action.hash, modified: action.modified });
                    counts.pulled += 1;
                    finishOne({ [action.path]: action.hash }, false);
                    break;
                case SYNC_ACTIONS.deleteLocal:
                    await local.remove(action.path);
                    counts.deletedLocal += 1;
                    finishOne({ [action.path]: null }, false);
                    break;
                case SYNC_ACTIONS.deleteRemote:
                    await remote.remove(action.path);
                    counts.deletedRemote += 1;
                    finishOne({ [action.path]: null }, true);
                    break;
                case SYNC_ACTIONS.conflict:
                    await resolveConflict(action, { local, remote, localEntries, remoteEntries });
                    counts.conflicts += 1;
                    finishOne({
                        [action.path]: action.winner === 'local' ? action.localHash : action.remoteHash,
                        [action.conflictPath]: action.winner === 'local' ? action.remoteHash : action.localHash,
                    }, true);
                    break;
                default:
                    break;
            }
            if (remote.batched && remote.checkpointEvery && deferred.length >= remote.checkpointEvery) await flushBatch();
        } catch (error) {
            // Отложенное (например, открытый сейчас чат) — не сбой: файл остаётся в прежнем состоянии базы и доедет в следующий раз.
            if (isDeferredError(error)) counts.deferred += 1;
            else {
                counts.failed += 1;
                errors.push({ path: action.path, op: action.op, message: error?.message ?? String(error) });
                // Фатальная ошибка: те же слова получит каждый следующий файл — останавливаемся, вместо сотни одинаковых отказов.
                if (isFatalError(error)) {
                    stopped = { reason: error.message, remaining: actions.slice(index + 1).filter(next => next.op !== SYNC_ACTIONS.settle).length };
                    break;
                }
            }
        }
        if (action.op !== SYNC_ACTIONS.settle) done += 1;
    }

    let commitError = null;
    if (remote.batched) {
        try {
            if (deferred.length) await remote.commit();
            for (const changes of deferred) applyBase(changes);
        } catch (error) {
            // После фатальной ошибки запись индекса чаще всего упадёт по той же причине — второй раз о ней не сообщаем.
            if (!stopped) {
                commitError = error?.message ?? String(error);
                counts.failed += deferred.length;
                errors.push({ path: '*', op: 'commit', message: commitError });
            }
        }
    }
    onProgress({ done: total, total, path: null, op: null });
    return { ok: !commitError && counts.failed === 0 && !aborted, aborted, stopped, counts, errors, base: nextBase, plan: plan.counts };
}

/** Обе версии сохраняются на обеих сторонах: проигравшая — под именем-копией, победившая — на прежнем месте. */
async function resolveConflict(action, { local, remote, localEntries, remoteEntries }) {
    const winnerIsLocal = action.winner === 'local';
    const loserBlob = winnerIsLocal ? await remote.read(action.path) : await local.read(action.path);
    const loserEntry = winnerIsLocal ? remoteEntries[action.path] : localEntries[action.path];
    const meta = { hash: winnerIsLocal ? action.remoteHash : action.localHash, modified: loserEntry?.modified };
    await local.write(action.conflictPath, loserBlob, meta);
    await remote.write(action.conflictPath, loserBlob, meta);
    if (winnerIsLocal) {
        await remote.write(action.path, await local.read(action.path), { hash: action.localHash, modified: localEntries[action.path]?.modified });
    } else {
        await local.write(action.path, await remote.read(action.path), { hash: action.remoteHash, modified: remoteEntries[action.path]?.modified });
    }
}
