/**
 * Экран первой загрузки движка — стадии старта на одном экране: проверка обновления, при необходимости скачивание и
 * перезапуск. Рисуется поверх родного сплеша SillyTavern (он под ним скрывается) в том же оформлении «ST × ME» (см. блок
 * «Экран загрузки ST» в style.css) и держится, пока идёт ход самообновления, но не дольше страховочных пределов:
 * если сеть молчит, экран не должен блокировать интерфейс.
 *
 * Модуль умеет только показывать стадии (`setStage`) и закрываться (`finish`). Что за стадия — решает тот, кто его вызывает
 * (см. `wireBootScreen` ниже и подписку в index.js): экран не знает про git и про события Ядра самообновления.
 */

const ACTIVE_CLASS = 'stme-boot-active';
const CHECK_TIMEOUT_MS = 9000;   // проверка не отвечает — не держим интерфейс
const UPDATE_TIMEOUT_MS = 90000; // скачивание может быть долгим, но не вечным
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
});

export function createBootScreen(doc = globalThis.document) {
    if (!doc?.body || !doc.documentElement) return null;
    const root = doc.createElement('div');
    root.className = 'stme-boot';
    root.setAttribute('role', 'status');
    root.innerHTML = '<div class="stme-boot-brand"><img class="stme-boot-st" src="/img/logo.png" alt="SillyTavern"><span class="stme-boot-times">×</span>'
        + `<img class="stme-boot-me" src="${ME_LOGO_URL}" alt="ModuleEngine"></div>`
        + '<div class="stme-boot-track"><div class="stme-boot-fill"></div></div>'
        + '<div class="stme-boot-stage"></div>';
    const fill = root.querySelector('.stme-boot-fill');
    const stage = root.querySelector('.stme-boot-stage');
    doc.documentElement.classList.add(ACTIVE_CLASS);
    doc.body.append(root);

    let timer = null;
    let closed = false;

    function setStage(name, { timeoutMs } = {}) {
        if (closed) return;
        const spec = BOOT_STAGES[name] ?? BOOT_STAGES.starting;
        stage.textContent = spec.text;
        stage.dataset.stage = name;
        fill.style.transform = `scaleX(${spec.progress})`;
        root.dataset.stage = name;
        clearTimeout(timer);
        if (timeoutMs) timer = setTimeout(() => finish(), timeoutMs);
    }

    /** Закрывает экран (плавно). `afterMs` — сколько показать итоговую стадию перед закрытием. */
    function finish({ afterMs = 0 } = {}) {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        setTimeout(() => {
            root.classList.add('stme-boot-out');
            setTimeout(() => { root.remove(); doc.documentElement.classList.remove(ACTIVE_CLASS); }, FADE_MS);
        }, afterMs);
    }

    setStage('starting', { timeoutMs: UPDATE_TIMEOUT_MS });
    return { setStage, finish, root, isClosed: () => closed };
}

/**
 * Связывает экран с событиями самообновления (`events.subscribe(name, handler)`). Возвращает функцию отписки.
 * checking → (свежо: коротко «Up to date» и закрыться) | (нашли: «Downloading» до перезагрузки) | (не вышло: коротко и закрыться).
 */
export function wireBootScreen(screen, events) {
    if (!screen || !events?.subscribe) return () => {};
    const subs = [
        events.subscribe('selfUpdate.checking', () => screen.setStage('checking', { timeoutMs: CHECK_TIMEOUT_MS })),
        events.subscribe('selfUpdate.upToDate', () => { screen.setStage('upToDate'); screen.finish({ afterMs: 450 }); }),
        events.subscribe('selfUpdate.started', () => screen.setStage('downloading', { timeoutMs: UPDATE_TIMEOUT_MS })),
        events.subscribe('selfUpdate.applied', () => screen.setStage('installed', { timeoutMs: UPDATE_TIMEOUT_MS })),
        events.subscribe('selfUpdate.failed', () => { screen.setStage('failed'); screen.finish({ afterMs: 1400 }); }),
        // Ход закончился без «свежо/сбой» (не git-установка, пауза после попытки) — сказать нечего, закрываемся сразу.
        events.subscribe('selfUpdate.finished', payload => { if (payload?.outcome !== 'updated') screen.finish({ afterMs: 120 }); }),
    ];
    return () => { for (const off of subs) off?.(); };
}
