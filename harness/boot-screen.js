/**
 * Экран первой загрузки движка — стадии старта на одном экране: проверка обновления, при необходимости скачивание и
 * перезапуск. Рисуется поверх родного сплеша SillyTavern (он под ним скрывается) в том же оформлении «ST × ME» (см. блок
 * «Экран загрузки ST» в style.css) и держится, пока идёт ход самообновления, но не дольше страховочных пределов:
 * если сеть молчит, экран не должен блокировать интерфейс.
 *
 * Модуль умеет только показывать стадии (`setStage`) и закрываться (`finish`). Что за стадия — решает тот, кто его вызывает
 * (см. `wireBootScreen` ниже и подписку в index.js): экран не знает про git и про события Ядра самообновления.
 */

import { describeProgress } from '../libraries/shared/sync-panel-model.js';

const ACTIVE_CLASS = 'stme-boot-active';
const CHECK_TIMEOUT_MS = 9000;   // проверка не отвечает — не держим интерфейс
const UPDATE_TIMEOUT_MS = 90000; // скачивание может быть долгим, но не вечным
const SYNC_IDLE_TIMEOUT_MS = 25000; // синхронизация при загрузке: если ход стоит дольше — отпускаем интерфейс, она дойдёт в фоне
const FADE_MS = 450;

const ME_LOGO_URL = typeof import.meta !== 'undefined' && import.meta.url ? new URL('../assets/me-logo.webp', import.meta.url).href : '';

/** Стадии по ходу самообновления: подпись и доля шкалы. Чистые данные — для теста и единого словаря текстов. */
export const BOOT_STAGES = Object.freeze({
    starting: { text: 'Loading', progress: 0.08 },
    checking: { text: 'Checking for updates', progress: 0.3 },
    upToDate: { text: 'Up to date', progress: 1 },
    downloading: { text: 'Downloading update', progress: 0.65 },
    installed: { text: 'Update installed · restarting', progress: 1 },
    failed: { text: 'Update failed · continuing', progress: 1 },
    syncing: { text: 'Syncing your files', progress: 0.85 },
    syncDone: { text: 'Synced', progress: 1 },
});

export function createBootScreen(doc = globalThis.document) {
    if (!doc?.body || !doc.documentElement) return null;
    const root = doc.createElement('div');
    root.className = 'stme-boot';
    root.setAttribute('role', 'status');
    root.innerHTML = '<div class="stme-boot-brand"><img class="stme-boot-st" src="/img/logo.png" alt="SillyTavern"><span class="stme-boot-times">×</span>'
        + `<img class="stme-boot-me" src="${ME_LOGO_URL}" alt="ModuleEngine"></div>`
        + '<div class="stme-boot-track"><div class="stme-boot-fill"></div></div>'
        + '<div class="stme-boot-stage"></div>'
        + '<button type="button" class="stme-boot-skip" hidden>Continue in the background</button>';
    const fill = root.querySelector('.stme-boot-fill');
    const stage = root.querySelector('.stme-boot-stage');
    const skip = root.querySelector('.stme-boot-skip');
    doc.documentElement.classList.add(ACTIVE_CLASS);
    doc.body.append(root);

    let timer = null;
    let closed = false;

    /** `text`/`progress` — свои подпись и доля шкалы поверх заготовки стадии (ход синхронизации: «Syncing with Phone: 3/12»). */
    function setStage(name, { timeoutMs, text, progress } = {}) {
        if (closed) return;
        const spec = BOOT_STAGES[name] ?? BOOT_STAGES.starting;
        stage.textContent = text ?? spec.text;
        stage.dataset.stage = name;
        fill.style.transform = `scaleX(${progress ?? spec.progress})`;
        // «Продолжить в фоне» — только пока идёт синхронизация: интерфейс нельзя держать ради неё бесконечно.
        skip.hidden = name !== 'syncing';
        root.dataset.stage = name;
        clearTimeout(timer);
        if (timeoutMs) timer = setTimeout(() => finish(), timeoutMs);
    }

    /** Родной сплеш ST ещё может жить (его `hideOverlay` заканчивается позже нас): класс, прячущий его, снимаем, только когда он исчез, — иначе он мелькнул бы под уходящим экраном. Не дольше 2 с. */
    function releaseSplash(tries = 0) {
        if (doc.getElementById?.('loader') && tries < 20) { setTimeout(() => releaseSplash(tries + 1), 100); return; }
        doc.documentElement.classList.remove(ACTIVE_CLASS);
    }

    /** Закрывает экран (плавно). `afterMs` — сколько показать итоговую стадию перед закрытием. */
    function finish({ afterMs = 0 } = {}) {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        setTimeout(() => {
            root.classList.add('stme-boot-out');
            setTimeout(() => { root.remove(); releaseSplash(); }, FADE_MS);
        }, afterMs);
    }

    skip.addEventListener('click', () => finish());
    setStage('starting', { timeoutMs: UPDATE_TIMEOUT_MS });
    return { setStage, finish, root, isClosed: () => closed };
}

/**
 * Связывает экран с событиями самообновления (`events.subscribe(name, handler)`). Возвращает функцию отписки.
 * checking → (свежо: коротко «Up to date» и закрыться) | (нашли: «Downloading» до перезагрузки) | (не вышло: коротко и закрыться).
 *
 * `holdForSync` — после самообновления (если страница не перезагружается) экран НЕ закрывается, а переходит в стадию «Syncing your files»,
 * идёт вместе с ходом синхронизации (`sync.progress`) и закрывается по `sync.finished`. Не дольше `SYNC_IDLE_TIMEOUT_MS` без движения и
 * не дольше, чем захочет пользователь (кнопка «Continue in the background»): синхронизация при этом продолжается в фоне, а ход
 * показывают тосты.
 */
export function wireBootScreen(screen, events, { holdForSync = false } = {}) {
    if (!screen || !events?.subscribe) return () => {};
    let holding = holdForSync;
    let inSync = false;
    const enterSync = () => { inSync = true; screen.setStage('syncing', { timeoutMs: SYNC_IDLE_TIMEOUT_MS }); };
    /** Самообновление закончилось без перезагрузки: либо переходим к синхронизации, либо закрываемся. */
    const afterUpdate = afterMs => { if (holding) enterSync(); else screen.finish({ afterMs }); };
    const subs = [
        events.subscribe('selfUpdate.checking', () => screen.setStage('checking', { timeoutMs: CHECK_TIMEOUT_MS })),
        events.subscribe('selfUpdate.upToDate', () => { screen.setStage('upToDate'); afterUpdate(450); }),
        events.subscribe('selfUpdate.started', () => screen.setStage('downloading', { timeoutMs: UPDATE_TIMEOUT_MS })),
        events.subscribe('selfUpdate.applied', () => screen.setStage('installed', { timeoutMs: UPDATE_TIMEOUT_MS })),
        events.subscribe('selfUpdate.failed', () => { screen.setStage('failed'); afterUpdate(1400); }),
        // Ход закончился без «свежо/сбой» (не git-установка, пауза после попытки) — сказать нечего, закрываемся сразу.
        events.subscribe('selfUpdate.finished', payload => { if (payload?.outcome !== 'updated') afterUpdate(120); }),
        events.subscribe('sync.progress', payload => {
            if (!holding || !inSync) return;
            const view = describeProgress(payload?.progress);
            if (view) screen.setStage('syncing', { text: view.label, progress: 0.7 + 0.28 * (view.percent / 100), timeoutMs: SYNC_IDLE_TIMEOUT_MS });
        }),
        events.subscribe('sync.finished', () => {
            if (!holding) return;
            holding = false;
            screen.setStage('syncDone');
            screen.finish({ afterMs: 500 });
        }),
    ];
    return () => { for (const off of subs) off?.(); };
}
