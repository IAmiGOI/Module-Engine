import { TEXT_PADDING } from './constants.js';

/** Картинки тела — настоящий DOM поверх канваса. */
export function installBodyImages(ctx) {
    const { chromeRoots, bodyImages, imageLayers, serviceOrThrow, serviceOrNull } = ctx;

    function escapeAttr(value) {
        return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

    /** Картинки тела — настоящий DOM в хроме строки, под тем же смещением, что и квад тела (`TEXT_PADDING`, `chromeHeight`). */
    async function syncBodyImages(mesid, chromeHeight) {
        const root = chromeRoots.get(mesid);
        if (!root) return;
        const images = bodyImages.get(mesid) ?? [];
        let entry = imageLayers.get(mesid);
        if (entry && (entry.root !== root || images.length === 0)) {
            await serviceOrNull('dom.remove', { node: entry.layer });
            imageLayers.delete(mesid);
            entry = null;
        }
        if (images.length === 0) return;
        if (!entry) {
            const layer = await serviceOrThrow('dom.createElement', { tag: 'div' });
            await serviceOrThrow('dom.setProp', { el: layer, key: 'class', value: 'stme-chat-viewport-body-images' });
            await serviceOrThrow('dom.setProp', { el: layer, key: 'style', value: { position: 'absolute', left: `${TEXT_PADDING}px`, top: `${chromeHeight}px`, width: '0px', height: '0px', pointerEvents: 'none', contain: 'layout style' } });
            await serviceOrThrow('dom.append', { parent: root, child: layer });
            entry = { layer, root, key: null };
            imageLayers.set(mesid, entry);
        }
        const key = JSON.stringify(images.map(i => [i.src, i.x, i.y, i.width, i.height]));
        if (entry.key !== key) {
            const html = images.map(i => `<img src="${ctx.escapeAttr(i.src)}" alt="" style="position:absolute;left:${i.x}px;top:${i.y}px;width:${i.width}px;height:${i.height}px;">`).join('');
            await serviceOrThrow('dom.setInnerHtml', { el: entry.layer, html });
            entry.key = key;
        }
        await serviceOrThrow('dom.setProp', { el: entry.layer, key: 'style', value: { top: `${chromeHeight}px` } });
    }

    Object.assign(ctx, { escapeAttr, syncBodyImages });
}
