import { request } from '../../../libraries/shared/request.js';
import { SEND_ON_ENTER, shouldSendOnKey, computeBarColumn } from '../../../libraries/shared/input-bar-model.js';
import { createNativeBridge } from './native-bridge.js';
import { createInputPill } from './pill.js';
import { createLeftDock } from './left-dock.js';

const ACTIVE_CLASS = 'stme-input-bar-active';
/** Боковая панель (верхняя полоса ST → вертикально слева, styles/chrome/side-bar.css) — только на широком экране без тача; на телефоне полоса остаётся родной. */
const SIDE_BAR_CLASS = 'stme-side-bar-active';
const SIDE_BAR_MIN_WIDTH = 900;

/** Настройка ST «Send on Enter» — у ST её держит `power_user`; недоступна (тесты, ранний старт) → авто. */
const stSendOnEnter = () => globalThis.SillyTavern?.getContext?.()?.powerUserSettings?.send_on_enter ?? SEND_ON_ENTER.AUTO;

/**
 * Ядро собственной панели набора текста. Включается вместе с оверлеем Chat Viewport (`inputBar.enable()`/`disable()`): родная панель
 * ST (`#send_form`) прячется CSS'ом, вместо неё — пилюля по колонке сообщений (`pill.js`), а две родные кнопки слева (меню, расширения)
 * переезжают в левый выезжающий док (`left-dock.js`). Текст, отправка и остановка идут через родные элементы (`native-bridge.js`).
 *
 * События: слушает `ui.chatViewport.columnChanged` ({left, width} — колонка сообщений, чтобы пилюля была ровно по ней) и
 * `st.chatChanged`; сам сообщает `ui.inputBar.changed` — включена/выключена и любая смена её высоты (поле растёт с текстом;
 * оверлею чата нужен нижний отступ по верху пилюли).
 *
 * Браузерное — инъекцией (`document`, `win`, `touch`, фабрики) — Ядро, как и док запуска, строит обычный DOM мимо деревьев `h()`.
 */
export function createInputBarCore(host, {
    document: doc = globalThis.document,
    win = globalThis,
    touch = false,
    getSendOnEnter = stSendOnEnter,
    createBridge = createNativeBridge,
    ResizeObserverCtor = globalThis.ResizeObserver,
    publish,
} = {}) {
    let active = null;
    let column = null;
    // Колонку сообщений оверлей сообщает при СВОЁМ включении — раньше, чем включается пилюля, поэтому слушаем с момента создания Ядра и помним последнюю.
    const stopColumn = host.events.subscribe('ui.chatViewport.columnChanged', payload => { column = payload; active?.applyColumn(); });

    const emitChanged = payload => (publish ?? ((event, data) => host.events.emit(event, data)))('ui.inputBar.changed', payload);

    async function regenerate() {
        const result = await request(host.services, 'stChat.regenerate', { params: {} });
        if (!result.ok) console.warn('[input bar] regenerate failed:', result.error?.message);
    }

    async function enable() {
        if (active) return { ok: true };
        const bridge = createBridge({ document: doc });
        if (!bridge.available()) return { ok: false, reason: 'native-input-missing' };

        const buttons = bridge.takeLeftButtons();
        const pill = createInputPill({
            document: doc,
            getWindowHeight: () => win.innerHeight,
            ResizeObserverCtor,
            onInput: value => bridge.writeText(value),
            onSend: () => { bridge.writeText(pill.getValue()); bridge.send(); },
            onStop: () => bridge.stop(),
            onRegenerate: regenerate,
            shouldSend: event => shouldSendOnKey({
                key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey,
                isComposing: event.isComposing, touch, sendOnEnter: getSendOnEnter(),
            }),
            onResize: () => emitChanged({ active: true, height: pill.height() }),
        });
        const dock = createLeftDock({ document: doc, touch, buttons, onCloseChat: () => bridge.closeChat() });

        const applyColumn = () => {
            const bar = computeBarColumn({ column, windowWidth: win.innerWidth });
            pill.setColumn(bar);
        };
        const syncFromNative = () => { pill.setValue(bridge.readText()); };
        applyColumn();
        pill.setValue(bridge.readText());
        pill.setGenerating(bridge.isGenerating());
        doc.documentElement.classList.add(ACTIVE_CLASS);
        if (!touch && win.innerWidth >= SIDE_BAR_MIN_WIDTH) doc.documentElement.classList.add(SIDE_BAR_CLASS);
        pill.mount(doc.body);
        dock.mount(doc.body);

        const onWindowResize = () => { applyColumn(); pill.autosize(); };
        win.addEventListener('resize', onWindowResize);
        const cleanups = [
            () => win.removeEventListener('resize', onWindowResize),
            bridge.watchGenerating(generating => pill.setGenerating(generating)),
            bridge.watchNativeText(syncFromNative),
            host.events.subscribe('st.chatChanged', syncFromNative),
        ];
        active = { pill, dock, cleanups, applyColumn };
        emitChanged({ active: true, height: pill.height() });
        return { ok: true };
    }

    async function disable() {
        if (!active) return;
        const { pill, dock, cleanups } = active;
        active = null;
        for (const cleanup of cleanups) cleanup?.();
        dock.dispose();
        pill.dispose();
        doc.documentElement.classList.remove(ACTIVE_CLASS);
        doc.documentElement.classList.remove(SIDE_BAR_CLASS);
        emitChanged({ active: false, height: 0 });
    }

    const unregisters = [
        host.own.register('inputBar.enable', () => enable()),
        host.own.register('inputBar.disable', () => disable()),
        host.own.register('inputBar.isActive', () => active !== null),
    ];

    return {
        enable,
        disable,
        isActive: () => active !== null,
        pill: () => active?.pill ?? null,
        stop: () => { stopColumn?.(); for (const unregister of unregisters) unregister(); return disable(); },
    };
}
