import { CHROME_REFLOW_MS } from './constants.js';

/** Слежение за реальной высотой хрома строки (`ResizeObserver`) и отложенная раскладка подвалов сообщений. */
export function installChromeWatch(ctx) {
    const { s, chromeHeightCache, chromeObservers, serviceOrNull, coreOrNull } = ctx;

    function scheduleFooterAttach() {
        // Первый вызов — сразу (новая строка получает подвал без ожидания), остальные в течение 60 мс схлопываются в один хвостовой.
        if (s.footerAttachTimer !== null) { s.footerAttachDirty = true; return; }
        coreOrNull('ui.messageFooter.attach', {});
        s.footerAttachTimer = setTimeout(() => {
            s.footerAttachTimer = null;
            if (s.footerAttachDirty) { s.footerAttachDirty = false; ctx.scheduleFooterAttach(); }
        }, 60);
    }

    // Хром строки (имя, бейджи, время) измеряется ОДИН раз и кэшируется, а верх текста считается от этой высоты. Но у хрома она может
    // измениться ПОСТФАКТУМ: имя переносится на вторую строку на узком экране (телефон), позже подгружается шрифт, колонка получает
    // окончательную ширину. Раньше такая правка не замечалась вовсе — текст оставался на прежнем месте и НАЛЕЗАЛ на шапку (скриншоты
    // владельца с телефона). Теперь за реальной высотой хрома следит `ResizeObserver` (сервис `dom.observeResize`): изменилась — кэш строки
    // сбрасывается, а строки пересчитываются одним общим проходом.

    function queueChromeReflow() {
        if (s.chromeReflowTimer !== null) return;   // пачка правок за это время — один пересчёт
        s.chromeReflowTimer = setTimeout(() => {
            s.chromeReflowTimer = null;
            s.toggleRender = true;                    // рост высоты от пересчёта — не повод автопрокручивать вниз
            ctx.render({ fresh: false });
        }, CHROME_REFLOW_MS);
    }
    async function watchChromeHeight(mesid, el) {
        const current = chromeObservers.get(mesid);
        if (current?.el === el) return;
        if (current) await serviceOrNull('dom.unobserveResize', { el: current.el, handler: current.handler });
        // Сами размеры из уведомления не берём (это content-box без рамок и отступов) — перемеряем ТЕМ ЖЕ способом, каким кэш и заполнялся.
        const handler = async () => {
            const cached = chromeHeightCache.get(mesid);
            if (!cached) return;   // ещё не измеряли — обычный путь измерит сам
            const rect = await serviceOrNull('dom.measureRect', { el });
            const measured = cached.pad + Math.max(0, Math.round(rect?.height ?? 0));
            if (Math.abs(measured - cached.height) < 1) return;
            chromeHeightCache.delete(mesid);
            ctx.queueChromeReflow();
        };
        const observing = await serviceOrNull('dom.observeResize', { el, handler });
        if (observing) chromeObservers.set(mesid, { el, handler }); else chromeObservers.delete(mesid);
    }
    async function stopWatchingChromeHeight(mesid) {
        const current = chromeObservers.get(mesid);
        if (!current) return;
        chromeObservers.delete(mesid);
        await serviceOrNull('dom.unobserveResize', { el: current.el, handler: current.handler });
    }

    Object.assign(ctx, { scheduleFooterAttach, queueChromeReflow, watchChromeHeight, stopWatchingChromeHeight });
}
