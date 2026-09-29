/**
 * Сервис родного окна Prompt Manager у ST: прячет его и ставит вместо него кнопку «Open Prompt Manager (Module Engine)».
 * Единственное место, знающее разметку ST для этого (`#completion_prompt_manager`, версия ST 1.18+).
 * Разметка меняется между версиями, поэтому если контейнер не найден, сервис честно отвечает `{ found: false }` —
 * ядро Prompt Manager тогда выключается с предупреждением (решение владельца: запасного варианта нет).
 *
 *   stPmUi.install({ handler })  — спрятать родное окно, кнопка зовёт handler; { found }
 *   stPmUi.uninstall()           — вернуть родное окно как было
 */
const CONTAINER_ID = 'completion_prompt_manager';
const BUTTON_ID = 'stme-pm-open';
const STYLE_ID = 'stme-pm-suppress';

export function registerStPmUiService(bus, { document: doc = globalThis.document } = {}) {
    let handler = null;

    function install(params) {
        handler = params?.handler ?? null;
        const container = doc?.getElementById?.(CONTAINER_ID);
        if (!container) return { found: false };
        if (!doc.getElementById(STYLE_ID)) {
            const style = doc.createElement('style');
            style.id = STYLE_ID;
            style.textContent = `#${CONTAINER_ID} > *:not(#${BUTTON_ID}) { display: none !important; }`;
            doc.head.append(style);
        }
        if (!doc.getElementById(BUTTON_ID)) {
            const button = doc.createElement('button');
            button.id = BUTTON_ID;
            button.type = 'button';
            button.className = 'menu_button';
            button.textContent = 'Open Prompt Manager (Module Engine)';
            button.addEventListener('click', () => handler?.());
            container.prepend(button);
        }
        return { found: true };
    }

    function uninstall() {
        doc?.getElementById?.(STYLE_ID)?.remove();
        doc?.getElementById?.(BUTTON_ID)?.remove();
        handler = null;
        return true;
    }

    const unregisters = [bus.register('stPmUi.install', params => install(params)), bus.register('stPmUi.uninstall', () => uninstall())];
    return { install, uninstall, unregister: () => { for (const unregister of unregisters) unregister(); } };
}
