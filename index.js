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
 * click way in is a persistent top-bar icon (`addTopBarLauncher()` below) —
 * mirrors Alpha's own `addTopBarLauncher()` in Alpha/index.js exactly (same
 * insertion point, same fallback chain) — expanding the drawer first just
 * to find a button was never the actual intended path, it stays only as a
 * safety net if the top-bar insertion ever fails on some ST build.
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
 * A persistent icon in ST's own top-right icon row, next to its native ones
 * — copied verbatim from Alpha/index.js's own `addTopBarLauncher()` (same
 * insertion point, same fallback chain, same reasoning: ST has no plugin
 * API for adding a top-level icon, so extensions that want one insert into
 * the real row directly). A distinct icon (flask, not Alpha's layer-group)
 * so the two are visually distinguishable if both happen to be installed.
 */
function addTopBarLauncher(panel) {
    const launcher = document.createElement('div');
    launcher.className = 'drawer';
    launcher.innerHTML = `
        <div class="drawer-toggle drawer-header" title="Open ST Module Engine (Beta)" data-i18n="[title]Open ST Module Engine (Beta)">
            <div class="drawer-icon fa-solid fa-flask fa-fw"></div>
        </div>`;
    launcher.addEventListener('click', () => panel.toggle());

    const sibling = document.getElementById('rightNavHolder') ?? document.getElementById('top-settings-holder');
    if (sibling) { sibling.after(launcher); return; }
    const bar = document.getElementById('top-bar');
    if (bar) { bar.append(launcher); return; }
    console.warn('[ST Module Engine (Beta)] Could not find a top-bar container to attach the launcher icon to — the panel is still reachable via the extensions drawer button.');
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
    addTopBarLauncher(panel);

    window.STModuleEngineBeta = engine;
    console.info('[ST Module Engine (Beta)] Verification panel ready — open it from the top-bar icon.');
}

jQuery(async () => {
    try { await init(); }
    catch (error) { console.error('[ST Module Engine (Beta)] Failed to start:', error); }
});
