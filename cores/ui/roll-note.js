import { request } from '../../libraries/shared/request.js';
import { createUiMountRegistry } from '../../libraries/shared/ui-mount-registry.js';
import { h } from './tree.js';

/**
 * Строка броска над сообщением — отдельное Ядро по образцу подвала
 * (`message-footer.js`), но с одним назначением: показать броски хода, когда
 * игрок выбрал «Show rolls: In the chat».
 *
 * **Модель этого не видит.** Строку не пишет писатель: она собирается из
 * записи хода (`decision.messageRolls`) и живёт только в DOM, над текстом
 * сообщения. Поэтому регенерация не может её переписать, свайп показывает
 * броски своего варианта, а удалённое сообщение уносит строку с собой.
 *
 * **Перерисовка — три рубежа, как у подвала:** события ST, наблюдатель за
 * `#chat` (реагирует на пропажу нашего узла) и идемпотентный `attach()`.
 */
const REDRAW_EVENTS = Object.freeze([
    'st.messageSwiped',
    'st.messageEdited',
    'st.messageUpdated',
    'st.messageDeleted',
    'st.characterMessageRendered',
    'st.userMessageRendered',
    'st.messageSwipeDeleted',
]);

const NOTE_CLASS = 'stme-roll-note';

export function createRollNoteCore(host, { createFinalUi, observe = defaultObserve } = {}) {
    const mounts = createUiMountRegistry(createFinalUi);
    const notes = new Map(); // mesid -> { root, signature }
    const subscriptions = [];
    let stopObserving = null;
    let attaching = false;

    const mountKey = mesid => `roll::${mesid}`;

    async function service(contract, params) {
        const result = await request(host.services, contract, { params });
        return result.ok ? result.value : null;
    }

    async function rollsFor(mesid) {
        const result = await request(host.own, 'decision.messageRolls', { params: { mesid: String(mesid) } });
        return result.ok ? result.value : null;
    }

    function forget(mesid) {
        const found = notes.get(mesid);
        mounts.unmount(mountKey(mesid));
        found?.root?.remove?.();
        notes.delete(mesid);
    }

    function forgetAll() {
        for (const mesid of [...notes.keys()]) forget(mesid);
    }

    async function ensureNote(mesid, lines) {
        const signature = JSON.stringify(lines);
        const found = notes.get(mesid);
        if (found && found.signature === signature) return found.root;
        forget(mesid);
        const note = h('div', { class: NOTE_CLASS, role: 'note' },
            ...lines.map((text, index) => h('div', { class: 'stme-roll-note-line', key: index }, text)));
        const finalUi = mounts.mount(mountKey(mesid), note);
        await finalUi.settled?.();
        const root = finalUi.getRoot?.() ?? null;
        if (root) notes.set(mesid, { root, signature });
        return root;
    }

    async function readMessages() {
        const rendered = await service('stChat.rendered');
        if (Array.isArray(rendered) && rendered.length) return rendered.map(item => ({ ...item, mesid: String(item.mesid) }));
        const ids = await service('stChat.renderedIds');
        return (ids ?? []).map(mesid => ({ mesid: String(mesid), isUser: false, isSystem: false, isToolCall: false }));
    }

    function isAttached(root, block) {
        return root?.parentNode === block;
    }

    /** Разложить строки по отрисованным сообщениям; идемпотентно. */
    async function attach() {
        if (attaching) return false;
        attaching = true;
        try {
            const messages = await readMessages();
            const rendered = new Set(messages.map(message => message.mesid));
            for (const mesid of [...notes.keys()]) if (!rendered.has(mesid)) forget(mesid);
            let placed = false;
            for (const message of messages) {
                // Строка нужна только там, где есть запись хода с бросками.
                const answer = await rollsFor(message.mesid);
                if (answer?.showRolls && answer.showRolls !== 'chat') { forget(message.mesid); continue; }
                const lines = Array.isArray(answer?.lines) ? answer.lines : [];
                if (!lines.length) { forget(message.mesid); continue; }
                // Ставим прямо над `.mes_text`, а не первым ребёнком `.mes`:
                // иначе строка оказалась бы рядом с аватаром, а не над ответом.
                const text = await service('stChat.messageTextElement', { mesid: message.mesid });
                const block = text?.parentNode ?? await service('stChat.messageElement', { mesid: message.mesid });
                if (!block) { forget(message.mesid); continue; }
                const root = await ensureNote(message.mesid, lines);
                if (!root) continue;
                if (!isAttached(root, block)) {
                    if (typeof block.insertBefore === 'function') block.insertBefore(root, text ?? block.firstChild ?? null);
                    else block.prepend?.(root);
                }
                placed = true;
            }
            return placed;
        } finally {
            attaching = false;
        }
    }

    async function start() {
        for (const event of REDRAW_EVENTS) subscriptions.push(host.events.subscribe(event, () => { attach(); }));
        subscriptions.push(host.events.subscribe('generation.completed', () => { attach(); }));
        // Запись хода сохраняется асинхронно уже после generation.completed — без этого события
        // первый attach читал runs[mesid] до записи и строка не появлялась до следующего хода.
        subscriptions.push(host.events.subscribe('decision.run.saved', () => { attach(); }));
        subscriptions.push(host.events.subscribe('decision.gameSettings.changed', () => { attach(); }));
        subscriptions.push(host.events.subscribe('decision.reloaded', () => { attach(); }));
        subscriptions.push(host.events.subscribe('st.chatChanged', () => { forgetAll(); attach(); }));
        const container = await service('stChat.container');
        stopObserving = observe(container, () => { attach(); });
        return attach();
    }

    return {
        attach,
        start,
        notes: () => [...notes.keys()],
        stop() {
            stopObserving?.();
            for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
            forgetAll();
            mounts.unmountAll();
        },
    };
}

/** Наблюдение за перерисовкой; вынесено параметром, чтобы Ядро проверялось без DOM. */
function defaultObserve(container, onChanged) {
    if (!container || typeof MutationObserver !== 'function') return () => {};
    const observer = new MutationObserver(() => onChanged());
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
}
