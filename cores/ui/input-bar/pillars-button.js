/**
 * Кнопка «Пять столпов» — отдельный круг рядом с колесиком контекста у строки
 * ввода (задание: меню открывается из UI рядом с кругом контекста). Тем же
 * приёмом, что и само колесико: обычный DOM, позиция — по колонке сообщений.
 */
export const PILLARS_SIZE = 46;
export const PILLARS_GAP = 8;

export function createPillarsButton({ document: doc = globalThis.document, onOpen = () => {} } = {}) {
    const root = doc.createElement('button');
    root.className = 'stme-pillars-launch';
    root.setAttribute('type', 'button');
    root.setAttribute('aria-label', 'The five pillars');
    root.setAttribute('title', 'The five pillars — the Court, the Bank, the World, the Charter, the Canon');
    const dot = doc.createElement('span');
    dot.className = 'stme-pillars-launch-mark';
    root.append(dot);
    root.addEventListener('click', () => onOpen());
    return {
        root,
        mount: parent => parent.append(root),
        /** Круг — сразу справа от колесика контекста, по его нижней линии. */
        place: ({ right, bottom = 9 }) => {
            root.style.left = `${right + PILLARS_GAP}px`;
            root.style.bottom = `${bottom}px`;
        },
        dispose: () => root.remove(),
    };
}
