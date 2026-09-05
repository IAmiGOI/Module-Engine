import { request } from '../../libraries/shared/request.js';
import { createUiMountRegistry } from '../../libraries/shared/ui-mount-registry.js';

/**
 * Ядро подвала сообщения — полоса во всю ширину чата под последним сообщением,
 * с местом ровно под ТРИ самостоятельных виджета.
 *
 * **Модель этого не видит. Никогда.** Подвал живёт исключительно в DOM и
 * собирается из того, что лежит на шине; в `message.mes` не пишется ни байта.
 * Это не договорённость, а свойство конструкции: сюда физически нечем
 * дописать текст сообщения — Ядро не знает контракта на его правку. У Alpha
 * бейджи хранились в `message.extra` и туда же могли просочиться, здесь такой
 * возможности нет вовсе.
 *
 * **Защита от перерисовки — не кооперативная.** У Alpha было честно записано
 * (core/chat-badge-service.js), что бейдж переживает чужую правку только если
 * тот, кто её сделал, вежливо позовёт `reapply()`. Реролл, правка сообщения
 * руками и перезагрузка чата никого не зовут — и подтверждённо стирали бейдж.
 * Здесь три рубежа, и каждый следующий закрывает то, что пропустил предыдущий:
 *
 *  1. **События ST** — `st.messageSwiped`/`messageEdited`/`messageUpdated`/
 *     `messageDeleted`/`characterMessageRendered`/`userMessageRendered`/
 *     `chatChanged`. Ловят подавляющее большинство случаев сразу и дёшево.
 *  2. **Наблюдатель за `#chat`** — на случай перерисовки, о которой ST не
 *     сообщает вовсе (а такие есть: `updateMessageBlock()` из чужого кода
 *     события не эмитит). Реагирует на исчезновение нашего узла, а не на
 *     любое изменение, иначе сам бы себя гонял по кругу.
 *  3. **Идемпотентность.** `attach()` можно звать сколько угодно и откуда
 *     угодно: он чинит только то, что действительно отвалилось.
 *
 * Виджеты внутри — независимые: у каждого свой Final UI и своя жизнь, падение
 * или перерисовка одного не трогает соседей.
 */

export const SLOTS = Object.freeze(['left', 'center', 'right']);

/** События ST, после которых сообщение может оказаться перерисованным. */
const REDRAW_EVENTS = Object.freeze([
    'st.chatChanged',
    'st.messageSwiped',
    'st.messageEdited',
    'st.messageUpdated',
    'st.messageDeleted',
    'st.characterMessageRendered',
    'st.userMessageRendered',
    'st.messageSwipeDeleted',
]);

const FOOTER_CLASS = 'stme-message-footer';

export function createMessageFooterCore(host, { createFinalUi, observe = defaultObserve } = {}) {
    // Тот же механизм, что под Ядром UI модулей и Ядром UI для Engine: каждый
    // ключ получает СВОЙ независимый Final UI, иначе пути деревьев столкнутся
    // в одной карте (см. ui-mount-registry.js).
    const mounts = createUiMountRegistry(createFinalUi);
    const slots = new Map(); // slot -> { ownerId, node }
    const subscriptions = [];
    let stopObserving = null;
    let attaching = false;
    let started = false;
    // Узел подвала держим САМИ. Иначе пришлось бы искать его по документу —
    // а Ядру браузер не полагается вовсе (см. UI.md): единственное, что оно
    // трогает, это узлы, которые ему отдали Сервисы.
    let footerNode = null;

    async function service(contract, params) {
        const result = await request(host.services, contract, { params });
        return result.ok ? result.value : null;
    }

    /**
     * Занять слот. Дерево передаётся как есть — Ядро не заглядывает внутрь и
     * не знает, что там; его дело — дать место и следить, чтобы оно не
     * пропало.
     */
    function claim({ slot, ownerId, node } = {}) {
        if (!SLOTS.includes(slot)) throw new Error(`ui.messageFooter.claim: unknown slot "${slot}" (expected ${SLOTS.join(', ')}).`);
        if (!ownerId) throw new Error('ui.messageFooter.claim: "ownerId" is required.');
        const taken = slots.get(slot);
        if (taken && taken.ownerId !== ownerId) throw new Error(`ui.messageFooter.claim: slot "${slot}" is already taken by "${taken.ownerId}".`);

        release(slot);
        slots.set(slot, { ownerId, node });
        // Отрисовать НЕМЕДЛЕННО, а не ждать следующего `render()`. Модуль
        // включают уже после старта движка, и без этого его виджет не появлялся
        // бы никогда: `render()` монтирует лишь то, что было заявлено на момент
        // вызова. Поймано живьём — Модуль «RP Time» занимал слот и оставался
        // невидимым.
        if (started) render();
        return slot;
    }

    function release(slot) {
        if (!slots.has(slot)) return false;
        mounts.getFinalUi(slot)?.getRoot()?.remove();
        mounts.unmount(slot);
        slots.delete(slot);
        return true;
    }

    function releaseAllOf(ownerId) {
        for (const [slot, taken] of [...slots]) if (taken.ownerId === ownerId) release(slot);
        return true;
    }

    /** Куда подвал крепится: под ПОСЛЕДНЕЕ отрисованное сообщение — там, где пользователь и смотрит. */
    async function targetMesid() {
        const ids = await service('stChat.renderedIds');
        return ids?.length ? ids[ids.length - 1] : null;
    }

    /**
     * Возвращает подвал на место. Идемпотентен: если узел на месте и стоит под
     * нужным сообщением — не делает ничего. Именно поэтому его безопасно звать
     * и по событию, и от наблюдателя, и просто на всякий случай.
     */
    async function attach() {
        if (attaching || !slots.size) return false;
        attaching = true;
        try {
            const mesid = await targetMesid();
            if (mesid === null) return false;
            const block = await service('stChat.messageElement', { mesid });
            if (!block) return false;

            // Ранний выход касается ТОЛЬКО перестановки самого подвала. Слоты
            // ниже перебираются всегда: Модуль включают уже после того, как
            // подвал встал на место, и пропусти мы этот перебор — его виджет
            // не появился бы никогда. Ровно на этом и поймали живьём.
            if (!footerNode) footerNode = await service('dom.createElement', { tag: 'div' });
            if (!footerNode) return false;
            if (!block.contains(footerNode)) {
                // Подвал мог остаться под ПРЕДЫДУЩИМ сообщением — переносим тот
                // же узел, а не плодим новый: иначе после каждого ответа их
                // копилось бы по одному на сообщение.
                footerNode.remove?.();
                footerNode.className = FOOTER_CLASS;
                footerNode.dataset.stmeFooter = 'true';
                block.append(footerNode);
            }
            const footer = footerNode;

            for (const slot of SLOTS) {
                const taken = slots.get(slot);
                if (!taken) continue;
                let cell = footer.querySelector(`:scope > [data-slot="${slot}"]`);
                if (!cell) {
                    cell = await service('dom.createElement', { tag: 'div' });
                    if (!cell) continue;
                    cell.className = 'stme-message-footer-slot';
                    cell.dataset.slot = slot;
                    footer.append(cell);
                }
                const root = mounts.getFinalUi(slot)?.getRoot();
                if (root && !cell.contains(root)) cell.append(root);
            }
            return true;
        } finally {
            attaching = false;
        }
    }

    /** Рисует деревья слотов и ставит подвал на место. Отдельно от `claim()`: дерево применяется асинхронно, а занять слот можно и до того, как чат отрисован. */
    async function render() {
        for (const [slot, taken] of slots) {
            if (mounts.isMounted(slot)) continue;
            mounts.mount(slot, taken.node);
            await mounts.settled(slot);
        }
        return attach();
    }

    async function start() {
        started = true;
        for (const event of REDRAW_EVENTS) subscriptions.push(host.events.subscribe(event, () => { attach(); }));
        const container = await service('stChat.container');
        // Наблюдатель — последний рубеж, а не первый: он реагирует только на
        // пропажу нашего узла, иначе собственная вставка запускала бы его
        // снова и снова.
        // Наблюдатель зовёт attach() без разбора: тот сам дёшево выходит,
        // если подвал на месте. Проверять «а пропал ли он» здесь значило бы
        // держать вторую копию той же логики.
        stopObserving = observe(container, () => { attach(); });
        return render();
    }

    const unregisters = [
        host.own.register('ui.messageFooter.claim', params => claim(params)),
        host.own.register('ui.messageFooter.release', params => (params?.ownerId ? releaseAllOf(params.ownerId) : release(params?.slot))),
        host.own.register('ui.messageFooter.slots', () => SLOTS.map(slot => ({ slot, ownerId: slots.get(slot)?.ownerId ?? null }))),
        host.own.register('ui.messageFooter.attach', () => attach()),
    ];

    return {
        claim,
        release,
        releaseAllOf,
        render,
        attach,
        start,
        slots: () => SLOTS.map(slot => ({ slot, ownerId: slots.get(slot)?.ownerId ?? null })),
        stop: () => {
            stopObserving?.();
            for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
            for (const slot of SLOTS) release(slot);
            mounts.unmountAll();
            footerNode?.remove?.();
            footerNode = null;
            for (const unregister of unregisters) unregister();
        },
    };
}

/** Наблюдение за перерисовкой. Вынесено параметром, чтобы Ядро проверялось без DOM. */
function defaultObserve(container, onChanged) {
    if (!container || typeof MutationObserver !== 'function') return () => {};
    const observer = new MutationObserver(() => onChanged());
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
}
