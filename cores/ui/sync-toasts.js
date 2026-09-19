import { request } from '../../libraries/shared/request.js';
import { describeLastRun, describeProgress } from '../../libraries/shared/sync-panel-model.js';

/**
 * Тосты синхронизации — пока идёт проход, в углу экрана (наши плавающие плашки, [notifications.js](notifications.js), не родные
 * уведомления ST) живёт ОДНА плашка с ходом («Syncing with Phone: 3/12 — file.jsonl»); по окончании она сменяется итогом.
 * Ядро только слушает события Ядра синхронизации (`sync.progress`, `sync.finished`) и просит Ядро уведомлений показать/убрать
 * плашку контрактами `ui.notify` / `ui.notify.dismiss`; своего DOM и своих таймеров у него нет.
 *
 * Молчит, когда сказать нечего: проход по расписанию, который ничего не сдвинул, плашек не рисует вовсе (иначе каждые N минут
 * мигало бы «всё актуально»). Итог показывается, если проход запускал сам пользователь, что-то передалось или что-то сломалось.
 * Пока открыт экран загрузки, тостов нет — ход синхронизации показывает он.
 */

const PROGRESS_KEY = 'sync-progress';
const MANUAL_TARGETS = new Set(['all', 'peers', 'github', 'cloud']);
const RESULT_MS = 6000;
const PROBLEM_MS = 10000;

const moved = counts => Boolean(counts && (counts.pushed || counts.pulled || counts.deletedLocal || counts.deletedRemote || counts.conflicts));

/** Сдвинул ли проход хоть один файл (по любой стороне). */
export function passMovedFiles(last) {
    return Boolean(last?.peers?.some(peer => moved(peer.counts)) || moved(last?.github?.counts) || moved(last?.cloud?.counts));
}

/** Итог → `{ tone, text }` для плашки или `null`, если показывать нечего. */
export function describeResultToast(last, { now = Date.now() } = {}) {
    if (!last || last.outcome === 'busy') return null;
    const view = describeLastRun(last, now);
    const problem = view.tone === 'error' || view.tone === 'warn';
    if (!(MANUAL_TARGETS.has(last.target) || passMovedFiles(last) || problem)) return null;
    const lines = view.lines.filter(line => !/(ago|just now)$/.test(line)).slice(0, 3);
    if (!lines.length) return null;
    return { tone: problem ? 'error' : 'ok', text: lines.join(' · '), timeoutMs: problem ? PROBLEM_MS : RESULT_MS };
}

export function createSyncToastsCore(host, { isBootActive = () => false, now = () => Date.now(), throttleMs = 400 } = {}) {
    const call = (contract, params) => request(host.own, contract, { params }).catch(() => {});
    let shown = false;
    let lastShownAt = 0;
    let lastText = '';

    const dismissProgress = async () => {
        if (!shown) return;
        shown = false;
        lastText = '';
        await call('ui.notify.dismiss', { key: PROGRESS_KEY });
    };

    const subscriptions = [
        host.events.subscribe('sync.progress', async payload => {
            const view = describeProgress(payload?.progress);
            if (!view) { await dismissProgress(); return; }
            // Пустой проход (0 файлов к передаче) плашки не заслуживает; «connecting» — заслуживает: пользователь нажал кнопку и ждёт.
            const total = payload.progress.total || 0;
            if (payload.progress.phase !== 'connecting' && !(total > 0)) return;
            if (isBootActive()) return;
            const time = now();
            if (shown && view.label === lastText) return;
            if (shown && time - lastShownAt < throttleMs) return;
            shown = true;
            lastShownAt = time;
            lastText = view.label;
            await call('ui.notify', { key: PROGRESS_KEY, sticky: true, tone: 'muted', text: view.label });
        }),
        // Пресеты/темы записаны в файлы, но ST держит их списки в памяти — без перезагрузки страницы новых не увидит.
        host.events.subscribe('sync.reloadHint', async () => {
            if (isBootActive()) return;
            await call('ui.notify', { key: 'sync-reload', tone: 'muted', text: 'Sync updated presets or themes — reload the page to see them.', timeoutMs: 12000 });
        }),
        host.events.subscribe('sync.finished', async last => {
            await dismissProgress();
            if (isBootActive()) return;
            const toast = describeResultToast(last, { now: now() });
            if (toast) await call('ui.notify', toast);
        }),
    ];

    return { stop: () => { for (const off of subscriptions) off?.(); } };
}
