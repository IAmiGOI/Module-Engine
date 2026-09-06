import { request } from '../../libraries/shared/request.js';
import { createUiMountRegistry } from '../../libraries/shared/ui-mount-registry.js';

/**
 * Ядро подвала сообщения — полоса во всю ширину чата под сообщением, с местом
 * ровно под ТРИ самостоятельных виджета.
 *
 * **Подвал у КАЖДОГО сообщения, и каждый рисуется отдельно.** Занимая слот,
 * владелец даёт не готовое дерево, а ФАБРИКУ `({ mesid, isUser, isSystem,
 * live }) => дерево | null`: Ядро зовёт её на каждое отрисованное сообщение.
 * `null` означает «под этим сообщением мне нечего показывать» — так бейдж
 * времени сам отказывается от реплик пользователя, а Ядро не обзаводится
 * знанием о том, кому что подходит. Подвал появляется только там, где хотя бы
 * один слот что-то дал.
 *
 * Почему именно фабрика, а не одно дерево на всех. Одно дерево — это один
 * набор сигналов, то есть ОДНО значение на весь чат; показывать его под каждым
 * сообщением значило бы переписывать историю при каждом обновлении. Прошлые
 * версии этого Ядра пытались обойтись переносом единственного узла к
 * последнему сообщению (бейдж исчезал у прошлых) и заморозкой реактивности
 * (бейдж застывал на том, что случайно оказалось на экране в момент
 * заморозки, — например на пустоте посреди опроса). Фабрика убирает и то, и
 * другое: у каждого сообщения своё дерево над СВОИМИ данными, и «ещё не
 * посчитано» у нового сообщения — такое же честное состояние, как готовое
 * значение у старого.
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
    // «сообщение + слот».
    const mounts = createUiMountRegistry(createFinalUi);
    const slots = new Map(); // slot -> { ownerId, build }
    const footers = new Map(); // mesid -> узел подвала
    const subscriptions = [];
    let stopObserving = null;
    let attaching = false;
    let started = false;

    const mountKey = (mesid, slot) => `${mesid}::${slot}`;

    async function service(contract, params) {
        const result = await request(host.services, contract, { params });
        return result.ok ? result.value : null;
    }

    /**
     * Занять слот. `node` — либо фабрика (см. заголовок файла), либо готовое
     * дерево; готовое дерево остаётся ради простых случаев и означает «одно и
     * то же под последним сообщением». Ядро не заглядывает внутрь и не знает,
     * что там; его дело — дать место и следить, чтобы оно не пропало.
     */
    function claim({ slot, ownerId, node } = {}) {
        if (!SLOTS.includes(slot)) throw new Error(`ui.messageFooter.claim: unknown slot "${slot}" (expected ${SLOTS.join(', ')}).`);
        if (!ownerId) throw new Error('ui.messageFooter.claim: "ownerId" is required.');
        const taken = slots.get(slot);
        if (taken && taken.ownerId !== ownerId) throw new Error(`ui.messageFooter.claim: slot "${slot}" is already taken by "${taken.ownerId}".`);

        release(slot);
        const build = typeof node === 'function' ? node : (message => (message.live ? node : null));
        slots.set(slot, { ownerId, build });
        // Отрисовать НЕМЕДЛЕННО, а не ждать следующего события. Модуль включают
        // уже после старта движка, и без этого его виджет не появился бы
        // никогда. Поймано живьём — Модуль «RP Time» занимал слот и оставался
        // невидимым.
        if (started) attach();
        return slot;
    }

    /** Снять слот — во ВСЕХ сообщениях сразу: выключенный Модуль не должен оставлять за собой хвост из старых бейджей. */
    function release(slot) {
        if (!slots.has(slot)) return false;
        for (const [mesid, footer] of footers) dropCell(mesid, slot, footer);
        slots.delete(slot);
        return true;
    }

    function releaseAllOf(ownerId) {
        for (const [slot, taken] of [...slots]) if (taken.ownerId === ownerId) release(slot);
        return true;
    }

    function dropCell(mesid, slot, footer) {
        mounts.unmount(mountKey(mesid, slot));
        footer?.querySelector?.(`:scope > [data-slot="${slot}"]`)?.remove();
    }

    /** Забыть подвал сообщения, которого больше нет (удалено, сменился чат). */
    function forget(mesid) {
        const footer = footers.get(mesid);
        for (const slot of SLOTS) mounts.unmount(mountKey(mesid, slot));
        footer?.remove?.();
        footers.delete(mesid);
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

    /** Раскладывает один подвал. Возвращает, дал ли хоть один слот содержимое. */
    async function fillSlots(message, block) {
        const wanted = [];
        for (const slot of SLOTS) {
            const taken = slots.get(slot);
            if (!taken) continue;
            const node = taken.build(message);
            if (node) wanted.push({ slot, node });
        }

        const existing = footers.get(message.mesid);
        if (!wanted.length) {
            // Слот мог отказаться от сообщения, под которым раньше рисовался
            // (реролл: значение стёрли, показывать нечего) — прибираем за собой.
            if (existing) forget(message.mesid);
            return false;
        }

        const footer = await ensureFooter(message.mesid, block);
        if (!footer) return false;
        for (const slot of SLOTS) if (!wanted.some(item => item.slot === slot)) dropCell(message.mesid, slot, footer);

        for (const { slot, node } of wanted) {
            let cell = footer.querySelector(`:scope > [data-slot="${slot}"]`);
            if (!cell) {
                cell = await service('dom.createElement', { tag: 'div' });
                if (!cell) continue;
                cell.className = 'stme-message-footer-slot';
                cell.dataset.slot = slot;
                footer.append(cell);
            }
            const key = mountKey(message.mesid, slot);
            if (!mounts.isMounted(key)) {
                mounts.mount(key, node);
                await mounts.settled(key);
            }
            const root = mounts.getFinalUi(key)?.getRoot();
            if (root && !cell.contains(root)) cell.append(root);
        }
        return true;
    }

    /**
     * Какие сообщения сейчас на экране и кто их написал. `stChat.rendered`
     * появился позже `stChat.renderedIds`, поэтому есть запасной путь: без
     * ролей подвал вести себя будет как раньше, но не сломается.
     */
    async function readMessages() {
        const rendered = await service('stChat.rendered');
        if (Array.isArray(rendered) && rendered.length) {
            return rendered.map(item => ({ ...item, mesid: String(item.mesid) }));
        }
        const ids = await service('stChat.renderedIds');
        return (ids ?? []).map(mesid => ({ mesid: String(mesid), isUser: false, isSystem: false, isToolCall: false }));
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
            const messages = await readMessages();
            if (!messages.length) return false;
            const lastId = messages[messages.length - 1].mesid;

            // Сообщения, которых в чате больше нет, забываем вместе с подвалом.
            const rendered = new Set(messages.map(message => message.mesid));
            for (const mesid of [...footers.keys()]) if (!rendered.has(mesid)) forget(mesid);

            let placed = false;
            for (const message of messages) {
                const block = await service('stChat.messageElement', { mesid: message.mesid });
                if (!block) continue;
                placed = await fillSlots({ ...message, live: message.mesid === lastId }, block) || placed;
            }
            return placed;
        } finally {
            attaching = false;
        }
    }

    /** Исторический синоним `attach()`: монтирование живёт внутри него — дерево нельзя смонтировать, пока неизвестно, ПОД КАКИМ сообщением оно окажется. */
    const render = () => attach();

    /**
     * Настоящее последнее отрисованное сообщение — ПРЯМО СЕЙЧАС. Существует
     * для Модулей, которым нужно знать «куда писать» в момент, не совпадающий
     * с чужим вызовом фабрики слота (RP Time — по завершении опроса модели, а
     * не по факту рендера). Модуль не может спросить `stChat.*` сам: он не
     * знает о Сервисах ничего, и не должен, — а это Ядро уже умеет вычислять
     * ровно то же самое для собственного `attach()`. Раз посчитано здесь —
     * DRY, а не второй источник истины о «что сейчас последнее».
     */
    async function liveMesid() {
        const messages = await readMessages();
        return messages.length ? messages[messages.length - 1].mesid : null;
    }

    async function start() {
        started = true;
        for (const event of REDRAW_EVENTS) subscriptions.push(host.events.subscribe(event, () => { attach(); }));
        // Другой чат — другие сообщения под теми же номерами (`mesid` — это
        // индекс, а не устойчивый идентификатор). Всё накопленное выбрасываем
        // ПЕРЕД тем, как раскладывать заново, иначе подвалы прошлого чата
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
        host.own.register('ui.messageFooter.liveMesid', () => liveMesid()),
    ];

    return {
        claim,
        release,
        releaseAllOf,
        render,
        attach,
        start,
        liveMesid,
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
