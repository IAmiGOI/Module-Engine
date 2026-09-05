import { tokenize, parse, run, collectGetKeys, DEFAULT_TIME_LIMIT_MS } from '../../libraries/core/macro-language.js';
import { createPersistedList } from '../../libraries/core/persisted-list.js';
import { request } from '../../libraries/shared/request.js';

const PERSISTENCE_NAMESPACE = 'core.macros';

function requireProgram(programs, programId) {
    const program = programs.get(programId);
    if (!program) throw new Error(`macros: unknown program "${programId}".`);
    return program;
}

/**
 * Ядро исполнения макросов (CORES.md) — a real `{{macro}}` in ST resolves
 * either a user-authored program (`kind: 'text'` — a fixed string; `kind:
 * 'code'` — a small program in [macro-language.js](../../libraries/core/macro-language.js))
 * or an externally-registered VALUE macro (`setValueMacro()` — this is what
 * Ядро трекинга's `onUserFieldRegistered` hook was built to call, closing
 * the loop CORES.md/the user's own tracking spec left as a stub).
 *
 * **Sync resolution vs. async backing store.** ST calls a registered macro's
 * `handler()` directly and SYNCHRONOUSLY whenever it parses `{{name}}`
 * anywhere (a prompt, World Info, a character card) — there is no room for
 * an async round-trip at that exact moment. So every macro name registers
 * ONE handler, ONCE, that just returns `cachedResults.get(name)` — a plain
 * Map lookup. Keeping that cache fresh is THIS Ядро's job, on its own
 * schedule: `setValueMacro()` updates it immediately (a value push, no
 * computation needed); a `code` program's cache entry is refreshed by
 * `runProgram()`, run once immediately when configured and again on every
 * one of its own `triggers` (same event-driven refresh model as Ядро
 * трекинга — deliberately, since it's the same underlying problem: an
 * async source feeding a value that must be readable synchronously later).
 * A program that errors still gets a `[macro error: name]` placeholder
 * cached and registered — same resilience Alpha's own macros had: a macro
 * never just vanishes from a prompt.
 *
 * **`get`/`save` inside a `code` program**: the language interpreter itself
 * stays fully synchronous (see macro-language.js) — this Ядро pre-fetches
 * every `get "..."` key the program could need (via `collectGetKeys()`)
 * BEFORE calling `run()`, and flushes every `save()` call AFTER. A colon in
 * the key (`"trackerId:fieldName"`) reads `tracking.value` — the only cross-
 * Ядро source wired for v1 (CORES.md/ARCHITECTURE.md: more can follow the
 * same shape later, e.g. `storage.settings` or lorebook entries, without
 * changing the language itself). A bareword key (no colon) is this
 * program's own persisted state, in `storage.chatMemory` under its own
 * `macro.<programId>` namespace — chosen deliberately over Alpha's
 * in-memory-only equivalent, since Ядро внутренней памяти чата already
 * exists and a macro's own counter surviving a reload is strictly better.
 * A failed `get` (e.g. an unknown tracker) resolves to `undefined`, never
 * throws — same defensive read Alpha's own bus `get` always was.
 *
 * Registers `macros.run`/`macros.value` on the Шина ядер; the real ST
 * registration is a thin Сервис
 * ([services/st-macros.js](../../services/st-macros.js)), reached through
 * the regular Гейт via `host.services` like every other Сервис.
 */
export function createMacrosCore(host) {
    let programs = new Map(); // id -> config
    const cachedResults = new Map(); // macroName -> last resolved string
    const registeredNames = new Set(); // macroName -> currently registered with real ST
    const triggerUnsubscribers = new Map(); // programId -> [unsubscribe...]

    async function ensureMacroRegistered(name) {
        if (registeredNames.has(name)) return;
        const result = await request(host.services, 'stMacros.register', { params: { name, handler: () => cachedResults.get(name) ?? '' } });
        if (!result.ok) throw new Error(result.error.message);
        registeredNames.add(name);
    }

    async function unregisterMacroName(name) {
        if (!registeredNames.has(name)) return;
        registeredNames.delete(name);
        cachedResults.delete(name);
        const result = await request(host.services, 'stMacros.unregister', { params: { name } });
        if (!result.ok) throw new Error(result.error.message);
    }

    async function resolveGetKey(programId, key) {
        const colon = key.indexOf(':');
        if (colon < 0) {
            const result = await request(host.own, 'storage.chatMemory.get', { params: { namespace: `macro.${programId}`, key } });
            return result.ok ? result.value : undefined;
        }
        const result = await request(host.own, 'tracking.value', { params: { trackerId: key.slice(0, colon), fieldName: key.slice(colon + 1) } });
        return result.ok ? result.value : undefined;
    }

    /** Refreshes ONE program's cached value — see this file's own top doc-comment for the full pre-fetch/run/flush dance. Throws on a syntax/runtime error (after still caching+registering a "[macro error]" placeholder), matching every other Ядро's error-envelope convention. */
    async function runProgram(programId) {
        const program = requireProgram(programs, programId);

        if (program.kind !== 'code') {
            const value = String(program.source ?? '');
            cachedResults.set(program.macroName, value);
            await ensureMacroRegistered(program.macroName);
            return value;
        }

        let ast;
        try { ast = parse(tokenize(program.source)); }
        catch (error) {
            cachedResults.set(program.macroName, `[macro error: ${program.name || program.macroName}]`);
            await ensureMacroRegistered(program.macroName);
            throw error;
        }

        const resolved = {};
        for (const key of collectGetKeys(ast)) resolved[key] = await resolveGetKey(program.id, key);

        const saves = [];
        let value;
        try {
            value = run(ast, { get: key => resolved[key], save: (key, savedValue) => saves.push({ key, value: savedValue }), timeLimitMs: DEFAULT_TIME_LIMIT_MS });
        } catch (error) {
            cachedResults.set(program.macroName, `[macro error: ${program.name || program.macroName}]`);
            await ensureMacroRegistered(program.macroName);
            throw error;
        }

        for (const { key, value: savedValue } of saves) {
            await request(host.own, 'storage.chatMemory.set', { params: { namespace: `macro.${program.id}`, key, value: savedValue } });
        }
        cachedResults.set(program.macroName, value);
        await ensureMacroRegistered(program.macroName);
        return value;
    }

    /** Adopts a program set into memory — re-subscribes every trigger fresh and runs each program once immediately, so a macro's cache is never stale-empty right after (re)configuration. The persisting `configurePrograms()` below is this PLUS a real `storage.settings` write (see persisted-list.js). */
    function applyPrograms(list) {
        for (const unsubscribers of triggerUnsubscribers.values()) for (const unsubscribe of unsubscribers) unsubscribe();
        triggerUnsubscribers.clear();

        const next = new Map((list ?? []).map(program => [program.id, program]));
        for (const [id, program] of programs) {
            if (!next.has(id)) unregisterMacroName(program.macroName).catch(() => {});
        }
        programs = next;

        for (const program of programs.values()) {
            triggerUnsubscribers.set(program.id, (program.triggers ?? []).map(eventName =>
                host.events.subscribe(eventName, () => { runProgram(program.id).catch(() => {}); })));
            runProgram(program.id).catch(() => {});
        }
    }

    const persisted = createPersistedList(host, { namespace: PERSISTENCE_NAMESPACE, key: 'programs', apply: applyPrograms });
    const configurePrograms = persisted.save;
    const restorePrograms = persisted.restore;

    /** The bridge Ядро трекинга's `onUserFieldRegistered` hook calls — a plain value, immediately cached and registered with real ST, no program/language involved at all. */
    async function setValueMacro(name, value) {
        cachedResults.set(name, String(value ?? ''));
        await ensureMacroRegistered(name);
    }

    function clearValueMacro(name) {
        unregisterMacroName(name).catch(() => {});
    }

    const unregisterRun = host.own.register('macros.run', params => runProgram(params?.programId));
    const unregisterValue = host.own.register('macros.value', params => {
        if (!cachedResults.has(params?.name)) throw new Error(`macros: unknown macro "${params?.name}".`);
        return cachedResults.get(params.name);
    });

    return {
        configurePrograms,
        restorePrograms,
        setValueMacro,
        clearValueMacro,
        unregister: () => {
            for (const unsubscribers of triggerUnsubscribers.values()) for (const unsubscribe of unsubscribers) unsubscribe();
            unregisterRun(); unregisterValue();
        },
    };
}
