/**
 * Плагины Prompt Manager с горячей заменой (PROMPT_MANAGER_PLAN.md, раздел 0 «Плагины»). Плагин объявляет, что он даёт:
 *   { id, name, version?, provides: { conditions: { тип: (правило, facts) => boolean },
 *                                     macros: { имя: () => строка },
 *                                     transform: (messages, info) => messages } }
 * Реестр меняется на лету (register/unregister — без перезагрузки): сборка каждый раз берёт актуальное. Плагин видит то же, что PM
 * (facts, сообщения), но не пишет в состояние PM. Любая ошибка плагина выключает ЭТОТ плагин (не PM) и попадает в `errors`.
 */
export function createPluginRegistry({ onDisable = () => {} } = {}) {
    const plugins = new Map(); // id -> { plugin, enabled, error }

    function guard(entry, work, fallback) {
        try { return work(); } catch (error) {
            entry.enabled = false;
            entry.error = error?.message ?? String(error);
            onDisable({ id: entry.plugin.id, error: entry.error });
            return fallback;
        }
    }

    function register(plugin) {
        const id = String(plugin?.id ?? '').trim();
        if (!id) throw new Error('promptManager.plugins: plugin "id" is required.');
        if (!plugin.provides || typeof plugin.provides !== 'object') throw new Error(`promptManager.plugins: plugin "${id}" provides nothing.`);
        plugins.set(id, { plugin: { ...plugin, id }, enabled: true, error: null });
        return id;
    }

    const active = () => [...plugins.values()].filter(entry => entry.enabled);

    return {
        register,
        unregister: id => plugins.delete(id),
        setEnabled(id, enabled) { const entry = plugins.get(id); if (!entry) return false; entry.enabled = Boolean(enabled); if (enabled) entry.error = null; return true; },
        list: () => [...plugins.values()].map(({ plugin, enabled, error }) => ({ id: plugin.id, name: plugin.name ?? plugin.id, version: plugin.version ?? '', enabled, error, provides: Object.keys(plugin.provides) })),
        /** Типы условий от плагинов: { тип: (правило, facts) => boolean } — вызовы защищены. */
        conditions() {
            const map = {};
            for (const entry of active()) {
                for (const [type, fn] of Object.entries(entry.plugin.provides.conditions ?? {})) {
                    map[type] = (leaf, facts) => (entry.enabled ? guard(entry, () => fn(leaf, facts), false) : false);
                }
            }
            return map;
        },
        conditionTypes: () => active().flatMap(entry => Object.keys(entry.plugin.provides.conditions ?? {})),
        /** Макросы плагинов: { имя: () => строка }. Упавший макрос даёт пустую строку. */
        macros() {
            const map = {};
            for (const entry of active()) {
                for (const [name, fn] of Object.entries(entry.plugin.provides.macros ?? {})) map[name] = () => (entry.enabled ? guard(entry, () => String(fn()), '') : '');
            }
            return map;
        },
        /** Цепочка преобразований сообщений; упавший плагин пропускается, остальные работают. */
        transform(messages, info) {
            let out = messages;
            for (const entry of active()) {
                const fn = entry.plugin.provides.transform;
                if (typeof fn !== 'function') continue;
                const next = guard(entry, () => fn(out, info), null);
                if (Array.isArray(next)) out = next;
            }
            return out;
        },
    };
}
