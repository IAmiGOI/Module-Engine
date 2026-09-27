/**
 * SillyTavern's own drawers (API Connections, World Info, Preset…) close themselves on ANY click that isn't on them. Found live, by
 * reading the real handler (a first attempt at this guard listened for `click` on `document` and did nothing — WRONG event entirely):
 * the actual code is `$('html').on('touchstart mousedown', …)` in `script.js` — bound to `mousedown`/`touchstart` on `<html>`, which
 * fire and finish BEFORE `click` ever does (mousedown → mouseup → click) — every open `.openDrawer` that isn't `.pinnedOpen` closes the
 * moment the mouse goes DOWN outside it, well before a `click` listener would even see the event. A press anywhere in the engine's own
 * UI (the panel, the guide's chat window) is "elsewhere" to that handler too, so a native drawer opened to show the guide would close
 * the instant the user pressed back into her chat.
 *
 * Cannot fix this by stopping the event from bubbling to `document`: our OWN "click outside closes X" spots (`cores/ui/input-bar/left-dock.js`,
 * `cores/ui/launcher-dock.js`) listen on that SAME `document`, and swallowing it there would silently break them too.
 *
 * Instead this rides ST's OWN escape hatch — `.pinnedOpen` is the exact class its handler already skips, and it carries no CSS of its own
 * (checked: nothing in ST's stylesheets keys off it), so adding it changes no drawer's appearance. A `mousedown`/`touchstart` listener on
 * `document` in the CAPTURE phase runs before ST's own (bubble-phase, on `<html>`, a DESCENDANT of `document`) listener sees the SAME
 * event, regardless of which one was attached first — capture always finishes, top-down, before bubble starts. So on every press this
 * decides fresh: press landed inside our own UI → pin every open drawer for this instant, so ST's handler (running right after) skips
 * them; press landed anywhere else → unpin whatever WE pinned, so a genuine outside press still closes the drawer exactly like stock ST.
 * Drawers we didn't pin ourselves are left alone either way.
 */
/**
 * Every top-level root the engine appends to `document.body`, verified live (not guessed from source): the settings/engine panel
 * (`.stmeBeta-fullscreen`), the guide's own chat window (`.stme-guide-root` — NOT `.stme-floating-panel`; the guide window turned out
 * not to use that shared widget's wrapper class at all), the home-screen canvas and its widgets (`.stme-home`, which contains every
 * `.stme-home-block` — a per-widget class would have needed updating for every new widget kind), the launcher dock
 * (`.stme-launcher-dock-zone`), and `.stme-floating` for the other DockButton-positioned panels (picture, memory graph).
 */
const OUR_UI_SELECTOR = '.stmeBeta-fullscreen, .stme-guide-root, .stme-home, .stme-launcher-dock-zone, .stme-floating';
const AUTOPIN_FLAG = 'stmeAutopin';

/** Same two event types ST itself listens for on `<html>` — matching only `click` would miss the actual moment ST decides to close. */
const GUARDED_EVENTS = Object.freeze(['mousedown', 'touchstart']);

export function registerStDrawerGuard(bus, { documentRef = () => document, selector = OUR_UI_SELECTOR, events = GUARDED_EVENTS } = {}) {
    let listening = false;

    function onPress(event) {
        const doc = documentRef();
        const insideOurUi = Boolean(event.target?.closest?.(selector));
        for (const drawer of doc.querySelectorAll('.openDrawer')) {
            if (insideOurUi) {
                if (!drawer.classList.contains('pinnedOpen')) { drawer.classList.add('pinnedOpen'); drawer.dataset[AUTOPIN_FLAG] = 'true'; }
            } else if (drawer.dataset[AUTOPIN_FLAG] === 'true') {
                drawer.classList.remove('pinnedOpen');
                delete drawer.dataset[AUTOPIN_FLAG];
            }
        }
    }

    function install() {
        if (listening) return true;
        for (const type of events) documentRef().addEventListener(type, onPress, { capture: true });
        listening = true;
        return true;
    }

    function uninstall() {
        if (!listening) return true;
        for (const type of events) documentRef().removeEventListener(type, onPress, { capture: true });
        listening = false;
        return true;
    }

    const unregister = [
        bus.register('stDrawerGuard.install', () => install()),
        bus.register('stDrawerGuard.uninstall', () => uninstall()),
    ];
    return { install, uninstall, unregister: () => unregister.forEach(off => off()) };
}
