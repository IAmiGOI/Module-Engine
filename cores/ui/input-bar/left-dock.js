import { shouldInterceptTap, shouldCollapseOnOutsideTap } from '../../../libraries/shared/dock-model.js';

const CLASSES = Object.freeze({
    zone: 'stme-left-dock-zone',
    pill: 'stme-left-dock',
    button: 'stme-left-dock-btn',
    touch: 'stme-left-dock-touch',
    open: 'stme-left-dock-open',
});

/**
 * Левый док — такая же выезжающая «пилюля», как правый (`launcher-dock.js`), на уровне нижней строки у ЛЕВОГО края окна и БЕЗ светофора: горизонтальная, выезжает из-за края вправо. Раскрывается ТОЛЬКО от края (узкая зона у края), а не от любого места слева от пилюли набора. Внутри — «Закрыть чат» (самый левый слот) и две
 * родные кнопки ST (меню и расширения), вынесенные из панели набора: переезжают сами узлы (у ST на них висят попапы и обработчики),
 * поэтому всё работает как раньше, а при выключении (`dispose`) узлы возвращаются на место (`buttons.restore`).
 *
 * Выезжает через СТАЦИОНАРНУЮ зону (та же причина, что у правого дока: `:hover` на самой едущей пилюле вибрировал бы). Тач: первое касание
 * раскрывает, второе нажимает кнопку, касание вне сворачивает.
 */
export function createLeftDock({ document: doc = globalThis.document, touch = false, buttons, onCloseChat = () => {} } = {}) {
    const zone = doc.createElement('div');
    zone.className = CLASSES.zone;
    const pill = doc.createElement('div');
    pill.className = CLASSES.pill;
    // Третий слот, САМЫЙ ЛЕВЫЙ, — «Закрыть чат» (раньше пункт в меню ☰; там он теперь спрятан CSS'ом).
    const closeButton = doc.createElement('button');
    closeButton.setAttribute('type', 'button');
    closeButton.className = `${CLASSES.button} stme-left-dock-close`;
    closeButton.setAttribute('title', 'Close chat');
    closeButton.setAttribute('aria-label', 'Close chat');
    const closeIcon = doc.createElement('i');
    closeIcon.className = 'fa-solid fa-xmark fa-fw';
    closeButton.append(closeIcon);
    closeButton.addEventListener('click', () => onCloseChat());
    pill.append(closeButton);
    for (const node of buttons.nodes) {
        node.classList.add(CLASSES.button);
        pill.append(node);
    }
    zone.append(pill);

    const isOpen = () => zone.classList.contains(CLASSES.open);
    const onOutsideTap = event => {
        if (shouldCollapseOnOutsideTap({ touch, open: isOpen(), inside: zone.contains(event.target) })) zone.classList.remove(CLASSES.open);
    };
    if (touch) {
        zone.classList.add(CLASSES.touch);
        // capture: перехватить касание кнопки ДО её собственного обработчика
        pill.addEventListener('click', event => {
            if (!shouldInterceptTap({ touch, open: isOpen() })) return;
            event.stopPropagation();
            event.preventDefault();
            zone.classList.add(CLASSES.open);
        }, true);
        doc.addEventListener('click', onOutsideTap);
    }

    return {
        zone,
        mount: parent => { parent.append(zone); },
        isOpen,
        dispose: () => {
            doc.removeEventListener('click', onOutsideTap);
            for (const node of buttons.nodes) node.classList.remove(CLASSES.button);
            buttons.restore();
            closeButton.remove();
            zone.remove();
        },
    };
}

export { CLASSES as LEFT_DOCK_CLASSES };
