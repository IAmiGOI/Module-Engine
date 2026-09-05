/**
 * Abstract UI tree — pure data, no DOM, no platform. A tag/props/children
 * description a Final UI Core (per platform — see CORES.md) eventually
 * applies to a REAL rendering target; this Core never touches one itself
 * (see ARCHITECTURE.md's UI split: primitives here, ready-made widgets in a
 * Library on top, real rendering in a per-platform Service/Final-UI-Core).
 *
 * A prop value or a child MAY be a signal (see reactive.js) — resolving that
 * down to a plain value is diff.js's job, not this file's.
 */
export function h(tag, props, ...children) {
    return {
        tag,
        props: props ?? {},
        children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false),
    };
}
