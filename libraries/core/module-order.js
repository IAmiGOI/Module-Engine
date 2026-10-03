// @ts-check
import { parseVersion, satisfies } from './semver.js';

/** @typedef {import('./module-types.js').ModuleMeta} ModuleMeta */

/**
 * Порядок загрузки Модулей по `requires` + проверка совместимости с версией движка (RUNTIME.md). Чистая функция.
 * Модуль, которому чего-то не хватает, НЕ роняет остальных: он попадает в `blocked` с причиной, а всё, что от него зависит,
 * блокируется транзитивно.
 *
 * @param {Array<Pick<ModuleMeta, 'id' | 'version' | 'engine' | 'requires'>>} metas
 * @param {{ engineVersion: string, available?: Map<string, string> }} options
 *   `available` — уже существующие НЕ-Модули (Ядра), которые можно требовать: id → версия.
 * @returns {{ order: string[], blocked: Array<{id: string, reason: string}> }}
 */
export function resolveLoadOrder(metas, { engineVersion, available = new Map() }) {
    /** @type {Map<string, Pick<ModuleMeta, 'id' | 'version' | 'engine' | 'requires'>>} */
    const byId = new Map();
    /** @type {Map<string, string>} */
    const blocked = new Map();
    for (const meta of metas) {
        if (byId.has(meta.id)) { blocked.set(meta.id, `duplicate module id "${meta.id}"`); continue; }
        byId.set(meta.id, meta);
    }

    const engine = parseVersion(engineVersion);
    for (const meta of byId.values()) {
        if (!satisfies(engine, meta.engine)) blocked.set(meta.id, `needs engine ${meta.engine}, this is ${engineVersion}`);
    }

    // Транзитивная блокировка: повторяем, пока что-то меняется (графы маленькие).
    let changed = true;
    while (changed) {
        changed = false;
        for (const meta of byId.values()) {
            if (blocked.has(meta.id)) continue;
            for (const req of meta.requires) {
                const dep = byId.get(req.id);
                const depVersion = dep ? dep.version : available.get(req.id);
                let reason = null;
                if (depVersion === undefined) reason = `requires "${req.id}", which is not installed`;
                else if (!satisfies(depVersion, req.range)) reason = `requires "${req.id}" ${req.range}, found ${depVersion}`;
                else if (dep && blocked.has(dep.id)) reason = `requires "${req.id}", which cannot load`;
                if (reason) { blocked.set(meta.id, reason); changed = true; break; }
            }
        }
    }

    // Топосортировка (Kahn) по оставшимся; цикл блокирует все его участники.
    const live = [...byId.values()].filter(meta => !blocked.has(meta.id));
    const pending = new Map(live.map(meta => [meta.id, new Set(meta.requires.map(r => r.id).filter(id => byId.has(id)))]));
    const order = [];
    while (pending.size) {
        const ready = [...pending].filter(([, deps]) => deps.size === 0).map(([id]) => id);
        if (!ready.length) {
            for (const id of pending.keys()) blocked.set(id, 'takes part in a dependency cycle');
            break;
        }
        for (const id of ready) {
            order.push(id);
            pending.delete(id);
            for (const deps of pending.values()) deps.delete(id);
        }
    }

    return { order, blocked: [...blocked].map(([id, reason]) => ({ id, reason })) };
}
