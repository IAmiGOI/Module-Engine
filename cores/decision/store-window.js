import { normalizeBoundary, normalizeWindow } from '../../libraries/core/decision-window.js';

/**
 * Плавающее окно, замороженная история и граница окна в памяти чата.
 * Вынесено из `store.js`, чтобы файл хранилища оставался ≤ 300 строк.
 * Записи окна и сводки только дописываются; граница меняется при
 * переключении окна.
 */
export function createWindowStore({ enqueue, call, namespace }) {
    let window = normalizeWindow(null);
    let frozen = [];
    let boundary = null;

    function saveWindow(next) {
        return enqueue(async () => {
            window = normalizeWindow(next);
            await call('storage.chatMemory.set', { namespace, key: 'window', value: window });
            return window;
        });
    }

    function saveFrozen(next) {
        return enqueue(async () => {
            frozen = (Array.isArray(next) ? next : []).filter(record => record && typeof record === 'object' && String(record.text ?? '').trim());
            await call('storage.chatMemory.set', { namespace, key: 'frozenWindows', value: frozen });
            return frozen;
        });
    }

    function saveBoundary(next) {
        return enqueue(async () => {
            boundary = normalizeBoundary(next);
            await call('storage.chatMemory.set', { namespace, key: 'windowBoundary', value: boundary });
            return boundary;
        });
    }

    return {
        window: () => normalizeWindow(window),
        saveWindow,
        frozen: () => frozen.map(record => ({ ...record })),
        saveFrozen,
        boundary: () => normalizeBoundary(boundary),
        saveBoundary,
        load: data => {
            window = normalizeWindow(data?.window);
            frozen = (Array.isArray(data?.frozenWindows) ? data.frozenWindows : [])
                .filter(record => record && typeof record === 'object' && String(record.text ?? '').trim());
            boundary = normalizeBoundary(data?.windowBoundary);
        },
    };
}
