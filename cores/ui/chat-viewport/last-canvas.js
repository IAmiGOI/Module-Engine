import { h } from '../tree.js';
import { LAST_CANVAS_STEP, MAX_CANVAS_CSS } from './constants.js';

/** Уровень 3: отдельный канвас под тело последнего сообщения. */
export function installLastCanvas(ctx) {
    const { s, serviceOrThrow, serviceOrNull } = ctx;

    /** Уровень 3: канвас под тело последнего сообщения — своя позиция (transform), свой размер ступенями, своя перерисовка. */
    async function drawLastCanvas(placement) {
        if (!placement) {
            if (s.lastTransformL3 !== 'hidden') {
                await serviceOrNull('dom.setProp', { el: s.lastCanvas, key: 'style', value: { display: 'none' } });
                s.lastTransformL3 = 'hidden';
            }
            return;
        }
        const { physicalSize, cssX, cssY } = placement;
        const wantW = Math.min(MAX_CANVAS_CSS, Math.ceil(physicalSize.width / s.devicePixelRatio));
        const needH = Math.ceil(physicalSize.height / s.devicePixelRatio);
        const stepped = Math.min(MAX_CANVAS_CSS, Math.ceil(needH / LAST_CANVAS_STEP) * LAST_CANVAS_STEP);
        if (wantW !== s.lastCanvasSize.w || needH > s.lastCanvasSize.h || stepped < s.lastCanvasSize.h - 2 * LAST_CANVAS_STEP) {
            s.lastCanvasSize = { w: wantW, h: stepped };
            await serviceOrThrow('webglChat.resize', { canvas: s.lastCanvas, width: Math.round(wantW * s.devicePixelRatio), height: Math.round(stepped * s.devicePixelRatio) });
            await serviceOrThrow('dom.setProp', { el: s.lastCanvas, key: 'style', value: { width: `${wantW}px`, height: `${stepped}px` } });
            s.dirtyLast = true;
        }
        const transform = `translate(${cssX}px, ${Math.round(cssY * 100) / 100}px)`;
        if (transform !== s.lastTransformL3) {
            await serviceOrNull('dom.setProp', { el: s.lastCanvas, key: 'style', value: { display: 'block', transform } });
            s.lastTransformL3 = transform;
        }
        const quad = { textureId: placement.mesid, x: 0, y: 0, width: physicalSize.width, height: physicalSize.height, ...(placement.opacity != null ? { opacity: placement.opacity } : {}) };
        const key = JSON.stringify(quad);
        if (s.dirtyLast || key !== s.lastQuadKeyL3) {
            await serviceOrNull('webglChat.drawFrame', { canvas: s.lastCanvas, quads: [quad] });
            s.lastQuadKeyL3 = key;
            s.dirtyLast = false;
        }
    }

    Object.assign(ctx, { drawLastCanvas });
}
