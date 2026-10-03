/**
 * Запасная копия API-ключей — чистые функции, без ввода-вывода.
 *
 * Зачем. Ключи лежат в `settings.json` ST внутри настроек движка (`core.models.internal/workers[…].apiKey` и т.п.), а этот файл ST
 * пишет ЦЕЛИКОМ из памяти любой открытой страницы. Вторая страница с устаревшей копией (вкладка, открытая до того, как ключ ввели),
 * синхронизация настроек или откат файла стирают ключ у пользователя, и он замечает это только когда запрос уходит без ключа.
 * Копия ключей в хранилище БРАУЗЕРА (IndexedDB, рядом с состоянием синхронизации) переживает перезапись `settings.json` и позволяет
 * при следующем запуске вернуть пропавший ключ САМОМУ СЕБЕ, ничего не спрашивая. Ключи, как и в `settings.json`, лежат открытым
 * текстом — это не новая поверхность: тот же пользователь, то же устройство.
 *
 * Что считается секретом — то же, что в синхронизации ([sync-settings.js](sync-settings.js) `isSecretName`): их же и вырезает синк при
 * отправке. Копия ничего не отправляет наружу.
 *
 * Правила (чтобы не воскрешать то, что человек убрал нарочно):
 *  - явная запись непустого ключа — копия обновляется;
 *  - явная запись ПУСТОЙ строки — человек стёр ключ, копия удаляется;
 *  - поле ОТСУТСТВУЕТ в записываемом значении — это не решение человека (пришло из синка/старой копии), копия остаётся;
 *  - восстановление заполняет только поле, которого нет или которое пусто, и только если сама запись (воркер с тем же `id`) на месте.
 *
 * Адрес секрета — JSON-массив сегментов (имена полей, элементы списков по `id`, а без `id` по номеру): стабильный, не зависит от
 * порядка элементов в списке.
 */

import { isSecretName } from './sync-settings.js';

const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** `[путь, значение]` для каждого строкового поля с секретным именем (в том числе пустого) на любой глубине. */
export function* secretLeaves(value, trail = []) {
    if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) {
            const segment = isPlain(item) && item.id != null ? `i:${item.id}` : `n:${index}`;
            yield* secretLeaves(item, [...trail, segment]);
        }
    } else if (isPlain(value)) {
        for (const [name, inner] of Object.entries(value)) {
            if (isSecretName(name) && typeof inner === 'string') yield [JSON.stringify([...trail, `k:${name}`]), inner];
            else yield* secretLeaves(inner, [...trail, `k:${name}`]);
        }
    }
}

/** Новая запись копии для одного значения настройки: непустые ключи обновляются, явно пустые — удаляются, отсутствующие не трогаются. */
export function updateEntry(entry = {}, value) {
    const next = { ...entry };
    for (const [path, secret] of secretLeaves(value)) {
        if (secret) next[path] = secret; else delete next[path];
    }
    return next;
}

/** То же, но только добавляет непустые (первый запуск: сохранить то, что уже лежит в настройках, ничего не удаляя). */
export function seedEntry(entry = {}, value) {
    const next = { ...entry };
    for (const [path, secret] of secretLeaves(value)) if (secret && !next[path]) next[path] = secret;
    return next;
}

function parentOf(value, segments) {
    let node = value;
    for (const segment of segments) {
        const [kind, ...rest] = segment.split(':');
        const name = rest.join(':');
        if (kind === 'k') node = isPlain(node) ? node[name] : undefined;
        else if (kind === 'i') node = Array.isArray(node) ? node.find(item => isPlain(item) && String(item.id) === name) : undefined;
        else node = Array.isArray(node) ? node[Number(name)] : undefined;
        if (node === undefined || node === null) return undefined;
    }
    return node;
}

/**
 * Вернуть пропавшие ключи в значение (на месте). Заполняется только поле, которого нет или которое пусто, при этом запись-родитель
 * должна существовать (воркер с этим `id` ещё в списке).
 * @returns {number} сколько ключей возвращено
 */
export function healValue(value, entry = {}) {
    let restored = 0;
    for (const [path, secret] of Object.entries(entry)) {
        let segments;
        try { segments = JSON.parse(path); } catch { continue; }
        const leaf = segments.at(-1);
        if (!leaf?.startsWith('k:') || !secret) continue;
        const parent = parentOf(value, segments.slice(0, -1));
        if (!isPlain(parent)) continue;
        const name = leaf.slice(2);
        if (typeof parent[name] === 'string' && parent[name] !== '') continue;
        if (name in parent && parent[name] !== '' && parent[name] != null) continue;
        parent[name] = secret;
        restored += 1;
    }
    return restored;
}

export const vaultKey = (namespace, key) => `${namespace}::${key}`;
export function splitVaultKey(text) {
    const at = String(text).indexOf('::');
    return at < 0 ? null : [text.slice(0, at), text.slice(at + 2)];
}
