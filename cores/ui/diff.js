import { effect, signal } from './reactive.js';

/**
 * Ядро UI's diffing half, v2 — fine-grained, keyed. Two real fixes over the
 * first cut:
 *
 *  - **No more whole-tree re-diff.** Every node gets its OWN reactive scope
 *    (see mountChild()) — a signal inside ONE child's props re-runs only
 *    that child's own scope, never the parent's, never a sibling's, never a
 *    full-tree re-resolve. A parent's own scope re-runs only for its OWN
 *    props/tag and its OWN direct children's *structural* membership (which
 *    keys exist, in what order) — never because something deeper changed.
 *  - **Children are reconciled by KEY, not position** (mountChildren()) —
 *    reordering a list now emits `insert`/`remove` for genuinely
 *    added/removed keys plus one `reorder` patch with the definitive final
 *    key order, never a cascade of per-position prop/replace patches for
 *    items that only moved. A SURVIVING key never gets torn down and
 *    remounted just because the calling code built a fresh `h()` object for
 *    it (the normal, expected way to write a component) — its raw node is
 *    fed through a small per-key signal (see mountChildren()'s `rawSignal`)
 *    that the key's own mountChild() scope already reactively reads, so an
 *    unchanged prop value between the old and new object is a true no-op,
 *    not a remount. That re-feed reaches the WHOLE subtree, not just the
 *    node's own props: a survived node holds its children in a signal of
 *    its own (mountChild()'s `childrenSignal`) and re-publishes them on
 *    every re-run, so a changed STATIC child — plain text like `${count}
 *    events seen`, not a child signal — is diffed too. Cheap in the common
 *    case: an own-prop-signal re-run re-publishes the very same `children`
 *    array reference, which `set()` drops as a no-op, so only a genuine
 *    re-feed from the parent walks down.
 *
 * Patches address a node by a `path` — an array of `{ key }` markers (never
 * raw numeric indices, since a keyed list's positions aren't stable across
 * a reorder) from the root. A Final UI Core is expected to keep its own
 * key -> real-node map per parent (the same idiom Alpha's own `list()`
 * widget already used for real DOM), so `insert`/`remove`/`reorder` are all
 * cheap, direct lookups on its side, never index arithmetic.
 *
 * REMAINING KNOWN LIMITATION: identity across a list change is only as good
 * as the KEYS the caller provides. An item with no explicit `key` falls
 * back to its position in that render pass — a genuine reorder of UNKEYED
 * items still shows up as remove+insert (losing that item's own local
 * state). Giving list items a real, stable `key` avoids this.
 */

function isSignalValue(value) {
    return typeof value === 'function' && value.isSignal === true;
}

function shallowEqual(a, b) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(k => Object.is(a[k], b[k]));
}

function arraysEqual(a, b) {
    return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * Flattens ONE raw `children` array into an ordered `{ key, raw }` list —
 * reading (and so tracking, from inside mountChildren()'s own effect) any
 * signal used DIRECTLY as a children slot. A signal resolving to an array
 * contributes one entry per item (keyed by the item's own `key` prop, or
 * `${slotIndex}.${itemIndex}` if it has none); a signal resolving to a
 * single value/null contributes at most one entry, keyed by the slot's own
 * position. A non-signal entry is used as-is, keyed by its own `key` prop
 * if present, else its slot position.
 */
function flattenChildren(rawChildren) {
    const entries = [];
    rawChildren.forEach((rawChild, slotIndex) => {
        const value = isSignalValue(rawChild) ? rawChild() : rawChild;
        if (Array.isArray(value)) {
            value.forEach((item, itemIndex) => {
                if (item === null || item === undefined || item === false) return;
                const itemKey = (typeof item === 'object' ? item.props?.key : undefined) ?? `${slotIndex}.${itemIndex}`;
                entries.push({ key: String(itemKey), raw: item });
            });
            return;
        }
        if (value === null || value === undefined || value === false) return;
        const key = (typeof value === 'object' ? value.props?.key : undefined) ?? String(slotIndex);
        entries.push({ key: String(key), raw: value });
    });
    return entries;
}

/**
 * Mounts ONE child at `path` in its own independent reactive scope, reading
 * its current raw node through `rawSignal` (NOT a plain closure value) —
 * that's what lets mountChildren() feed a survived key's freshly-built
 * `h()` object through `.set()` and have this scope reconcile in place
 * (real prop diff) instead of tearing down and rebuilding. A signal inside
 * ITS OWN resolved props re-runs only this scope, never the parent's.
 * `patchType` selects the first patch this scope ever emits ('mount' only
 * for the tree root via render(); 'insert' for anything newly mounted via
 * children reconciliation).
 */
function mountChild(rawSignal, path, onPatch, patchType) {
    let previousShape = null; // 'text' | 'element' | null (null only before the first run)
    let previousTag = null;
    let previousProps = null;
    let disposeChildren = () => {};
    // Дети живут в СВОЁМ сигнале, а не захватываются один раз при монтировании.
    // Без этого пережившая перерисовку нода навсегда оставалась со своими
    // первыми детьми: mountChildren() читал бы массив, снятый в момент
    // монтирования, и новый СТАТИЧЕСКИЙ текст внутри неё (`h('span', {},
    // `${count} events`)`) не появлялся бы никогда — обновлялись бы только
    // дети-сигналы. Найдено на живой панели: список перерисовывался, а текст
    // бейджа рядом — нет.
    let childrenSignal = null;

    const disposeSelf = effect(() => {
        const raw = rawSignal();
        const isText = typeof raw === 'string' || typeof raw === 'number';

        if (isText) {
            const text = String(raw);
            const isFreshMount = previousShape === null;
            const shapeChanged = !isFreshMount && previousShape !== 'text';
            if (isFreshMount || shapeChanged || previousProps?.__text !== text) {
                if (shapeChanged) { disposeChildren(); disposeChildren = () => {}; childrenSignal = null; }
                onPatch({ type: isFreshMount ? patchType : 'replace', path, node: { text } });
            }
            previousShape = 'text';
            previousProps = { __text: text };
            previousTag = null;
            return;
        }

        const { key, ...rest } = raw.props ?? {}; // eslint-disable-line no-unused-vars -- `key` is addressing-only, never a real prop
        void key;
        const resolvedProps = {};
        for (const [propKey, value] of Object.entries(rest)) resolvedProps[propKey] = isSignalValue(value) ? value() : value;

        const isFreshMount = previousShape === null;
        const shapeOrTagChanged = !isFreshMount && (previousShape !== 'element' || previousTag !== raw.tag);
        if (isFreshMount || shapeOrTagChanged) {
            if (shapeOrTagChanged) { disposeChildren(); disposeChildren = () => {}; childrenSignal = null; }
            onPatch({ type: isFreshMount ? patchType : 'replace', path, node: { tag: raw.tag, props: resolvedProps, children: [] } });
        } else if (!shallowEqual(previousProps, resolvedProps)) {
            onPatch({ type: 'setProps', path, props: resolvedProps });
        }
        previousShape = 'element';
        previousTag = raw.tag;
        previousProps = resolvedProps;
        const nextChildren = raw.children ?? [];
        if (childrenSignal === null) {
            childrenSignal = signal(nextChildren);
            disposeChildren = mountChildren(childrenSignal, path, onPatch);
        } else {
            childrenSignal.set(nextChildren); // пережившая нода: дети ПЕРЕЧИТЫВАЮТСЯ, а не остаются теми, что были при монтировании
        }
    });

    return () => { disposeSelf(); disposeChildren(); };
}

/**
 * Reconciles the children of the node at `parentPath` — ONE effect for
 * structural membership (which keys currently exist, in what order),
 * re-running only when a signal used DIRECTLY as a children slot changes
 * (flattenChildren() is what actually reads/tracks those) — never when a
 * grandchild's OWN prop signal changes; that child's own mountChild() scope
 * (set up once per key, left running undisturbed across this effect's
 * re-runs) handles that independently. `childrenSignal` is the parent's own
 * per-node signal (NOT the raw array): the parent re-publishes its children
 * into it on every re-run, which is what lets a survived node pick up a
 * changed static child. A key that survives a reconciliation pass has its
 * raw node pushed through its own small `rawSignal` rather than torn down —
 * see mountChild()'s own doc comment for why.
 */
function mountChildren(childrenSignal, parentPath, onPatch) {
    const mounted = new Map(); // key -> { dispose, rawSignal }
    let previousOrder = [];

    const dispose = effect(() => {
        const entries = flattenChildren(childrenSignal());
        const nextOrder = entries.map(e => e.key);
        const nextByKey = new Map(entries.map(e => [e.key, e.raw]));

        let removedAny = false;
        for (const key of previousOrder) {
            if (nextByKey.has(key)) continue;
            mounted.get(key)?.dispose();
            mounted.delete(key);
            onPatch({ type: 'remove', path: [...parentPath, { key }] });
            removedAny = true;
        }

        let insertedAny = false;
        for (const { key, raw } of entries) {
            const existing = mounted.get(key);
            if (!existing) {
                const rawSignal = signal(raw);
                mounted.set(key, { dispose: mountChild(rawSignal, [...parentPath, { key }], onPatch, 'insert'), rawSignal });
                insertedAny = true;
            } else {
                existing.rawSignal.set(raw); // reconciles in place — a no-op if content is Object.is-equal, else the key's own scope diffs it normally
            }
        }

        const survivorsOldOrder = previousOrder.filter(key => nextByKey.has(key));
        const survivorsNewOrder = nextOrder.filter(key => previousOrder.includes(key));
        if (nextOrder.length > 1 && (removedAny || insertedAny || !arraysEqual(survivorsOldOrder, survivorsNewOrder))) {
            onPatch({ type: 'reorder', path: parentPath, order: nextOrder });
        }
        previousOrder = nextOrder;
    });

    return () => { dispose(); for (const { dispose: disposeOne } of mounted.values()) disposeOne(); };
}

/** Mounts `node` as the tree root, emitting `mount` first, then incremental patches as signals change. Returns a dispose function — no patch is ever emitted again after calling it. */
export function render(node, onPatch) {
    return mountChild(signal(node), [], onPatch, 'mount');
}
