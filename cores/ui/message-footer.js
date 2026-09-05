import { request } from '../../libraries/shared/request.js';
import { createUiMountRegistry } from '../../libraries/shared/ui-mount-registry.js';

/**
 * Ядро подвала сообщения — полоса во всю ширину чата под сообщением, с местом
 * ровно под ТРИ самостоятельных виджета.
 *
 * **Подвал есть у КАЖДОГО сообщения**, а не один переезжающий на последнее.
 * Живым (реактивным) остаётся только подвал последнего сообщения; как только
 * приходит следующее, предыдущий ЗАМОРАЖИВАЕТСЯ — реактивная отрисовка
 * снимается, DOM остаётся как был. Так бейдж прошлого сообщения показывает то,
 * что было верно ТОГДА, и никуда не пропадает. Один переезжающий подвал
 * означал ровно обратное: бейдж стирался со всех прошлых сообщений (поймано
 * живьём на Модуле «RP Time»).
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
    // в одной карте (см. ui-mount-registry.js). Ключ здесь — пара
    // «сообщение + слот»: у каждого сообщения свой подвал.
    const mounts = createUiMountRegistry(createFinalUi);
    const slots = new Map(); // slot -> { ownerId, node }
    // Подвалы ВСЕХ сообщений. Живым остаётся только последний, см. freeze().
    const footers = new Map(); // mesid -> node
    const subscriptions = [];
    let stopObserving = null;
    let attaching = false;
    let started = false;
    // Ядру браузер не полагается вовсе (см. UI.md): единственное, что оно
    // трогает, это узлы, которые ему отдали Сервисы.
    let liveMesid = null;

    const mountKey = (mesid, slot) => `${mesid}::${slot}`;

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
        // Отрисовать НЕМЕДЛЕННО, а не ждать следующего `attach()` по событию.
        // Модуль включают уже после старта движка, и без этого его виджет не
        // появился бы никогда. Поймано живьём — Модуль «RP Time» занимал слот
        // и оставался невидимым.
        if (started) attach();
        return slot;
    }

    /** Снять слот — во ВСЕХ сообщениях сразу: выключенный Модуль не должен оставлять за собой хвост из старых бейджей. */
    function release(slot) {
        if (!slots.has(slot)) return false;
        for (const [mesid, footer] of footers) {
            mounts.unmount(mountKey(mesid, slot));
            footer.querySelector?.(`:scope > [data-slot="${slot}"]`)?.remove();
        }
        slots.delete(slot);
        return true;
    }

    function releaseAllOf(ownerId) {
        for (const [slot, taken] of [...slots]) if (taken.ownerId === ownerId) release(slot);
        return true;
    }

    /**
     * Заморозка. Реактивная отрисовка снимается, DOM остаётся ровно таким,
     * каким был. Это и есть «бейдж прошлого сообщения»: он показывает то, что
     * было верно тогда, и больше никогда не меняется.
     */
    function freeze(mesid) {
        if (mesid === null) return;
        for (const slot of SLOTS) mounts.unmount(mountKey(mesid, slot));
    }

    /** Забыть подвал сообщения, которого больше нет в чате (удалено, сменился чат). */
    function forget(mesid) {
        freeze(mesid);
        footers.get(mesid)?.remove?.();
        footers.delete(mesid);
        if (liveMesid === mesid) liveMesid = null;
    }

    function forgetAll() {
        for (const mesid of [...footers.keys()]) forget(mesid);
    }

    async function ensureFooter(mesid, block) {
        let footer = footers.get(mesid);
        if (!footer) {
            footer = await service('dom.createElement', { tag: 'div' });
            if (!footer) return null;
            footer.className = FOOTER_CLASS;
            footer.dataset.stmeFooter = 'true';
            footer.dataset.stmeFooterMesid = String(mesid);
            footers.set(mesid, footer);
        }
        if (!block.contains(footer)) block.append(footer);
        return footer;
    }

    /** Заполняет ячейки подвала живого сообщения. У замороженных DOM уже есть, и трогать его нельзя. */
    async function fillSlots(mesid, footer) {
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
            const key = mountKey(mesid, slot);
            if (!mounts.isMounted(key)) {
                mounts.mount(key, taken.node);
                await mounts.settled(key);
            }
            const root = mounts.getFinalUi(key)?.getRoot();
            if (root && !cell.contains(root)) cell.append(root);
        }
    }

    /**
     * Возвращает подвалы на место. Идемпотентен: если узел на месте и стоит
     * под своим сообщением — не делает ничего. Именно поэтому его безопасно
     * звать и по событию, и от наблюдателя, и просто на всякий случай.
     */
    async function attach() {
        if (attaching || !slots.size) return false;
        attaching = true;
        try {
            const ids = (await service('stChat.renderedIds'))?.map(String);
            if (!ids?.length) return false;
            const target = ids[ids.length - 1];

            // Сообщения, которых в чате больше нет, забываем вместе с подвалом.
            const rendered = new Set(ids);
            for (const mesid of [...footers.keys()]) if (!rendered.has(mesid)) forget(mesid);

            // Новое последнее сообщение — прошлое перестаёт быть живым.
            if (liveMesid !== null && liveMesid !== target) freeze(liveMesid);

            // Чужая перерисовка могла выкинуть ЛЮБОЙ из подвалов, не только
            // последний: возвращаем на место все.
            for (const [mesid, footer] of footers) {
                if (mesid === target) continue;
                const block = await service('stChat.messageElement', { mesid });
                if (block && !block.contains(footer)) block.append(footer);
            }

            const block = await service('stChat.messageElement', { mesid: target });
            if (!block) return false;
            const footer = await ensureFooter(target, block);
            if (!footer) return false;
            liveMesid = target;
            await fillSlots(target, footer);
            return true;
        } finally {
            attaching = false;
        }
    }

    /** Исторический синоним `attach()`: монтирование теперь живёт внутри него — дерево нельзя смонтировать, пока неизвестно, ПОД КАКИМ сообщением оно окажется. */
    const render = () => attach();

    async function start() {
        started = true;
        for (const event of REDRAW_EVENTS) {
            if (event === 'st.chatChanged') continue;
            subscriptions.push(host.events.subscribe(event, () => { attach(); }));
        }
        // Другой чат — другие сообщения под теми же номерами (`mesid` — это
        // индекс, а не устойчивый идентификатор). Всё накопленное выбрасываем
        // ПЕРЕД тем, как раскладывать заново, иначе бейджи прошлого чата
        // всплыли бы в новом под чужими сообщениями.
        subscriptions.push(host.events.subscribe('st.chatChanged', () => { forgetAll(); attach(); }));
        const container = await service('stChat.container');
        // Наблюдатель — последний рубеж, а не первый: он реагирует только на
        // пропажу нашего узла, иначе собственная вставка запускала бы его
        // снова и снова.
        // Наблюдатель зовёт attach() без разбора: тот сам дёшево выходит,
        // если подвал на месте. Проверять «а пропал ли он» здесь значило бы
        // держать вторую копию той же логики.
        stopObserving = observe(container, () => { attach(); });
        return attach();
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
        footerCount: () => footers.size,
        slots: () => SLOTS.map(slot => ({ slot, ownerId: slots.get(slot)?.ownerId ?? null })),
        stop: () => {
            stopObserving?.();
            for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
            for (const slot of SLOTS) release(slot);
            forgetAll();
            mounts.unmountAll();
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
