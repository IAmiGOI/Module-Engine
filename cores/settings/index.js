import { request } from '../../libraries/shared/request.js';
import { readNamespacedValue, writeNamespacedValue, removeNamespacedValue, listNamespacedKeys } from '../../libraries/core/namespaced-store.js';
import { healValue, seedEntry, splitVaultKey, updateEntry, vaultKey } from '../../libraries/core/secret-vault.js';
import { SETTINGS_EXCLUDED_NAMESPACES, SETTINGS_META_NAMESPACE, forgetSetting, policyOf, sanitizePolicy, setPolicy, touchSetting, updatedAtOf } from '../../libraries/core/sync-settings.js';

/** Defensive reader — a missing/blank namespace or key fails loudly (caught by the bus's own error envelope), never silently reads/writes the wrong bucket. */
function requireLocation(params) {
    const namespace = String(params?.namespace ?? '').trim();
    const key = String(params?.key ?? '').trim();
    if (!namespace) throw new Error('storage.settings: "namespace" is required.');
    if (!key) throw new Error('storage.settings: "key" is required.');
    return { namespace, key };
}

/**
 * Ядро сохранения (CORES.md, ARCHITECTURE.md "Персистентность") —
 * настройки/конфигурация модулей и ядер: ГЛОБАЛЬНЫЕ (не привязанные к
 * текущему чату — это Ядро внутренней памяти чата, [cores/memory/index.js](../memory/index.js)).
 * Тот же разрез: это Ядро владеет неймспейсингом
 * ([namespaced-store.js](../../libraries/core/namespaced-store.js), общая
 * Библиотека — тот самый второй потребитель, ради которого она и
 * задумывалась как общая), тонкий Сервис
 * ([services/extension-settings.js](../../services/extension-settings.js))
 * делает реальную запись (extensionSettings + saveSettingsDebounced).
 *
 * `namespace` заявляется вызывающим в параметрах запроса, не структурно
 * проверяется — тот же осознанный компромисс, что и у Ядра внутренней
 * памяти чата (см. его doc-comment и ARCHITECTURE.md "Персистентность" за
 * разбором).
 *
 * **Поправка к раннему наброску в ARCHITECTURE.md**: там написано, что это
 * Ядро "зарегистрировано сразу на Шине модулей и на Шине ядер". Это
 * предшествовало более позднему, проверенному на практике правилу "КАЖДЫЙ
 * переход Ядро/Модуль → что угодно другое идёт через настоящий Гейт, без
 * исключений" (см. историю с Ядром финального UI в ARCHITECTURE.md).
 * Буквальная двойная регистрация означала бы, что Модуль достаёт до
 * `storage.settings.*` через СВОЮ ЖЕ шину — то есть вообще без Гейта и без
 * проверки прав. Вместо этого здесь используется ТОТ ЖЕ паттерн, что уже
 * закреплён Ядром внутренней памяти чата: регистрация ТОЛЬКО на `host.own`
 * (Шина ядер) — Ядра достают напрямую (свой домен), Модули — через
 * обычный Гейт Модуль→Ядро, с реальной проверкой прав на каждый вызов.
 * "И те, и другие шлют данные" остаётся верным — просто безопасно.
 */
export function createSettingsCore(host, { now = () => Date.now() } = {}) {
    const publishEvent = (event, payload) => host.events?.emit?.(event, payload);
    async function readRaw() {
        const result = await request(host.services, 'extensionSettings.read', {});
        if (!result.ok) throw new Error(result.error.message);
        return result.value ?? {};
    }

    async function writeRaw(raw) {
        const result = await request(host.services, 'extensionSettings.write', { params: { raw } });
        if (!result.ok) throw new Error(result.error.message);
    }

    // ── Запасная копия API-ключей (libraries/core/secret-vault.js) ──────────────────────────────────────────────────
    // `settings.json` ST пишет целиком из памяти ЛЮБОЙ открытой страницы: вторая вкладка с устаревшей копией, откат файла или приём
    // настроек стирают ключ. Копия лежит в хранилище браузера (сервис `syncState`), переживает это и возвращает ключ при следующем запуске.
    const VAULT_STATE_KEY = 'secretVault';
    let vaultQueue = Promise.resolve();
    const inVault = task => { const run = vaultQueue.then(task, task); vaultQueue = run.catch(() => {}); return run; };
    async function readVault() {
        const result = await request(host.services, 'syncState.get', { params: { key: VAULT_STATE_KEY } });
        return result.ok && result.value && typeof result.value === 'object' ? result.value : {};
    }
    const writeVault = vault => request(host.services, 'syncState.set', { params: { key: VAULT_STATE_KEY, value: vault } });
    const rememberSecrets = (namespace, key, value) => inVault(async () => {
        const vault = await readVault();
        const name = vaultKey(namespace, key);
        const next = updateEntry(vault[name], value);
        if (JSON.stringify(next) === JSON.stringify(vault[name] ?? {})) return;
        if (Object.keys(next).length) vault[name] = next; else delete vault[name];
        await writeVault(vault);
    }).catch(() => {});
    const forgetSecrets = (namespace, key) => inVault(async () => {
        const vault = await readVault();
        if (vault[vaultKey(namespace, key)] === undefined) return;
        delete vault[vaultKey(namespace, key)];
        await writeVault(vault);
    }).catch(() => {});

    /** Вернуть пропавшие ключи из копии и сохранить в копию те, что уже лежат в настройках (первый запуск). @returns {Promise<number>} сколько ключей возвращено */
    const healSecrets = () => inVault(async () => {
        const raw = await readRaw();
        const vault = await readVault();
        let restored = 0;
        let vaultChanged = false;
        const touched = [];
        for (const [namespace, bucket] of Object.entries(raw)) {
            if (SETTINGS_EXCLUDED_NAMESPACES.includes(namespace) || !bucket || typeof bucket !== 'object') continue;
            for (const [key, value] of Object.entries(bucket)) {
                const name = vaultKey(namespace, key);
                const back = healValue(value, vault[name]);
                if (back) { restored += back; touched.push([namespace, key]); }
                const seeded = seedEntry(vault[name], value);
                if (JSON.stringify(seeded) !== JSON.stringify(vault[name] ?? {})) { vault[name] = seeded; vaultChanged = true; }
            }
        }
        if (restored) await writeRaw(raw);
        if (vaultChanged) await writeVault(vault);
        for (const [namespace, key] of touched) publishEvent('settings.changed', { namespace, key });
        return restored;
    }).catch(() => 0);

    const unregisterGet = host.own.register('storage.settings.get', async params => {
        const { namespace, key } = requireLocation(params);
        const raw = await readRaw();
        return readNamespacedValue(raw, namespace, key, params?.fallback);
    });

    const unregisterSet = host.own.register('storage.settings.set', async params => {
        const { namespace, key } = requireLocation(params);
        const raw = await readRaw();
        const isNewNamespace = !raw[namespace];
        const previous = readNamespacedValue(raw, namespace, key, undefined);
        writeNamespacedValue(raw, namespace, key, params?.value);
        touchSetting(raw, namespace, key, previous, params?.value, now());   // время правки для синхронизации — только если значение изменилось
        await writeRaw(raw);
        await rememberSecrets(namespace, key, params?.value);
        publishEvent('settings.changed', { namespace, key });
        if (isNewNamespace) publishEvent('settings.namespaces.changed', { namespace });
        return true;
    });

    // Only writes back when something was ACTUALLY removed — see
    // cores/memory/index.js's identical discipline and its own doc comment.
    const unregisterRemove = host.own.register('storage.settings.remove', async params => {
        const { namespace, key } = requireLocation(params);
        const raw = await readRaw();
        const removed = removeNamespacedValue(raw, namespace, key);
        if (removed) { forgetSetting(raw, namespace, key); await writeRaw(raw); await forgetSecrets(namespace, key); publishEvent('settings.changed', { namespace, key }); }
        return removed;
    });

    const unregisterKeys = host.own.register('storage.settings.keys', async params => {
        const namespace = String(params?.namespace ?? '').trim();
        if (!namespace) throw new Error('storage.settings: "namespace" is required.');
        return listNamespacedKeys(await readRaw(), namespace);
    });

    // ── Полноценный сервис настроек: отправка пакетом, объявление политики, список разделов ───────────────────────────────

    /**
     * Чей это раздел: звонящий (`core.guide`, `module.secrets`) может менять только СВОЙ раздел. Без `callerId` (вызов внутри самого
     * движка/тесты) ограничения нет. Раздел можно не указывать — тогда это раздел звонящего.
     */
    function ownedNamespace(params, context) {
        const callerId = context?.callerId;
        const namespace = String(params?.namespace ?? callerId ?? '').trim();
        if (!namespace) throw new Error('settings: "namespace" is required.');
        if (callerId && callerId !== namespace && callerId !== 'core.settings') throw new Error(`settings: "${callerId}" may only touch its own namespace, not "${namespace}".`);
        if (namespace === SETTINGS_META_NAMESPACE) throw new Error(`settings: "${namespace}" is reserved.`);
        return namespace;
    }

    /**
     * `settings.send` — ЕДИНЫЙ примитив отправки настроек для любого Модуля/Ядра (имя контракта фиксировано, раздел — параметр запроса,
     * см. CONVENTIONS.md §1). `values` — пары «ключ → значение» СВОЕГО раздела пакетом: одна запись на всё, время правки — только у
     * реально изменившихся ключей, одно событие `settings.changed` на каждый такой ключ. `replace: true` — ключи раздела, которых нет
     * в пакете, удаляются (раздел становится ровно таким).
     */
    const unregisterSend = host.own.register('settings.send', async (params, context) => {
        const namespace = ownedNamespace(params, context);
        const values = params?.values;
        if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('settings.send: "values" must be an object of key → value.');
        const raw = await readRaw();
        const isNewNamespace = !raw[namespace];
        const written = [], unchanged = [], removed = [];
        const stamp = now();
        for (const [key, value] of Object.entries(values)) {
            if (value === undefined) continue;
            const previous = readNamespacedValue(raw, namespace, key, undefined);
            writeNamespacedValue(raw, namespace, key, value);
            (touchSetting(raw, namespace, key, previous, value, stamp) ? written : unchanged).push(key);
        }
        if (params?.replace === true) {
            for (const key of listNamespacedKeys(raw, namespace)) if (!(key in values)) { removeNamespacedValue(raw, namespace, key); forgetSetting(raw, namespace, key); removed.push(key); }
        }
        if (written.length || removed.length || isNewNamespace) await writeRaw(raw);
        for (const [key, value] of Object.entries(values)) if (value !== undefined) await rememberSecrets(namespace, key, value);
        for (const key of removed) await forgetSecrets(namespace, key);
        for (const key of [...written, ...removed]) publishEvent('settings.changed', { namespace, key });
        if (isNewNamespace) publishEvent('settings.namespaces.changed', { namespace });
        return { namespace, written, unchanged, removed };
    });

    /** `settings.declare` — раздел заявляет свою политику синхронизации: `sync` (false — раздел остаётся на устройстве) и `exclude` (ключи, остающиеся на устройстве). */
    const unregisterDeclare = host.own.register('settings.declare', async (params, context) => {
        const namespace = ownedNamespace(params, context);
        const raw = await readRaw();
        const policy = setPolicy(raw, namespace, { ...policyOf(raw, namespace), ...(params?.sync !== undefined ? { sync: params.sync } : {}), ...(params?.exclude !== undefined ? { exclude: params.exclude } : {}) });
        await writeRaw(raw);
        publishEvent('settings.namespaces.changed', { namespace });
        return policy;
    });

    /** Блок `settings.namespaces` — все разделы настроек: ключи, политика синхронизации, время последней правки. Событие — `settings.namespaces.changed`. */
    const unregisterNamespaces = host.own.register('settings.namespaces', async () => {
        const raw = await readRaw();
        return Object.keys(raw).filter(namespace => namespace !== SETTINGS_META_NAMESPACE).sort().map(namespace => {
            const keys = listNamespacedKeys(raw, namespace);
            return { namespace, keys, policy: sanitizePolicy(policyOf(raw, namespace)), synced: !SETTINGS_EXCLUDED_NAMESPACES.includes(namespace) && policyOf(raw, namespace).sync, updatedAt: Math.max(0, ...keys.map(key => updatedAtOf(raw, namespace, key))) };
        });
    });

    const unregisterHeal = host.own.register('settings.secrets.heal', () => healSecrets());
    // Синк принял настройки (или запуск): вернуть пропавшие ключи. Без подписчика ключ, стёртый перезаписью `settings.json`, жил бы без копии до перезагрузки.
    const unsubscribeApplied = host.events?.subscribe?.('settings.applied', () => { void healSecrets(); });
    void healSecrets();

    return {
        unregister: () => { unregisterHeal(); unsubscribeApplied?.(); unregisterGet(); unregisterSet(); unregisterRemove(); unregisterKeys(); unregisterSend(); unregisterDeclare(); unregisterNamespaces(); },
    };
}
