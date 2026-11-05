import { clampToViewport } from '../../../libraries/shared/draggable.js';

/** Размер окна по умолчанию и его сохранение — вынесено из панели, чтобы та оставалась проводкой. */
export const DEFAULT_SIZE = Object.freeze({ width: 560, height: 720 });

export function defaultPosition(currentSize) {
    const viewportWidth = globalThis.innerWidth ?? 1920;
    return { left: Math.max(16, viewportWidth - currentSize.width - 24), top: 60 };
}

export async function savePanelWindow({ call, namespace, key, state }) {
    await call('storage.settings.set', {
        namespace, key,
        value: {
            visible: state.visible.peek(), collapsed: state.collapsed.peek(),
            position: state.position.peek(), size: state.size.peek(),
        },
    });
}

export async function loadPanelWindow({ call, namespace, key, state }) {
    const result = await call('storage.settings.get', { namespace, key, fallback: {} });
    const saved = (result.ok ? result.value : null) ?? {};
    state.visible.set(Boolean(saved.visible));
    state.collapsed.set(Boolean(saved.collapsed));
    const savedSize = saved.size ?? {};
    const viewport = { viewportWidth: globalThis.innerWidth ?? 1920, viewportHeight: globalThis.innerHeight ?? 1080 };
    state.size.set({
        width: Math.min(savedSize.width > 0 ? savedSize.width : DEFAULT_SIZE.width, viewport.viewportWidth - 16),
        height: Math.min(savedSize.height > 0 ? savedSize.height : DEFAULT_SIZE.height, viewport.viewportHeight - 32),
    });
    state.position.set(saved.position?.left === undefined
        ? clampToViewport(defaultPosition(state.size.peek()), { ...state.size.peek(), ...viewport })
        : clampToViewport(saved.position, { ...state.size.peek(), ...viewport }));
}
