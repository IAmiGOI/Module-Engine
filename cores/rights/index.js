const TIERS = Object.freeze(['official', 'community', 'scanned-safe', 'scanned-unsafe']);

/**
 * Ядро прав / доверия (ARCHITECTURE.md's "Система прав") — the sole source
 * of truth for what a caller (module/core) may do. The caller itself never
 * holds or reports its own rights; only ITS OWN bus's Director consults this
 * registry, looked up by the caller's id, at the moment of a request — never
 * from anything the caller claims about itself. A Gate (libraries/shared/
 * gate.js) is the actual enforcement point on a cross-bus request; this Core
 * only answers "is this allowed" — it never touches a bus itself.
 *
 * `register()`-side protection (a community caller forging an official-
 * sounding contract name) is a SEPARATE mechanism — the namespace-prefix
 * rule in NAMING_PHILOSOPHY.md — not re-implemented here; this Core is only
 * about a caller's own outgoing requests.
 */
export function createRightsCore() {
    const registry = new Map(); // callerId -> { tier, allowedContracts: Set|null, deniedContracts: Set, quarantined }

    /**
     * Registers a caller at a trust tier — `allowedContracts` (community
     * tier, from its decrypted key) or `deniedContracts` (scanned tiers) is
     * whichever the tier actually uses; the other stays empty and unused.
     * Re-registering an id that's already quarantined does NOT lift the
     * quarantine (see ARCHITECTURE.md: permanent, by id/hash, survives a
     * reinstall of the same files) — an explicit choice, not an oversight.
     *
     * `networkAccess` — a SEPARATE grant from `tier`/`allowedContracts`,
     * defaulting to `false` regardless of tier: reaching the internet is a
     * categorically different risk (data can leave the user's machine
     * entirely) from anything else a caller might be allowed — even
     * `official` tier gets no automatic "all network allowed". Checked by
     * the dedicated network Gate (libraries/shared/network-gate.js), never
     * the regular one.
     */
    function register(callerId, { tier, allowedContracts, deniedContracts, networkAccess = false } = {}) {
        if (!TIERS.includes(tier)) throw new Error(`Unknown trust tier "${tier}" for "${callerId}".`);
        const existing = registry.get(callerId);
        registry.set(callerId, {
            tier,
            allowedContracts: allowedContracts ? new Set(allowedContracts) : null,
            deniedContracts: new Set(deniedContracts ?? []),
            networkAccess: Boolean(networkAccess),
            quarantined: Boolean(existing?.quarantined),
        });
    }

    function isQuarantined(callerId) {
        return Boolean(registry.get(callerId)?.quarantined);
    }

    /** Permanent — never lifts, not even by a fresh register() call for the same id (see register()'s own doc comment). */
    function quarantine(callerId) {
        const entry = registry.get(callerId);
        if (entry) entry.quarantined = true;
        else registry.set(callerId, { tier: 'scanned-unsafe', allowedContracts: null, deniedContracts: new Set(), networkAccess: false, quarantined: true });
    }

    /** Network access — a separate grant from checkAccess(), see register()'s own doc comment. Quarantine denies it too, same as everything else. */
    function hasNetworkAccess(callerId) {
        const entry = registry.get(callerId);
        if (!entry || entry.quarantined) return false;
        return entry.networkAccess;
    }

    /**
     * The actual decision — see ARCHITECTURE.md's per-tier policy:
     *  - unknown caller: deny (never registered at all — a forged/stray id).
     *  - quarantined: deny, always, regardless of tier.
     *  - official: allow everything.
     *  - community: allow only what its own decrypted key explicitly lists.
     *  - scanned-safe / scanned-unsafe: default-allow — deny only what the
     *    scan explicitly flagged (see ARCHITECTURE.md's own noted tradeoff:
     *    deliberately softer than deny-by-default).
     */
    function checkAccess(callerId, contract) {
        const entry = registry.get(callerId);
        if (!entry) return { allowed: false, reason: `"${callerId}" is not a registered caller.` };
        if (entry.quarantined) return { allowed: false, reason: `"${callerId}" is quarantined.` };
        if (entry.tier === 'official') return { allowed: true };
        if (entry.tier === 'community') {
            return entry.allowedContracts?.has(contract)
                ? { allowed: true }
                : { allowed: false, reason: `"${callerId}" (community tier) has no declared right to "${contract}".` };
        }
        return entry.deniedContracts.has(contract)
            ? { allowed: false, reason: `"${callerId}" is denied "${contract}" by scan result.` }
            : { allowed: true };
    }

    return { register, isQuarantined, quarantine, checkAccess, hasNetworkAccess };
}
