import { computeSyncPlan, detectMassDeletion, SYNC_ACTIONS } from './sync-plan.js';
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

const CHECKPOINT_EVERY = 50;
const CHECKPOINT_INTERVAL_MS = 10000;

export async function runSync({
    local,
    remote,
    base = {},
    include,
    conflictLabel,
    conflictPolicy = () => 'copy',
    categoryOf = () => null,
    sameContent = null,
    onProgress = () => {},
    onCheckpoint = () => {},
    checkpointEvery = CHECKPOINT_EVERY,
    checkpointIntervalMs = CHECKPOINT_INTERVAL_MS,
    now = () => Date.now(),
    isAborted = () => false,
    localManifest,
    remoteManifest,
} = {}) {
    const [localEntries, remoteEntries] = await Promise.all([localManifest ?? local.manifest(), remoteManifest ?? remote.manifest()]);
    const plan = computeSyncPlan({ local: localEntries, remote: remoteEntries, base, conflictLabel, include });
    // Защита от массового удаления (ROADMAP 5.106в): категория под подозрением (`detectMassDeletion` — sync-plan.js) не удаляется
    // молча ни на одном проходе — её deleteLocal/deleteRemote просто не входят в исполнение, путь остаётся как есть до подтверждения
    // человеком (панель — отдельная задача); если следующий скан снова покажет файлы (временная пустота листинга ST) — удалять
    // будет уже нечего, план сам сойдёт на нет.
    const blockedCategories = detectMassDeletion({ actions: plan.actions, local: localEntries, remote: remoteEntries, base, categoryOf });
    const isBlockedDeletion = action => (action.op === SYNC_ACTIONS.deleteLocal || action.op === SYNC_ACTIONS.deleteRemote) && blockedCategories.has(categoryOf(action.path));
    const actions = plan.actions.filter(action => !isBlockedDeletion(action)).sort((a, b) => TRANSFER_ORDER[a.op] - TRANSFER_ORDER[b.op]);
    const nextBase = { ...base };
    const errors = [];
    const counts = { pushed: 0, pulled: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, quarantined: 0, failed: 0, deferred: 0 };
    const deferred = [];   // изменения базы, которые вступают в силу только после удачного commit() у пакетной стороны
    const applyBase = changes => { for (const [path, hash] of Object.entries(changes)) { if (hash === null) delete nextBase[path]; else nextBase[path] = hash; } };
    const finishOne = (changes, remoteTouched) => (remote.batched && remoteTouched ? deferred.push(changes) : applyBase(changes));
    /** Контрольная точка ПАКЕТНОЙ стороны: записать накопленное у неё и только после успеха считать это синхронизированным. */
    const flushBatch = async () => { await remote.commit(); for (const changes of deferred.splice(0)) applyBase(changes); await onCheckpoint({ ...nextBase }); };
    // Контрольная точка ОБЫЧНОЙ базы (ROADMAP 5.106г, Этап 4.1): каждые `checkpointEvery` реальных действий или `checkpointIntervalMs`
    // — раньше `base`/кэш писались только В КОНЦЕ прохода (`runAgainst`), и обрыв ровно посередине терял уже переданные файлы из
    // виду: следующий проход начинал бы с пустой/старой базы и гонял то, что уже доехало, заново (в лучшем случае) или путал бы это
    // с конфликтом (в худшем — см. doc-comment `sync-plan.js` про потерю привязки). Настройки — тест, из движка приходит реальное время.
    let sinceCheckpoint = 0;
    let lastCheckpointAt = now();
    const maybeCheckpoint = async () => {
        if (sinceCheckpoint < checkpointEvery && now() - lastCheckpointAt < checkpointIntervalMs) return;
        sinceCheckpoint = 0;
        lastCheckpointAt = now();
        await onCheckpoint({ ...nextBase });
    };
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
                    // `meta.hash` — ВСЕГДА настоящий байтовый хеш (получатель кэширует его как хеш реальных байт на диске); `meta.key` —
                    // отпечаток ИСТОЧНИКА, безопасно доверять сразу (см. doc-comment `writeLocal` в cores/sync/index.js); то, что идёт
                    // в базу (`action.baseValue`), может быть тем же `key` — см. doc-comment sync-plan.js.
                    await remote.write(action.path, await local.read(action.path), { hash: action.hash, modified: action.modified, key: action.key });
                    counts.pushed += 1;
                    finishOne({ [action.path]: action.baseValue ?? action.hash }, true);
                    break;
                case SYNC_ACTIONS.pull:
                    await local.write(action.path, await remote.read(action.path), { hash: action.hash, modified: action.modified, key: action.key });
                    counts.pulled += 1;
                    finishOne({ [action.path]: action.baseValue ?? action.hash }, false);
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
                case SYNC_ACTIONS.conflict: {
                    const winnerHash = action.winner === 'local' ? action.localHash : action.remoteHash;
                    const loserHash = action.winner === 'local' ? action.remoteHash : action.localHash;
                    const outcome = await resolveConflict(action, { local, remote, localEntries, remoteEntries, conflictPolicy, sameContent });
                    if (outcome.reconciled) { counts.pushed += 1; finishOne({ [action.path]: action.localHash }, true); break; }
                    counts.conflicts += 1;
                    if (outcome.quarantined) counts.quarantined += 1;
                    // В карантине копии-файла нет вовсе — базе просто нечего запоминать про conflictPath, только про сам путь (обе
                    // стороны сошлись на версии победителя).
                    finishOne(outcome.quarantined || action.noCopy ? { [action.path]: winnerHash } : { [action.path]: winnerHash, [action.conflictPath]: loserHash }, true);
                    break;
                }
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
        if (action.op !== SYNC_ACTIONS.settle) { done += 1; sinceCheckpoint += 1; await maybeCheckpoint(); }
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
    return {
        ok: !commitError && counts.failed === 0 && !aborted, aborted, stopped, counts, errors, base: nextBase, plan: plan.counts,
        needsConfirmation: blockedCategories.size ? [...blockedCategories] : null,
    };
}

/** Победитель пишется в основной путь на обеих сторонах; что происходит с проигравшей версией, зависит от `outcome` ниже. */
async function applyWinner(action, { local, remote, localEntries, remoteEntries }) {
    if (action.winner === 'local') await remote.write(action.path, await local.read(action.path), { hash: action.localHash, key: localEntries[action.path]?.key, modified: localEntries[action.path]?.modified });
    else await local.write(action.path, await remote.read(action.path), { hash: action.remoteHash, key: remoteEntries[action.path]?.key, modified: remoteEntries[action.path]?.modified });
}

/**
 * Проигравшая версия при конфликте:
 *  - **`copy`** (обычный конфликт, или первая встреча по категории без карантина) — сохраняется РЯДОМ на обеих сторонах, под
 *    именем-копией: обе версии — заведомо чья-то работа, ничего не решаем за человека.
 *  - **`quarantine`** (первая встреча, `CONFLICT_POLICY` категории — `sync-config.js`) — копия НЕ идёт в папку ST вовсе (не плодит
 *    дубля с тем же именем в списке ST): только сторона, чья версия проиграла, кладёт её в СВОЙ карантин (`side.quarantine()`) —
 *    другая сторона ничего не получает по сети, восстановление на будущее (панель — отдельная задача). Работает, только если у
 *    проигравшей стороны вообще ЕСТЬ `quarantine()` — то есть это реальное устройство-пара; у GitHub/облака его нет (это не
 *    интерактивная сторона, класть туда «на будущее востановить» некому), и тогда, даже если политика категории — `quarantine`,
 *    поведение остаётся `copy` (см. doc-comment файла и `CONFLICT_POLICY`: «для пакетных сторон — copy, если проиграла удалённая»;
 *    если проиграла ЛОКАЛЬНАЯ, `local` эту функцию имеет всегда, и карантин у себя не требует сети вовсе).
 */
async function resolveConflict(action, { local, remote, localEntries, remoteEntries, conflictPolicy = () => 'copy', sameContent = null }) {
    // Не настоящий конфликт: обе стороны хранят ОДНО И ТО ЖЕ содержимое, а байты разошлись (ST переписывает карточку персонажа при
    // импорте; у GitHub/облака нет семантического `key`, и после обрыва прохода — база и кэш хешей не успели записаться — разницу
    // байтов не отличить от правки). Никакой копии: выравниваем байты (удалённая сторона получает локальные) и считаем путь сошедшимся.
    if (sameContent && (sameContent.appliesTo?.(action.path) ?? true)) {
        const [localBlob, remoteBlob] = [await local.read(action.path), await remote.read(action.path)];
        if (await Promise.resolve(sameContent(action.path, localBlob, remoteBlob)).catch(() => false)) {
            await remote.write(action.path, localBlob, { hash: action.localHash, key: localEntries[action.path]?.key, modified: localEntries[action.path]?.modified });
            return { reconciled: true };
        }
    }
    if (action.noCopy) { await applyWinner(action, { local, remote, localEntries, remoteEntries }); return { quarantined: false }; }
    const winnerIsLocal = action.winner === 'local';
    const loserSide = winnerIsLocal ? remote : local;
    const loserEntry = winnerIsLocal ? remoteEntries[action.path] : localEntries[action.path];
    const loserHash = winnerIsLocal ? action.remoteHash : action.localHash;
    const wantsQuarantine = action.firstMeet && conflictPolicy(action.path) === 'quarantine' && typeof loserSide.quarantine === 'function';

    if (wantsQuarantine) {
        const loserBlob = await loserSide.read(action.path);
        await loserSide.quarantine(action.path, loserBlob, { hash: loserHash, key: loserEntry?.key, modified: loserEntry?.modified, from: winnerIsLocal ? 'remote' : 'local' });
        await applyWinner(action, { local, remote, localEntries, remoteEntries });
        return { quarantined: true };
    }

    const loserBlob = await loserSide.read(action.path);
    const meta = { hash: loserHash, modified: loserEntry?.modified };
    if (!action.copyOn?.local) await local.write(action.conflictPath, loserBlob, meta);
    if (!action.copyOn?.remote) await remote.write(action.conflictPath, loserBlob, meta);
    await applyWinner(action, { local, remote, localEntries, remoteEntries });
    return { quarantined: false };
}
