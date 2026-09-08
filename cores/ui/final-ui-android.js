import { request } from '../../libraries/shared/request.js';

/**
 * Ядро финального UI для Android — the second platform adapter over diff.js's
 * patch stream (CORES.md: "тот же поток патчей, применённый по-другому").
 *
 * Что «по-другому» по сравнению с PC (cores/ui/final-ui-pc.js):
 *
 *  1. **Корень помечается классом `stme-android`.** Вся платформенная
 *     разница РИСУЕТСЯ CSS'ом (panel.css): уже паддинги, мельче шрифт,
 *     кнопки во всю ширину строк — одно дерево на всех платформах, а не
 *     две версии разметки, которые пришлось бы чинить по отдельности.
 *     Мерж классов, а не перезапись: модуль мог дать корню собственный
 *     класс до нас.
 *  2. **Атрибут `data-platform="android"`** — для CSS-селекторов, которым
 *     нужно отличать платформу не по классу, а по атрибуту, и для отладки.
 *
 * Всё остальное — дословно та же механика: каждый DOM-примитив через Гейт
 * (`host.services` → `dom.*`), патчи применяются строго по одному через
 * очередь (см. doc-comment final-ui-pc.js — почему нельзя параллельно).
 * Отдельная копия, а не параметр поверх PC-ядра: CORES.md держит патч-
 * апплаеры генуинно раздельными, чтобы платформенные различия не превратились
 * со временем в гору `if (platform)` внутри одного файла.
 */
export function createFinalUiAndroid(host) {
    const nodes = new Map(); // serialized path -> whatever the DOM Сервис returned for it
    let root = null;
    let queue = Promise.resolve();

    function pathKey(path) {
        return path.map(seg => seg.key).join('/');
    }

    async function callDom(contract, params) {
        const result = await request(host.services, contract, { params });
        if (!result.ok) throw new Error(`Ядро финального UI для Android: "${contract}" was refused — ${result.error?.message}`);
        return result.value;
    }

    async function build(node) {
        if ('text' in node) return callDom('dom.createTextNode', { text: node.text });
        const real = await callDom('dom.createElement', { tag: node.tag });
        for (const [propKey, value] of Object.entries(node.props ?? {})) {
            await callDom('dom.setProp', { el: real, key: propKey, value });
        }
        // Платформенная пометка — ПОСЛЕ props узла, чтобы перебить его class,
        // но МЕРЖЕМ со своим классом, а не затираем чужой.
        if (!('text' in node)) {
            const finalClass = `${String(node.props?.class ?? '')} stme-android`.trim();
            await callDom('dom.setProp', { el: real, key: 'class', value: finalClass });
            await callDom('dom.setProp', { el: real, key: 'data-platform', value: 'android' });
        }
        real.__lastProps = node.props ?? {};
        return real;
    }

    /** Drops this path AND every nested path under it — см. final-ui-pc.js, зачем. */
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
            // Платформенная пометка переживает любые обновления props — её
            // переписываем после каждого setProps так же, как при build().
            await callDom('dom.setProp', { el: real, key: 'class', value: `${String(patch.props.class ?? '')} stme-android`.trim() });
            await callDom('dom.setProp', { el: real, key: 'data-platform', value: 'android' });
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

        throw new Error(`createFinalUiAndroid(): unrecognized patch type "${patch.type}".`);
    }

    function apply(patch) {
        queue = queue.then(() => applyOne(patch));
        return queue;
    }

    return {
        apply,
        getRoot: () => root,
        getNode: path => nodes.get(pathKey(path)),
        /** Resolves once every queued patch so far has actually finished — см. final-ui-pc.js. */
        settled: () => queue,
    };
}

/**
 * Выбор финального UI по платформе — единственное место, где проводка знает
 * о платформах. Проверка НЕ «Android ли это вообще» (планшет не телефон), а
 * «мобильная ли поверхность»: узкий экран, при котором основной меню-экран
 * движка обязан сужаться. Desktop-браузеры с узким окном получают ту же
 * компактную вёрстку — она от этого только выигрывает.
 */
export function isMobileSurface(nav = typeof navigator !== 'undefined' ? navigator : undefined) {
    if (!nav) return false;
    return Boolean(
        /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent ?? '')
        || (typeof nav.maxTouchPoints === 'number' && nav.maxTouchPoints > 1 && Math.min(globalThis.innerWidth ?? 1024, globalThis.innerHeight ?? 768) < 700),
    );
}
