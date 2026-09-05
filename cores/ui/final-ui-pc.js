import { request } from '../../libraries/shared/request.js';

/**
 * Ядро финального UI для PC — applies diff.js's patch stream to a real
 * output. One of several platform-specific "apply this same patch stream
 * differently" adapters (CORES.md lists Android/iOS as the same idea, not
 * yet built).
 *
 * Every real DOM touch goes through `host.services` (a Gate-checked
 * accessor from engine.js's `registerCaller()`) to `dom.*` contracts
 * (services/dom.js) — no exception, even though DOM has structurally one
 * real supplier per platform (see ARCHITECTURE.md's own note: trivial
 * resolving never excuses skipping the rights check).
 *
 * `apply()` is async now (every DOM primitive is a Гейт-checked round
 * trip) — patches are queued and processed strictly ONE AT A TIME
 * (`#queue` below), never concurrently: diff.js's own `onPatch()` calls are
 * synchronous and don't await this Core's own async work, so without a
 * queue a later patch's DOM calls could race ahead of an earlier patch's
 * still-in-flight ones (e.g. appending to a parent before that parent's
 * own creation has actually resolved).
 */
export function createFinalUiPc(host) {
    const nodes = new Map(); // serialized path -> whatever the DOM Сервис returned for it
    let root = null;
    let queue = Promise.resolve();

    function pathKey(path) {
        return path.map(seg => seg.key).join('/');
    }

    async function callDom(contract, params) {
        const result = await request(host.services, contract, { params });
        if (!result.ok) throw new Error(`Ядро финального UI для PC: "${contract}" was refused — ${result.error?.message}`);
        return result.value;
    }

    async function build(node) {
        if ('text' in node) return callDom('dom.createTextNode', { text: node.text });
        const real = await callDom('dom.createElement', { tag: node.tag });
        for (const [propKey, value] of Object.entries(node.props ?? {})) await callDom('dom.setProp', { el: real, key: propKey, value });
        real.__lastProps = node.props ?? {};
        return real;
    }

    /** Drops this path AND every nested path under it from the map — used wherever a subtree is torn down (remove, or the old side of a replace), so a stale entry can never be looked up again. */
    function forgetSubtree(key) {
        for (const k of [...nodes.keys()]) {
            if (k === key || k.startsWith(`${key}/`)) nodes.delete(k);
        }
    }

    async function applyOne(patch) {
        const key = pathKey(patch.path);

        if (patch.type === 'mount') {
            root = await build(patch.node);
            nodes.set(key, root);
            return;
        }

        if (patch.type === 'insert') {
            const real = await build(patch.node);
            nodes.set(key, real);
            const parent = nodes.get(pathKey(patch.path.slice(0, -1)));
            if (parent) await callDom('dom.append', { parent, child: real });
            return;
        }

        if (patch.type === 'replace') {
            const old = nodes.get(key);
            forgetSubtree(key);
            const real = await build(patch.node);
            if (old) await callDom('dom.replaceWith', { oldNode: old, newNode: real });
            nodes.set(key, real);
            return;
        }

        if (patch.type === 'remove') {
            const real = nodes.get(key);
            if (real) await callDom('dom.remove', { node: real });
            forgetSubtree(key);
            return;
        }

        if (patch.type === 'setProps') {
            const real = nodes.get(key);
            if (!real) return;
            const oldProps = real.__lastProps ?? {};
            for (const propKey of Object.keys(oldProps)) {
                if (!(propKey in patch.props)) await callDom('dom.removeProp', { el: real, key: propKey });
            }
            for (const [propKey, value] of Object.entries(patch.props)) {
                if (!Object.is(oldProps[propKey], value)) await callDom('dom.setProp', { el: real, key: propKey, value });
            }
            real.__lastProps = patch.props;
            return;
        }

        if (patch.type === 'reorder') {
            const parent = nodes.get(key);
            if (!parent) return;
            for (const childKey of patch.order) {
                const child = nodes.get(key ? `${key}/${childKey}` : childKey);
                if (child) await callDom('dom.append', { parent, child }); // re-appending an existing child moves it to the end, in the given order
            }
            return;
        }

        throw new Error(`createFinalUiPc(): unrecognized patch type "${patch.type}".`);
    }

    function apply(patch) {
        queue = queue.then(() => applyOne(patch));
        return queue;
    }

    return {
        apply,
        getRoot: () => root,
        getNode: path => nodes.get(pathKey(path)),
        /** Resolves once every queued patch so far has actually finished applying — mainly for tests; production code never needs to await patches individually, diff.js already calls apply() in the right order. */
        settled: () => queue,
    };
}
