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
 *
 * **Сравнение по `key`, не только по `hash`** — главный фикс ложных конфликтов персонажей (см. `card-fingerprint.js`): запись
 * манифеста может нести необязательный `key` — семантический отпечаток («тот же персонаж») в дополнение к обычному байтовому
 * `hash`. Для пути, где `key` есть у ОБЕИХ сторон, сравнение (`L==R`, `R==B`, `L==B`) идёт по `key`; если хотя бы у одной стороны
 * его нет (не тот раздел, ещё не пересчитан после миграции, или это GitHub/облако — те всегда отдают только git-blob sha),
 * сравнение остаётся по `hash`, как раньше. Значение, записанное в `B` после этого прохода, — то же, что сравнивалось (`key` или
 * `hash`), поэтому следующий проход сравнивает в той же системе координат сам по себе: если старая `B` — байтовый хеш, а сейчас
 * сравнение идёт по `key` (формат `card1:…`, никогда не совпадёт со строкой байтового хеша), это уже даёт эффект «`B` для этого
 * пути не в счёт» без отдельного кода — ближайший проход просто мигрирует его на `key` через обычные ветки ниже.
 *
 * `action.hash` у `push`/`pull`/`restored`-веток — ВСЕГДА настоящий байтовый хеш переносимого содержимого (нужен получателю для
 * `meta.hash`/кэша — тот должен уметь дать обычный хеш и стороне, которая `key` не понимает). `action.baseValue` — то, что
 * записывается в `B` (совпадает с `action.hash`, когда `key` не используется — нулевая разница в поведении для всех остальных
 * категорий; иначе — семантический `key`). У `settle` своего переноса нет, поэтому там `hash` и есть значение для `B`.
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

/** Файл-копия конфликта не должен снова конфликтовать «по кругу»: копии пропускаются при повторном разборе. `( 2)`/`( 3)` — суффикс
 *  уникальности из `disambiguateConflictPath` ниже — тоже считается копией. */
export function isConflictCopy(path) {
    return /\(conflict [^)]*\)( \d+)?(\.[^/.]*)?$/.test(String(path));
}

/**
 * Уникальность имени копии (ROADMAP 5.106е, Этап 4.5): `computeConflictPath` до этой правки был точен до МИНУТЫ (метка приходит из
 * `stampLabel` в `cores/sync/index.js`) — два конфликта одного и того же пути в пределах одной минуты (быстрые повторные проходы
 * при частых правках на обеих сторонах) вычисляли ОДНО И ТО ЖЕ имя копии и вторая копия молча переписывала первую, теряя её
 * содержимое. Секунды в самой метке сокращают окно почти до нуля, но не гарантируют его — эта функция закрывает случай окончательно:
 * если готовый кандидат уже существует (передан набор занятых путей — типично `local`/`remote` этого прохода), перед расширением
 * добавляется ` 2`, ` 3`, … до первого свободного.
 * @param {string} candidate — уже собранный `computeConflictPath(...)`
 * @param {Set<string>} taken — пути, которые нельзя занять повторно
 */
export function disambiguateConflictPath(candidate, taken) {
    if (!taken.has(candidate)) return candidate;
    const slash = candidate.lastIndexOf('/');
    const dot = candidate.lastIndexOf('.');
    const [stem, ext] = dot > slash ? [candidate.slice(0, dot), candidate.slice(dot)] : [candidate, ''];
    for (let n = 2; ; n += 1) {
        const numbered = `${stem} ${n}${ext}`;
        if (!taken.has(numbered)) return numbered;
    }
}

/**
 * Копия конфликта, уже созданная РАНЬШЕ для этого пути с тем же содержимым проигравшей версии (хоть на одной из сторон). Проход, оборванный
 * посреди разбора конфликта, оставляет такую копию, а сам путь так и остаётся «конфликтным»: без этой проверки каждый повтор делал бы
 * НОВУЮ копию (метка времени другая → имя другое) — отсюда по 4–5 копий одного персонажа. Копия с тем же содержимым — это и есть нужная копия.
 * @returns {{path:string, local:boolean, remote:boolean}|null}
 */
export function findExistingConflictCopy(path, loserHash, { local = {}, remote = {} } = {}) {
    if (!loserHash) return null;
    const text = String(path);
    const slash = text.lastIndexOf('/');
    const dir = slash < 0 ? '' : text.slice(0, slash + 1);
    const name = slash < 0 ? text : text.slice(slash + 1);
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    const prefix = `${dir}${stem} (conflict `;
    const matches = candidate => candidate.startsWith(prefix) && candidate.endsWith(ext) && isConflictCopy(candidate);
    const found = [...new Set([...Object.keys(local), ...Object.keys(remote)])].filter(candidate => matches(candidate) && (hashOf(local[candidate]) === loserHash || hashOf(remote[candidate]) === loserHash)).sort();
    if (!found.length) return null;
    const best = found[0];
    return { path: best, local: hashOf(local[best]) === loserHash, remote: hashOf(remote[best]) === loserHash };
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
/** Значение для сравнения этого пути: `key` только если оно есть у ОБЕИХ сторон, иначе обычный байтовый `hash` (см. doc-comment файла). */
function comparable(localEntry, remoteEntry) {
    const useKey = Boolean(localEntry?.key && remoteEntry?.key);
    return {
        l: useKey ? localEntry.key : hashOf(localEntry), r: useKey ? remoteEntry.key : hashOf(remoteEntry),
    };
}

export function computeSyncPlan({ local = {}, remote = {}, base = {}, conflictLabel = 'conflict', include = () => true, noCopy = () => false } = {}) {
    const paths = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base)]);
    const actions = [];
    // Занятые пути для уникальности копии конфликта (Этап 4.5) — то, что реально есть хоть у одной стороны сейчас; конфликты,
    // сгенерированные РАНЕЕ в этом же проходе, тоже не могут повториться (разный путь-источник → разное имя копии по построению),
    // так что достаточно посчитать один раз.
    const takenPaths = new Set([...Object.keys(local), ...Object.keys(remote)]);

    for (const path of [...paths].sort()) {
        if (!include(path, { local: local[path], remote: remote[path] })) continue;
        const { l, r } = comparable(local[path], remote[path]);
        const b = base[path] ?? null;

        if (l === r) {
            if (l !== b) actions.push({ op: SYNC_ACTIONS.settle, path, hash: l });
            continue;
        }
        if (r === b) {
            actions.push(l === null ? { op: SYNC_ACTIONS.deleteRemote, path } : { op: SYNC_ACTIONS.push, path, hash: hashOf(local[path]), baseValue: l, key: local[path].key, size: local[path].size, modified: local[path].modified });
            continue;
        }
        if (l === b) {
            actions.push(r === null ? { op: SYNC_ACTIONS.deleteLocal, path } : { op: SYNC_ACTIONS.pull, path, hash: hashOf(remote[path]), baseValue: r, key: remote[path].key, size: remote[path].size, modified: remote[path].modified });
            continue;
        }
        // Менялись обе стороны.
        if (l === null) { actions.push({ op: SYNC_ACTIONS.pull, path, hash: hashOf(remote[path]), baseValue: r, key: remote[path].key, size: remote[path].size, modified: remote[path].modified, restored: true }); continue; }
        if (r === null) { actions.push({ op: SYNC_ACTIONS.push, path, hash: hashOf(local[path]), baseValue: l, key: local[path].key, size: local[path].size, modified: local[path].modified, restored: true }); continue; }
        const lm = local[path].modified ?? 0;
        const rm = remote[path].modified ?? 0;
        // Равное время — выигрывает больший хеш: обе стороны, считая независимо, выберут одну и ту же версию.
        const winner = lm !== rm ? (lm > rm ? 'local' : 'remote') : (l > r ? 'local' : 'remote');
        // `firstMeet` — этот путь ни разу не синхронизировался (`b === null`), а не «изменили оба после общей истории»: разные вещи,
        // случайно попавшие в одну ветку сравнения. Пара только что встретилась — попытка резолвера (`sync-runner.js`) увести проигравшую
        // версию в карантин, а не плодить файл-копию в самой ST, применяется именно к этому случаю (см. `sync-config.js`'s `CONFLICT_POLICY`).
        const loserHash = hashOf(winner === 'local' ? remote[path] : local[path]);
        // Сама копия конфликта не плодит копий копий («log (conflict A) (conflict B)»): побеждает более свежая, без нового файла.
        if (isConflictCopy(path) || noCopy(path)) {
            actions.push({ op: SYNC_ACTIONS.conflict, path, winner, firstMeet: false, noCopy: true, localHash: hashOf(local[path]), remoteHash: hashOf(remote[path]) });
            continue;
        }
        const existing = findExistingConflictCopy(path, loserHash, { local, remote });
        const conflictPath = existing ? existing.path : disambiguateConflictPath(computeConflictPath(path, conflictLabel), takenPaths);
        takenPaths.add(conflictPath);   // тот же путь дважды в одном проходе исключён (пути в цикле не повторяются), но чужой конфликт мог занять это же имя первым
        actions.push({ op: SYNC_ACTIONS.conflict, path, winner, firstMeet: b === null, conflictPath, copyOn: existing ? { local: existing.local, remote: existing.remote } : { local: false, remote: false }, localHash: hashOf(local[path]), remoteHash: hashOf(remote[path]) });
    }

    const counts = { push: 0, pull: 0, deleteLocal: 0, deleteRemote: 0, conflict: 0, settle: 0 };
    for (const action of actions) counts[action.op] += 1;
    return { actions, counts };
}

const equivalent = (a, b) => Boolean(a && b && (a.hash === b.hash || (a.key && b.key && a.key === b.key)));

/** `dir/stem (conflict …)[ n].ext` → путь оригинала `dir/stem.ext`; не копия → `null`. */
export function conflictCopyOriginal(path) {
    const match = String(path).match(/^(.*) \(conflict [^)]*\)(?: \d+)?(\.[^/.]*)?$/);
    return match ? `${match[1]}${match[2] ?? ''}` : null;
}

/**
 * Автоочистка копий конфликтов — только тех, удаление которых ничего не теряет. Чистое решение, ничего не трогает.
 * Копия лишняя, если ЛОКАЛЬНО она эквивалентна своему оригиналу (тот же байтовый `hash` или тот же `key` — отпечаток карточки персонажа)
 * либо повторяет более раннюю копию того же оригинала (после обрывов проходов их бывало по 4–5 штук). Копия с ОТЛИЧАЮЩИМСЯ содержимым —
 * настоящая вторая версия, её не трогаем. Удалённая копия обязана совпадать с локальной (по хешу/ключу) или не меняться с прошлой
 * синхронизации (`base`) — иначе там могла появиться новая правка, и мы её не видели. Оригинала нет — копию оставляем.
 * @param {object} input
 * @param {Record<string,object>} input.local
 * @param {Record<string,object>} input.remote
 * @param {Record<string,string>} input.base
 * @param {Set<string>} [input.busy] — пути, которые этот проход и так меняет (оригиналы/копии в работе) — не трогаем
 * @param {(path:string)=>boolean} [input.include]
 * @returns {Array<{path:string, original:string, reason:'same-as-original'|'duplicate-copy', remote:boolean}>}
 */
export function planCopyCleanup({ local = {}, remote = {}, base = {}, busy = new Set(), include = () => true } = {}) {
    const byOriginal = new Map();
    for (const path of Object.keys(local)) {
        const original = conflictCopyOriginal(path);
        if (!original || !local[original] || busy.has(path) || busy.has(original) || !include(path, { local: local[path], remote: remote[path] })) continue;
        if (!byOriginal.has(original)) byOriginal.set(original, []);
        byOriginal.get(original).push(path);
    }
    const remoteSafe = path => !remote[path] || equivalent(local[path], remote[path]) || base[path] === remote[path].hash;
    const result = [];
    for (const [original, copies] of byOriginal) {
        const kept = [];
        for (const path of copies.sort()) {
            if (!remoteSafe(path)) continue;
            if (equivalent(local[path], local[original])) { result.push({ path, original, reason: 'same-as-original', remote: Boolean(remote[path]) }); continue; }
            if (kept.some(other => equivalent(local[path], local[other]))) { result.push({ path, original, reason: 'duplicate-copy', remote: Boolean(remote[path]) }); continue; }
            kept.push(path);
        }
    }
    return result;
}

const MASS_DELETE_MIN_COUNT = 20;
const MASS_DELETE_RATIO = 0.3;

/**
 * Категории, которые план хочет удалить подозрительно массово (ROADMAP 5.106в, Этап 4.4 задания) — типичный симптом: временный
 * пустой ответ листинга ST (`/api/characters/all` на секунду отдал `[]`) читается как «всё удалено», и без этой защиты синхронизация
 * ПОВТОРИЛА бы это удаление на другом устройстве, хотя там ничего на самом деле не пропадало. Срабатывает на путь удаления
 * (`deleteLocal`/`deleteRemote`), сгруппированный по категории (`categoryOf`, обычно `categoryOfPath` из `sync-config.js`):
 *  - подряд **больше `MASS_DELETE_MIN_COUNT` файлов И больше `MASS_DELETE_RATIO` (30%)** от того, что СЕЙЧАС есть в категории на
 *    стороне, откуда удаляем (до этого удаления) — единичная пропажа блокировкой не считается, даже если категория маленькая;
 *  - **или** категория стала бы совсем ПУСТОЙ на этой стороне, а база для неё помнит хоть один файл — самый явный признак
 *    «листинг вернул пусто», раз ни одного файла не осталось буквально ни одного, но раньше что-то точно было.
 * Только ЧИСТОЕ решение — какие категории под подозрением; сам план не трогает (вызывающий, `sync-runner.js`, выбрасывает из
 * исполнения удаления этих категорий и помечает проход `needsConfirmation`, ничего не удаляя молча).
 * @param {object} input
 * @param {Array<object>} input.actions — `plan.actions` из `computeSyncPlan`
 * @param {Record<string,object>} input.local
 * @param {Record<string,object>} input.remote
 * @param {Record<string,string>} input.base
 * @param {(path:string)=>string|null} input.categoryOf
 * @returns {Set<string>} категории под подозрением
 */
export function detectMassDeletion({ actions = [], local = {}, remote = {}, base = {}, categoryOf }) {
    const byCategory = new Map();
    for (const action of actions) {
        if (action.op !== SYNC_ACTIONS.deleteLocal && action.op !== SYNC_ACTIONS.deleteRemote) continue;
        const category = categoryOf(action.path);
        if (!category) continue;
        if (!byCategory.has(category)) byCategory.set(category, { deleteLocal: [], deleteRemote: [] });
        byCategory.get(category)[action.op].push(action.path);
    }
    const countIn = (entries, category) => Object.keys(entries).filter(path => categoryOf(path) === category).length;
    const baseCountIn = category => Object.keys(base).filter(path => categoryOf(path) === category).length;
    const suspicious = new Set();
    for (const [category, { deleteLocal, deleteRemote }] of byCategory) {
        const check = (deletions, sideEntries, otherEntries) => {
            if (!deletions.length) return false;
            const totalBefore = countIn(sideEntries, category);
            const remainingAfter = totalBefore - deletions.length;
            const ratioTripped = deletions.length > MASS_DELETE_MIN_COUNT && deletions.length > totalBefore * MASS_DELETE_RATIO;
            const emptiedTripped = remainingAfter === 0 && baseCountIn(category) > 0;
            // Другая сторона пуста целиком, хотя база помнит файлы категории: стёрта папка/репозиторий/диск, а не отдельные файлы —
            // блокируем даже при малом числе файлов (иначе в маленькой категории синхронизация молча повторила бы стирание у нас).
            const otherWipedTripped = countIn(otherEntries, category) === 0 && baseCountIn(category) > 0;
            return ratioTripped || emptiedTripped || otherWipedTripped;
        };
        if (check(deleteLocal, local, remote) || check(deleteRemote, remote, local)) suspicious.add(category);
    }
    return suspicious;
}

/** Хеши базы из записи «путь → {hash}» (то, что хранится на диске после прошлой синхронизации). */
export function resolveBaseHashes(baseEntries = {}) {
    return Object.fromEntries(Object.entries(baseEntries).map(([path, value]) => [path, typeof value === 'string' ? value : value?.hash]).filter(([, hash]) => typeof hash === 'string'));
}

export function countPlannedTransfers(plan) {
    return plan.counts.push + plan.counts.pull + plan.counts.conflict * 2;
}
