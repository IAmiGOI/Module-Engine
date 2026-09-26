/**
 * Виджет «Часы» (квадратный блок 150×150) — первый виджет рабочего стола Module Engine и образец контракта (libraries/shared/widget-contract.js): ничего не импортирует, весь
 * файл — данные и фабрика. Рисует ТОЛЬКО внутри своего блока: HTML тела для WebGL-растра, единственная кнопка — переключатель 12/24 часа.
 *
 * Обновляется раз в минуту, а не каждую секунду: секунд на экране нет, поэтому растр перерисовывается ровно тогда, когда меняется текст, и таймер
 * нацелен на границу минуты (не «раз в 60 секунд» с дрейфом). Формат запоминается через `host.storage` (если он дан).
 */

const pad = value => String(value).padStart(2, '0');

/**
 * Чистое форматирование для момента `now`: `{ time, period, weekday, date }`. `time` — только часы и минуты (крупно), `period` — AM/PM в 12-часовом формате
 * (мелко рядом, поэтому время не раздувает блок), `weekday` и `date` — две короткие строки под ним.
 */
export function formatClock(now, { hour12 = false, locale } = {}) {
    const time = hour12 ? `${now.getHours() % 12 || 12}:${pad(now.getMinutes())}` : `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const period = hour12 ? (now.getHours() < 12 ? 'AM' : 'PM') : '';
    const weekday = now.toLocaleDateString(locale, { weekday: 'long' });
    const date = now.toLocaleDateString(locale, { day: 'numeric', month: 'long' });
    return { time, period, weekday, date };
}

/** Через сколько миллисекунд наступит следующая минута (плюс небольшой запас, чтобы не попасть на 59.999). */
export const msToNextMinute = now => 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 40;

const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

export default {
    id: 'clock',
    title: 'Clock',
    description: 'The current time and date. Click the button to switch 12/24 hour.',
    size: { w: 150, h: 150 },
    rights: [],
    create(host) {
        let hour12 = false;
        let timer = null;
        const now = () => (host.now ? host.now() : new Date());

        const schedule = () => {
            clearTimeout(timer);
            timer = setTimeout(() => { host.invalidate(); schedule(); }, msToNextMinute(now()));
        };

        return {
            html() {
                const { time, period, weekday, date } = formatClock(now(), { hour12 });
                return `<div class="hb"><div class="wg-title" style="left:14px;top:12px;right:64px">Clock</div>`
                    + `<div class="wg-big" style="left:14px;top:40px;right:${period ? 40 : 10}px;font-size:34px">${escapeHtml(time)}</div>`
                    + (period ? `<div class="wg-muted" style="right:12px;top:58px;width:26px">${period}</div>` : '')
                    + `<div class="wg-text" style="left:14px;top:96px;right:10px">${escapeHtml(weekday)}</div>`
                    + `<div class="wg-muted" style="left:14px;top:116px;right:10px">${escapeHtml(date)}</div></div>`;
            },
            actions: [{ id: 'format', icon: 'fa-clock', title: 'Switch 12/24 hour' }],
            onAction(id) {
                if (id !== 'format') return;
                hour12 = !hour12;
                void host.storage?.set?.('hour12', hour12);
                host.invalidate();
            },
            async start() {
                try { hour12 = Boolean(await host.storage?.get?.('hour12')); } catch { hour12 = false; }
                host.invalidate();
                schedule();
            },
            stop() { clearTimeout(timer); timer = null; },
        };
    },
};
