import { request } from '../../../libraries/shared/request.js';
import { createPillarsSources } from './sources.js';
import { createPillarsScreen } from './screen.js';
import { hubText } from './pillar-states.js';
import { pillarMeta } from './meta.js';

/**
 * Ядро меню «Пять столпов»: полноэкранный экран из утверждённого макета (`screen.js`), открывается
 * кругом рядом с колесиком контекста у строки ввода или событием `decision.pillars.openRequested`.
 * Данные — только через существующие контракты (`sources.js` → модели `libraries/core/pillars-sources.js`),
 * действия экрана — тоже через них. Экран строится один раз; пока он скрыт, не рисует и не ловит клики.
 */
const OPEN_EVENT = 'decision.pillars.openRequested';
const ORDER = ['god', 'director', 'counsellor', 'resolver', 'writer'];

export function createPillarsCore(host, {
    document: doc = globalThis.document,
    createScreen = createPillarsScreen,
    createSourceSet = createPillarsSources,
} = {}) {
    let active = null;

    /** Модель столпа по его id — то, что экран рисует. Отказ контракта — пустая модель, экран открывается всё равно. */
    async function load(sources, id) {
        if (id === 'court') return sources.court();
        if (id === 'bank') return sources.bank();
        if (id === 'world') return (await sources.world())?.volume ?? null;
        if (id === 'charter') return sources.charter();
        if (id === 'canon') return sources.canon();
        return null;
    }

    async function mountUi() {
        if (active) return { ok: true };
        const sources = createSourceSet({ host, call: (contract, params) => request(host.own, contract, { params }) });
        const screen = createScreen({
            document: doc,
            load: id => load(sources, id).catch(() => null),
            actions: sources.actions,
            onHide: () => { void refreshStates(); },
        });
        screen.mount(doc.body);
        active = { screen, sources };
        return { ok: true };
    }

    /** Подписи под эмблемами, огни Court и центр — из живых моделей. */
    async function refreshStates() {
        if (!active) return;
        const { states, models } = await active.sources.states().catch(() => ({ states: null, models: null }));
        if (!states || !active) return;
        active.screen.setStates(states);
        active.screen.setHub(hubText({ name: models?.court?.name, rpTime: models?.court?.rpTime, place: models?.court?.place }));
        const working = new Set(models?.court?.working ?? []);
        active.screen.setFires(ORDER.map(id => working.has(id)));
    }

    async function open() {
        if (!active) await mountUi();
        active.screen.show();
        void refreshStates();
        return true;
    }

    function close() {
        if (!active) return false;
        active.screen.hide();
        return true;
    }

    async function toggle() {
        return active?.screen.isVisible() ? close() : open();
    }

    const unregisters = [
        host.own.register('pillars.mount', () => mountUi()),
        host.own.register('pillars.open', () => open()),
        host.own.register('pillars.close', () => close()),
        host.own.register('pillars.toggle', () => toggle()),
        host.own.register('pillars.isOpen', () => Boolean(active?.screen.isVisible())),
    ];
    const refreshIfOpen = () => { if (active?.screen.isVisible()) void refreshStates(); };
    const subscriptions = [
        host.events.subscribe(OPEN_EVENT, () => { void open(); }),
        host.events.subscribe('st.chatChanged', refreshIfOpen),
        host.events.subscribe('decision.reloaded', refreshIfOpen),
        host.events.subscribe('decision.cycle.finished', refreshIfOpen),
    ];

    return {
        mount: mountUi,
        open,
        close,
        toggle,
        refresh: refreshStates,
        isMounted: () => active !== null,
        isOpen: () => Boolean(active?.screen.isVisible()),
        sources: () => active?.sources ?? null,
        stop: async () => {
            for (const unsubscribe of subscriptions.splice(0)) unsubscribe?.();
            for (const unregister of unregisters.splice(0)) unregister?.();
            active?.screen.dispose();
            active = null;
        },
    };
}

export { OPEN_EVENT, pillarMeta };
