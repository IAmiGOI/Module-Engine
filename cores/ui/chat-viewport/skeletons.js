import { SKELETON_POOL_MAX } from './constants.js';

/** Заглушки строк, которые ещё грузятся при быстрой прокрутке. */
export function installSkeletons(ctx) {
    const { s, skeletonPool, serviceOrNull } = ctx;

    async function applySkeletons(specs) {
        if (!s.chromeContainer) return;
        while (skeletonPool.length < specs.length && skeletonPool.length < SKELETON_POOL_MAX) {
            const node = await serviceOrNull('dom.createElement', { tag: 'div' });
            if (!node) break;
            await serviceOrNull('dom.setProp', { el: node, key: 'class', value: 'stme-chat-viewport-skeleton' });
            await serviceOrNull('dom.append', { parent: s.chromeContainer, child: node });
            skeletonPool.push(node);
        }
        for (let i = 0; i < skeletonPool.length; i += 1) {
            const spec = specs[i];
            await serviceOrNull('dom.setProp', {
                el: skeletonPool[i], key: 'style',
                value: spec
                    ? { display: 'block', transform: `translateY(${Math.round(spec.top)}px)`, height: `${Math.round(spec.height)}px`, width: `${s.viewportWidth}px` }
                    : { display: 'none' },
            });
        }
    }
    async function clearSkeletons() {
        for (const node of skeletonPool.splice(0)) await serviceOrNull('dom.remove', { node });
    }

    Object.assign(ctx, { applySkeletons, clearSkeletons });
}
