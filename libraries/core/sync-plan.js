/**
 * Чистое трёхстороннее сравнение для синхронизации файлов: у каждого пути есть три состояния —
 *   L (local)  — что лежит здесь сейчас,
 *   R (remote) — что лежит у другой стороны (устройство или репозиторий),
 *   B (base)   — что было у обеих сторон при прошлой УДАЧНОЙ синхронизации.
 * Каждое состояние — хеш содержимого или `null` («файла нет»). Без B нельзя отличить «я удалил» от «там появилось», а без него
 * синхронизация либо воскрешает удалённое, либо теряет правки. Сети, диска и часов здесь нет — только решение.
 *
 * Правила (для каждого пути):
 *   L == R                → ничего не делать, лишь запомнить B = L;
 *   R == B (изменился L)  → отправить (или удалить у другой стороны, если у нас файла нет);
 *   L == B (изменился R)  → забрать (или удалить у нас, если там файла больше нет);
 *   иначе (менялись оба)  → КОНФЛИКТ: удаление против правки выигрывает правка (данные не теряются молча); две правки —
 *                           побеждает более свежая по времени изменения, проигравшая версия сохраняется рядом копией.
 */

export const SYNC_ACTIONS = Object.freeze({ push: 'push', pull: 'pull', deleteLocal: 'deleteLocal', deleteRemote: 'deleteRemote', conflict: 'conflict', settle: 'settle' });

const hashOf = entry => (entry ? entry.hash : null);

/** `report.txt` → `report (conflict Phone 2026-09-19 14-05).txt`; расширение сохраняется, чтобы копию открывало то же приложение. */
export function computeConflictPath(path, label) {
    const text = String(path);
    const slash = text.lastIndexOf('/');
    const dir = slash < 0 ? '' : text.slice(0, slash + 1);
    const name = slash < 0 ? text : text.slice(slash + 1);
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    const safeLabel = String(label).replace(/[\\/:*?"<>|]/g, '_').trim();
    return `${dir}${stem} (conflict ${safeLabel})${ext}`;
}

/** Файл-копия конфликта не должен снова конфликтовать «по кругу»: копии пропускаются при повторном разборе. */
export function isConflictCopy(path) {
    return /\(conflict [^)]*\)(\.[^/.]*)?$/.test(String(path));
}

/**
 * @param {object} input
 * @param {Record<string,{hash:string,size?:number,modified?:number}>} input.local
 * @param {Record<string,{hash:string,size?:number,modified?:number}>} input.remote
 * @param {Record<string,string>} input.base — путь → хеш на момент прошлой синхронизации
 * @param {string} input.conflictLabel — метка для имени копии проигравшей версии (устройство + время)
 * @param {(path:string, entries:{local?:object, remote?:object})=>boolean} [input.include] — фильтр (выбранные категории, потолок размера)
 * @returns {{actions:Array<object>, counts:object}}
 */
export function computeSyncPlan({ local = {}, remote = {}, base = {}, conflictLabel = 'conflict', include = () => true } = {}) {
    const paths = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base)]);
    const actions = [];

    for (const path of [...paths].sort()) {
        if (!include(path, { local: local[path], remote: remote[path] })) continue;
        const l = hashOf(local[path]);
        const r = hashOf(remote[path]);
        const b = base[path] ?? null;

        if (l === r) {
            if (l !== b) actions.push({ op: SYNC_ACTIONS.settle, path, hash: l });
            continue;
        }
        if (r === b) {
            actions.push(l === null ? { op: SYNC_ACTIONS.deleteRemote, path } : { op: SYNC_ACTIONS.push, path, hash: l, size: local[path].size, modified: local[path].modified });
            continue;
        }
        if (l === b) {
            actions.push(r === null ? { op: SYNC_ACTIONS.deleteLocal, path } : { op: SYNC_ACTIONS.pull, path, hash: r, size: remote[path].size, modified: remote[path].modified });
            continue;
        }
        // Менялись обе стороны.
        if (l === null) { actions.push({ op: SYNC_ACTIONS.pull, path, hash: r, size: remote[path].size, modified: remote[path].modified, restored: true }); continue; }
        if (r === null) { actions.push({ op: SYNC_ACTIONS.push, path, hash: l, size: local[path].size, modified: local[path].modified, restored: true }); continue; }
        const lm = local[path].modified ?? 0;
        const rm = remote[path].modified ?? 0;
        // Равное время — выигрывает больший хеш: обе стороны, считая независимо, выберут одну и ту же версию.
        const winner = lm !== rm ? (lm > rm ? 'local' : 'remote') : (l > r ? 'local' : 'remote');
        actions.push({ op: SYNC_ACTIONS.conflict, path, winner, conflictPath: computeConflictPath(path, conflictLabel), localHash: l, remoteHash: r });
    }

    const counts = { push: 0, pull: 0, deleteLocal: 0, deleteRemote: 0, conflict: 0, settle: 0 };
    for (const action of actions) counts[action.op] += 1;
    return { actions, counts };
}

/** Хеши базы из записи «путь → {hash}» (то, что хранится на диске после прошлой синхронизации). */
export function resolveBaseHashes(baseEntries = {}) {
    return Object.fromEntries(Object.entries(baseEntries).map(([path, value]) => [path, typeof value === 'string' ? value : value?.hash]).filter(([, hash]) => typeof hash === 'string'));
}

export function countPlannedTransfers(plan) {
    return plan.counts.push + plan.counts.pull + plan.counts.conflict * 2;
}
