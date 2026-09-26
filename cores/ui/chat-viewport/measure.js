import { MEASURE_BATCH_MS } from './constants.js';

/** Пакетное измерение зеркал: одна принудительная раскладка на пачку. */
export function installMeasure(ctx) {
    const { s, serviceOrThrow, serviceOrNull } = ctx;

    // Измерения зеркал копятся и выполняются пачкой (`dom.measureRects`): при параллельной подготовке нескольких строк
    // (прелаунч окна, камера предзагрузки) браузер делает ОДНУ принудительную раскладку на пачку вместо одной на строку.

    function measureBatched(el) {
        return new Promise((resolve, reject) => {
            s.measureQueue.push({ el, resolve, reject });
            if (!s.measureTimer) s.measureTimer = setTimeout(flushMeasure, MEASURE_BATCH_MS);
        });
    }
    async function flushMeasure() {
        const queue = s.measureQueue;
        s.measureQueue = [];
        s.measureTimer = null;
        try {
            let rects = await serviceOrNull('dom.measureRects', { els: queue.map(item => item.el) });
            if (!rects) rects = await Promise.all(queue.map(item => serviceOrThrow('dom.measureRect', { el: item.el })));
            queue.forEach((item, i) => item.resolve(rects[i]));
        } catch (error) {
            queue.forEach(item => item.reject(error));
        }
    }

    Object.assign(ctx, { measureBatched, flushMeasure });
}
