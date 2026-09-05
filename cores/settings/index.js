import { request } from '../../libraries/shared/request.js';
import { readNamespacedValue, writeNamespacedValue, removeNamespacedValue, listNamespacedKeys } from '../../libraries/core/namespaced-store.js';

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
export function createSettingsCore(host) {
    async function readRaw() {
        const result = await request(host.services, 'extensionSettings.read', {});
        if (!result.ok) throw new Error(result.error.message);
        return result.value ?? {};
    }

    async function writeRaw(raw) {
        const result = await request(host.services, 'extensionSettings.write', { params: { raw } });
        if (!result.ok) throw new Error(result.error.message);
    }

    const unregisterGet = host.own.register('storage.settings.get', async params => {
        const { namespace, key } = requireLocation(params);
        const raw = await readRaw();
        return readNamespacedValue(raw, namespace, key, params?.fallback);
    });

    const unregisterSet = host.own.register('storage.settings.set', async params => {
        const { namespace, key } = requireLocation(params);
        const raw = await readRaw();
        writeNamespacedValue(raw, namespace, key, params?.value);
        await writeRaw(raw);
        return true;
    });

    // Only writes back when something was ACTUALLY removed — see
    // cores/memory/index.js's identical discipline and its own doc comment.
    const unregisterRemove = host.own.register('storage.settings.remove', async params => {
        const { namespace, key } = requireLocation(params);
        const raw = await readRaw();
        const removed = removeNamespacedValue(raw, namespace, key);
        if (removed) await writeRaw(raw);
        return removed;
    });

    const unregisterKeys = host.own.register('storage.settings.keys', async params => {
        const namespace = String(params?.namespace ?? '').trim();
        if (!namespace) throw new Error('storage.settings: "namespace" is required.');
        return listNamespacedKeys(await readRaw(), namespace);
    });

    return {
        unregister: () => { unregisterGet(); unregisterSet(); unregisterRemove(); unregisterKeys(); },
    };
}
