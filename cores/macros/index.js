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

    /**
     * Computes what `program` resolves to RIGHT NOW — the pure pre-fetch/run
     * step shared by `runProgram()` (a REAL refresh: flushes `save()`s,
     * updates the cache, registers with real ST) and `testProgram()` below (a
     * PREVIEW: reads real current values so the result is honest, but touches
     * nothing persisted). Never throws — `{ok:false, error}` on a syntax/
     * runtime error, same envelope shape every other Ядро uses.
     */
    async function computeProgramValue(program) {
        if (program.kind !== 'code') return { ok: true, value: String(program.source ?? ''), saves: [] };

        let ast;
        try { ast = parse(tokenize(program.source)); }
        catch (error) { return { ok: false, error }; }

        const resolved = {};
        for (const key of collectGetKeys(ast)) resolved[key] = await resolveGetKey(program.id, key);

        const saves = [];
        try {
            const value = run(ast, { get: key => resolved[key], save: (key, savedValue) => saves.push({ key, value: savedValue }), timeLimitMs: DEFAULT_TIME_LIMIT_MS });
            return { ok: true, value, saves };
        } catch (error) {
            return { ok: false, error };
        }
    }

    /** Refreshes ONE program's cached value — see this file's own top doc-comment for the full pre-fetch/run/flush dance. Throws on a syntax/runtime error (after still caching+registering a "[macro error]" placeholder), matching every other Ядро's error-envelope convention. */
    async function runProgram(programId) {
        const program = requireProgram(programs, programId);
        const result = await computeProgramValue(program);

        if (!result.ok) {
            cachedResults.set(program.macroName, `[macro error: ${program.name || program.macroName}]`);
            await ensureMacroRegistered(program.macroName);
            throw result.error;
        }

        for (const { key, value: savedValue } of result.saves ?? []) {
            await request(host.own, 'storage.chatMemory.set', { params: { namespace: `macro.${program.id}`, key, value: savedValue } });
        }
        cachedResults.set(program.macroName, result.value);
        await ensureMacroRegistered(program.macroName);
        return result.value;
    }

    /**
     * "Test run" for the UI — computes a DRAFT program's value (not
     * necessarily saved yet, may not even have a real `id`) against REAL
     * current `get` values, so the preview is honest, but never flushes its
     * `save()`s and never touches `cachedResults`/registers anything with
     * real ST: iterating on a macro before saving must not have side effects
     * a user did not ask for.
     */
    async function testProgram(draft) {
        const program = { id: draft?.id || 'draft', name: draft?.name ?? '', macroName: draft?.macroName ?? '', kind: draft?.kind === 'code' ? 'code' : 'text', source: draft?.source ?? '' };
        const result = await computeProgramValue(program);
        return result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error.message };
    }

    /**
     * Adopts a program set into memory — re-subscribes every trigger fresh and
     * runs each program once immediately, so a macro's cache is never
     * stale-empty right after (re)configuration. The persisting
     * `configurePrograms()` below is this PLUS a real `storage.settings`
     * write (see persisted-list.js).
     *
     * **Triggers go through the Director, same as Ядро трекинга's own —
     * `host.own.subscribe('macros.run', { params, when }, cb)`, not a bare
     * `host.events.subscribe(eventName, cb)`.** `when` accepts everything the
     * Director already understands (`{event}`, `{event, every}`,
     * `{every:{ms}}`) — a macro gets "every N replies"/"every N minutes" for
     * free, the same choices a tracker has, via the same shared
     * [trigger-modes.js](../../libraries/core/trigger-modes.js) the UI picks
     * from. A saved program with the OLD bare-string-event shape
     * (`triggers: ['generation.completed']`) still works — `typeof trigger
     * === 'string'` normalizes it to `{event: trigger}` before it reaches the
     * Director, exactly like Ядро трекинга already does for its own.
     */
    function applyPrograms(list) {
        for (const unsubscribers of triggerUnsubscribers.values()) for (const unsubscribe of unsubscribers) unsubscribe();
        triggerUnsubscribers.clear();

        const next = new Map((list ?? []).map(program => [program.id, program]));
        for (const [id, program] of programs) {
            if (!next.has(id)) unregisterMacroName(program.macroName).catch(() => {});
        }
        programs = next;

        for (const program of programs.values()) {
            // Выключенный макрос — как удалённый для настоящей ST (не
            // зарегистрирован, {{name}} не резолвится), но конфигурация
            // остаётся: включить обратно можно без пересоздания программы.
            if (program.enabled === false) { unregisterMacroName(program.macroName).catch(() => {}); continue; }
            triggerUnsubscribers.set(program.id, (program.triggers ?? []).map(trigger =>
                host.own.subscribe('macros.run', {
                    params: { programId: program.id },
                    when: typeof trigger === 'string' ? { event: trigger } : trigger,
                }, () => {})));
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
    // Contracts on the Шина ядер — the earlier v1 shape only exposed
    // `configurePrograms`/`restorePrograms` as plain JS functions on the
    // object this factory returns, reachable ONLY by whoever directly holds
    // that reference (the engine assembler). A real UI Ядро (the macros
    // panel) can only ever reach another Ядро through the Гейт Ядро↔Ядро —
    // it never gets a JS reference at all — so without these, no UI could
    // ever list/save a program. Same shape as `tracking.trackers`/`tracking.
    // configure`.
    const unregisterPrograms = host.own.register('macros.programs', () => [...programs.values()].map(program => ({ ...program })));
    const unregisterConfigure = host.own.register('macros.configure', params => configurePrograms(params?.programs ?? []));
    // Draft preview — see `testProgram()`'s own doc-comment for why it never
    // touches `cachedResults`/real ST registration.
    const unregisterTest = host.own.register('macros.test', params => testProgram(params?.program));
    // Same gap as configurePrograms/restorePrograms above, for the OTHER
    // half of this Ядро's public surface: `setValueMacro`/`clearValueMacro`
    // were plain JS functions, reachable only by whoever holds a direct
    // reference (until now, only the engine assembler's own Ядро трекинга
    // hook). Ядро работы с WI needs the SAME "publish a value as a real
    // {{macro}}" primitive for its own "Publish" toggle — reachable only
    // through the Гейт Ядро↔Ядро, never a JS reference.
    const unregisterSetValue = host.own.register('macros.setValue', params => setValueMacro(params?.name, params?.value));
    const unregisterClearValue = host.own.register('macros.clearValue', params => { clearValueMacro(params?.name); return true; });

    return {
        configurePrograms,
        restorePrograms,
        setValueMacro,
        clearValueMacro,
        unregister: () => {
            for (const unsubscribers of triggerUnsubscribers.values()) for (const unsubscribe of unsubscribers) unsubscribe();
            unregisterRun(); unregisterValue(); unregisterPrograms(); unregisterConfigure(); unregisterTest();
            unregisterSetValue(); unregisterClearValue();
        },
    };
}
