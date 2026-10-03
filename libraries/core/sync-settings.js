/**
 * Синхронизация настроек самого движка (`extensionSettings.stme_settings`: раздел → ключ → значение). Чистые функции, без ввода-вывода.
 *
 * Единица синхронизации — ОДНА пара «раздел + ключ» = один файл `stmeSettings/<раздел>/<ключ>.json` (обёртка с временем правки и
 * значением). Мельче, чем «раздел целиком»: правки разных ключей на разных устройствах не мешают друг другу.
 *
 * **Не уезжают только API-ключи подключений к внешним ИИ-моделям** (решение владельца: всё остальное передаётся). Любое поле с именем
 * `apiKey`/`api_key`/`apiToken`/`authorization`/`bearer` вырезается из значения при отправке, на любой глубине вложенности; при
 * получении локальные значения этих полей остаются на месте (`restoreSecrets`) — пришедший файл их не затирает. Раздел `core.sync`
 * (id устройства, пары, доступы к GitHub и облаку) не синхронизируется целиком: это не настройка, а личность устройства (два устройства
 * с одним id сломали бы сопряжение) и доступ к самому каналу синхронизации (токен не должен лежать в репозитории, который он открывает).
 *
 * **Политика раздела.** Модуль/Ядро может объявить для своего раздела (`settings.declare`): `sync: false` (раздел не уезжает) и
 * `exclude: [ключи]` (отдельные ключи остаются на устройстве). Политика лежит рядом со значениями (`_syncMeta`/`policy`), поэтому её
 * видят и Ядро настроек, и Сервис синхронизации, не зная друг о друге.
 *
 * **Время правки.** У настроек его нет, поэтому оно ведётся рядом — служебный раздел `_syncMeta`/`updated` (`"раздел::ключ" → мс`):
 * `touchSetting` обновляет его ТОЛЬКО если значение действительно изменилось (пересохранение того же не сдвигает время и не создаёт
 * ложных изменений), а принятое с другого устройства значение приходит с его временем без изменений — иначе каждое получение
 * выглядело бы правкой и настройки бегали бы по кругу.
 */

export const SETTINGS_SECTION = 'stmeSettings';
export const SETTINGS_META_NAMESPACE = '_syncMeta';
const SETTINGS_META_KEY = 'updated';
export const SETTINGS_FORMAT = 'stme-setting';
/** Разделы, которые не уезжают целиком (личность устройства и его доступы). */
export const SETTINGS_EXCLUDED_NAMESPACES = Object.freeze(['core.sync', SETTINGS_META_NAMESPACE]);

const SECRET_NAME = /^(x[_-])?api[_-]?(key|token|secret)$|(?<=[a-z0-9])Api(Key|Token|Secret)$|^(authorization|bearer)$/i;
export const isSecretName = name => SECRET_NAME.test(String(name));

const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Копия значения без секретных полей на любой глубине. */
export function stripSecrets(value) {
    if (Array.isArray(value)) return value.map(stripSecrets);
    if (!isPlain(value)) return value;
    const out = {};
    for (const [name, inner] of Object.entries(value)) if (!isSecretName(name)) out[name] = stripSecrets(inner);
    return out;
}

/**
 * Пришедшее значение (уже без секретов) + то, что лежит у нас: секретные поля берутся у нас. Элементы массивов сопоставляются по `id`,
 * а без него — по месту (список подключений: у каждого свой `id` и свой ключ).
 */
export function restoreSecrets(incoming, local) {
    if (Array.isArray(incoming)) {
        const localItems = Array.isArray(local) ? local : [];
        return incoming.map((item, index) => {
            const match = isPlain(item) && item.id != null ? localItems.find(other => isPlain(other) && other.id === item.id) : localItems[index];
            return restoreSecrets(item, match);
        });
    }
    if (!isPlain(incoming)) return incoming;
    const out = {};
    for (const [name, inner] of Object.entries(incoming)) out[name] = restoreSecrets(inner, isPlain(local) ? local[name] : undefined);
    if (isPlain(local)) for (const [name, inner] of Object.entries(local)) if (isSecretName(name) && !(name in out)) out[name] = inner;
    return out;
}

/** JSON с отсортированными ключами: одно и то же значение на двух устройствах даёт один и тот же текст, а значит один хеш. */
export function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (isPlain(value)) return `{${Object.keys(value).sort().filter(name => value[name] !== undefined).map(name => `${JSON.stringify(name)}:${canonicalJson(value[name])}`).join(',')}}`;
    return JSON.stringify(value) ?? 'null';
}

const POLICY_KEY = 'policy';
/** Политика раздела: `sync` (по умолчанию да) и список ключей, остающихся на устройстве. */
export function sanitizePolicy(raw) {
    const input = isPlain(raw) ? raw : {};
    return { sync: input.sync !== false, exclude: [...new Set((Array.isArray(input.exclude) ? input.exclude : []).map(String).filter(Boolean))].sort() };
}
export function policyOf(raw, namespace) {
    return sanitizePolicy(raw?.[SETTINGS_META_NAMESPACE]?.[POLICY_KEY]?.[namespace]);
}
export function setPolicy(raw, namespace, policy) {
    raw[SETTINGS_META_NAMESPACE] ??= {};
    raw[SETTINGS_META_NAMESPACE][POLICY_KEY] ??= {};
    raw[SETTINGS_META_NAMESPACE][POLICY_KEY][namespace] = sanitizePolicy(policy);
    return raw[SETTINGS_META_NAMESPACE][POLICY_KEY][namespace];
}
/** Уезжает ли эта настройка вообще (раздел не исключён, политика разрешает, ключ не в списке остающихся на устройстве). */
export function isSyncable(raw, namespace, key) {
    if (SETTINGS_EXCLUDED_NAMESPACES.includes(namespace)) return false;
    const policy = policyOf(raw, namespace);
    return policy.sync && !policy.exclude.includes(key);
}

const metaKey = (namespace, key) => `${namespace}::${key}`;
const metaOf = raw => raw?.[SETTINGS_META_NAMESPACE]?.[SETTINGS_META_KEY] ?? {};
export const updatedAtOf = (raw, namespace, key) => Number(metaOf(raw)[metaKey(namespace, key)]) || 0;

function writeMeta(raw, namespace, key, value) {
    raw[SETTINGS_META_NAMESPACE] ??= {};
    const table = (raw[SETTINGS_META_NAMESPACE][SETTINGS_META_KEY] ??= {});
    if (value == null) delete table[metaKey(namespace, key)]; else table[metaKey(namespace, key)] = value;
}

/** Вызывается при каждом сохранении настройки (`storage.settings.set`): время сдвигается, только если значение изменилось. */
export function touchSetting(raw, namespace, key, previous, next, now) {
    if (SETTINGS_EXCLUDED_NAMESPACES.includes(namespace)) return false;
    if (canonicalJson(previous) === canonicalJson(next) && updatedAtOf(raw, namespace, key)) return false;
    writeMeta(raw, namespace, key, now);
    return true;
}

export function forgetSetting(raw, namespace, key) { writeMeta(raw, namespace, key, null); }

const enc = encodeURIComponent;
export const settingFileName = (namespace, key) => `${enc(namespace)}/${enc(key)}.json`;

/** `<раздел>/<ключ>.json` → { namespace, key }; копии конфликтов и посторонние имена → `null`. */
export function parseSettingFileName(name) {
    const match = String(name).match(/^([^/]+)\/([^/]+)\.json$/);
    if (!match) return null;
    try {
        const [namespace, key] = [decodeURIComponent(match[1]), decodeURIComponent(match[2])];
        if (/ \(conflict [^)]*\)( \d+)?$/.test(key) || SETTINGS_EXCLUDED_NAMESPACES.includes(namespace)) return null;
        return { namespace, key };
    } catch { return null; }
}

export function serializeSetting({ namespace, key, updatedAt, value }) {
    return canonicalJson({ format: SETTINGS_FORMAT, namespace, key, updatedAt, value: stripSecrets(value) });
}

export function parseSettingFile(text) {
    const data = JSON.parse(text);
    if (data?.format !== SETTINGS_FORMAT || typeof data.namespace !== 'string' || typeof data.key !== 'string') throw new Error('not an engine setting file');
    if (SETTINGS_EXCLUDED_NAMESPACES.includes(data.namespace)) throw new Error(`settings section "${data.namespace}" is not synchronised`);
    return { namespace: data.namespace, key: data.key, updatedAt: Number(data.updatedAt) || 0, value: data.value };
}

/** Все синхронизируемые настройки: [{ namespace, key, updatedAt, text, size }] — `text` уже без секретов. */
export function collectSettings(raw) {
    const out = [];
    for (const [namespace, bucket] of Object.entries(raw ?? {})) {
        if (SETTINGS_EXCLUDED_NAMESPACES.includes(namespace) || !isPlain(bucket)) continue;
        for (const [key, value] of Object.entries(bucket)) {
            if (value === undefined || !isSyncable(raw, namespace, key)) continue;
            const updatedAt = updatedAtOf(raw, namespace, key);
            const text = serializeSetting({ namespace, key, updatedAt, value });
            out.push({ namespace, key, updatedAt, text, size: text.length });
        }
    }
    return out;
}

/** Принять настройку с другого устройства: секреты остаются нашими, время — как у отправителя. */
export function applySetting(raw, { namespace, key, updatedAt, value }) {
    if (!isSyncable(raw, namespace, key)) return false;   // этот раздел/ключ у нас объявлен «только на устройстве»
    raw[namespace] ??= {};
    raw[namespace][key] = restoreSecrets(value, raw[namespace][key]);
    writeMeta(raw, namespace, key, updatedAt);
    return true;
}

export function removeSetting(raw, namespace, key) {
    if (raw?.[namespace] && key in raw[namespace]) delete raw[namespace][key];
    forgetSetting(raw, namespace, key);
}
