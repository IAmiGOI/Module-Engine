import { wireEngine } from './harness/engine-wiring.js';
import { createFullScreenPanel } from './harness/full-screen-panel.js';

/**
 * Real SillyTavern entry point — verification-only, NOT the real Раннер
 * from ARCHITECTURE.md/ROADMAP.md (that one still needs generic Module
 * loading and a real semver/compatibility gate). This exists so the
 * built Ядра/Сервисы can be exercised inside a real ST page, against real
 * `chatMetadata`/`extensionSettings`/`fetch` — showing the SAME engine panel
 * proven in the standalone browser harness ([harness/index.html](harness/index.html)),
 * mounted verbatim from [cores/ui/engine-panel.js](cores/ui/engine-panel.js), so
 * the two never drift apart.
 *
 * The extensions drawer itself (a narrow sidebar) stays down to one line +
 * a fallback button — the actual panel opens as a page-width overlay
 * instead (see [harness/full-screen-panel.js](harness/full-screen-panel.js)),
 * same shape as Alpha's own full-screen panel and for the same reason:
 * several rows of fields simply don't fit a narrow drawer. The REAL, one-
 * click way in is a persistent floating launcher dock (`addLauncherDock()`
 * below), not a top-bar icon — see that function's own doc-comment for why.
 */

const DRAWER_HTML = `
<div id="stme_beta" class="stmeBeta-drawer">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>ST Module Engine (Beta) — engine panel</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
        </div>
        <div class="inline-drawer-content">
            <p><small>Opens a full-width engine panel with a button for every built Core.</small></p>
            <button type="button" class="menu_button" id="stmeBetaOpenPanel">Open engine panel</button>
        </div>
    </div>
</div>`;

function getContext() {
    if (!window.SillyTavern?.getContext) throw new Error('SillyTavern context API is unavailable.');
    return window.SillyTavern.getContext();
}

/**
 * A persistent floating launcher, fixed to the right edge of the viewport —
 * NOT inserted into ST's own top-bar. Used to be a `.drawer` icon appended
 * next to `#rightNavHolder`/inside `#top-bar` (same shape as Alpha's own
 * `addTopBarLauncher()`), but that made it disappear completely under the
 * popular third-party extension "SillyTavern-ProbablyTooManyTabs": its own
 * `style.css` sets `#top-bar, #top-settings-holder { display: none !important; }`
 * UNCONDITIONALLY (checked against its real source, not just its README) —
 * the whole container is hidden, not filtered by content, so nothing placed
 * there survives, regardless of id/class. A `position: fixed` element on
 * `<body>` doesn't depend on that container at all, so the SAME code shows
 * the SAME launcher whether or not that extension (or any other that
 * reorganizes the top bar) is installed.
 *
 * Five icon-sized slots by height, one of them real (`stme-launcher-dock-btn`,
 * opens the panel) — the rest are empty `stme-launcher-dock-slot`s reserved
 * for future quick actions, kept the same visual size so the dock's shape
 * doesn't change when a second real action arrives.
 */
function addLauncherDock(panel) {
    if (document.getElementById('stmeBetaLauncherDock')) return;
    const dock = document.createElement('div');
    dock.id = 'stmeBetaLauncherDock';
    dock.className = 'stme-launcher-dock';
    dock.innerHTML = `
        <button type="button" class="stme-launcher-dock-btn" title="Open ST Module Engine (Beta)" data-i18n="[title]Open ST Module Engine (Beta)">
            <i class="fa-solid fa-flask fa-fw"></i>
        </button>
        <div class="stme-launcher-dock-slot" aria-hidden="true"></div>
        <div class="stme-launcher-dock-slot" aria-hidden="true"></div>
        <div class="stme-launcher-dock-slot" aria-hidden="true"></div>
        <div class="stme-launcher-dock-slot" aria-hidden="true"></div>`;
    dock.querySelector('button').addEventListener('click', () => panel.toggle());
    document.body.append(dock);
}

async function init() {
    // `scriptUrl` — адрес ИМЕННО этого файла: из него берётся имя папки
    // расширения, которого ждут git-эндпоинты ST. Передаём явно, потому что
    // сборщик движка лежит в другой папке, и его собственный `import.meta.url`
    // дал бы не то имя.
    const { engine, panelUi, selfUpdate } = await wireEngine({
        getContext,
        fetch: window.fetch.bind(window),
        scriptUrl: import.meta.url,
    });

    // Обновление запускается РАНЬШЕ интерфейса: если мы отстали, страница всё
    // равно перезагрузится, и строить панель дважды незачем. Ход молчит, когда
    // сказать нечего — не git-установка, нет сети, уже свежее.
    // Итог хода печатается ВСЕГДА. «Молчит, когда сказать нечего» задумывалось
    // против шума в интерфейсе, а не против диагностики: без строчки в консоли
    // отличить работающее самообновление от сломанного было нечем.
    selfUpdate.run()
        .then(result => console.info('[ST Module Engine (Beta)] Self-update:', result?.outcome ?? 'no result', result?.reason ?? result?.error ?? ''))
        .catch(error => console.warn('[ST Module Engine (Beta)] Self-update skipped:', error));

    const target = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!target) throw new Error('SillyTavern extensions settings container was not found.');
    if (!document.getElementById('stme_beta')) target.insertAdjacentHTML('beforeend', DRAWER_HTML);

    const panel = createFullScreenPanel({ title: 'ST Module Engine' });
    panel.body.append(panelUi.getRoot());

    document.getElementById('stmeBetaOpenPanel').addEventListener('click', () => panel.open());
    addLauncherDock(panel);

    window.STModuleEngineBeta = engine;
    console.info('[ST Module Engine (Beta)] Verification panel ready — open it from the floating launcher dock.');
}

jQuery(async () => {
    try { await init(); }
    catch (error) { console.error('[ST Module Engine (Beta)] Failed to start:', error); }
});
