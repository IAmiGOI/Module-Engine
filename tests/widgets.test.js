import test from 'node:test';
import assert from 'node:assert/strict';
import { signal, computed } from '../cores/ui/reactive.js';
import { Button, TextInput, Select, Slider, Toggle, Field, Row, Card, Section, Badge, EmptyState, List, TwoColumn, EditableList, FloatingPanel, StatBlock, ProgressBar, HoldButton, DockButton, EdgeDrawer, IconButton, Avatar, Timestamp, MessageHeader, MessageActionsRow, ReasoningBlock } from '../libraries/shared/widgets.js';

/**
 * Виджеты — чистые функции «данные → дерево», поэтому проверяются как
 * данные: без DOM, без шины, без браузера. Ровно то, ради чего Ядро UI
 * держит абстрактное дерево отдельно от его применения.
 */

test('Button() carries ST\'s own menu_button class and wires its click handler', () => {
    let clicked = 0;
    const node = Button('Save', () => { clicked += 1; });

    assert.equal(node.tag, 'button');
    assert.equal(node.props.class, 'menu_button');
    assert.equal(node.props.type, 'button');
    node.props['on:click']();
    assert.equal(clicked, 1);
});

test('Button() with the danger variant is visually marked, not silently identical', () => {
    assert.match(Button('Remove', () => {}, { variant: 'danger' }).props.class, /stme-danger/);
});

test('TextInput() binds BOTH ways — the signal drives value, and typing writes back', () => {
    const value = signal('hello');
    const node = TextInput(value, { placeholder: 'endpoint' });

    assert.equal(node.props.value, value, 'the signal itself is passed as the prop — diff.js resolves it');
    assert.equal(node.props.placeholder, 'endpoint');

    node.props['on:input']({ target: { value: 'typed' } });
    assert.equal(value(), 'typed');
});

test('TextInput() can be a password field, so an API key is not shown in the clear', () => {
    assert.equal(TextInput(signal(''), { type: 'password' }).props.type, 'password');
});

test('Select() renders one keyed option per choice and marks the selected one on the OPTION itself', () => {
    const value = signal('anthropic');
    const node = Select(value, [{ value: 'openai', label: 'OpenAI' }, { value: 'anthropic', label: 'Anthropic' }]);

    const options = node.children[0]();
    assert.deepEqual(options.map(option => option.props.key), ['openai', 'anthropic']);
    assert.equal(options[0].props.selected(), false);
    assert.equal(options[1].props.selected(), true, 'selection lives on the option — props are set before children exist');
});

test('Select() writes the picked value back to the signal', () => {
    const value = signal('openai');
    const node = Select(value, [{ value: 'openai' }, { value: 'google' }]);

    node.props['on:change']({ target: { value: 'google' } });

    assert.equal(value(), 'google');
});

test('Select() calls onChange too — a preset picker needs to fill OTHER fields, not just remember its own choice', () => {
    const value = signal('');
    const seen = [];
    const node = Select(value, [{ value: 'precise' }, { value: 'creative' }], { onChange: picked => seen.push(picked) });

    node.props['on:change']({ target: { value: 'creative' } });

    assert.equal(value(), 'creative');
    assert.deepEqual(seen, ['creative']);
});

test('Field() puts the label and the control together, and drops an absent hint entirely', () => {
    const withHint = Field('Endpoint', TextInput(signal('')), { hint: 'https://…' });
    const without = Field('Endpoint', TextInput(signal('')));

    assert.equal(withHint.children[0].children.length, 2);
    assert.equal(without.children[0].children.length, 1, 'no empty hint node is left behind');
});

test('Field() accepts a SIGNAL hint that keeps following its source — the field itself is never rebuilt when only that signal changes', () => {
    const chosen = signal('');
    const hint = computed(() => (chosen() ? `You picked ${chosen()}` : ''));
    const field = Field('Preset', TextInput(signal('')), { hint });

    const hintNode = field.children[0].children[1];
    assert.equal(typeof hintNode, 'function', 'a signal-valued hint stays reactive, not resolved once at build time');
    assert.equal(hintNode(), null, 'nothing chosen yet — no hint node at all');

    chosen.set('Creative');

    assert.equal(hintNode().children[0], 'You picked Creative');
});

test('Card() keeps its key for list reconciliation and renders actions only when given', () => {
    const withActions = Card('Worker', { key: 'w1', actions: [Button('Test', () => {})] }, Row());
    const plain = Card('Worker', {}, Row());

    assert.equal(withActions.props.key, 'w1');
    assert.equal(withActions.children[0].children.length, 2);
    assert.equal(plain.children[0].children.length, 1);
});

test('List() re-derives its items from the signal, so adding one shows up', () => {
    const items = signal([{ id: 'a' }]);
    const list = List(items, item => Badge(item.id, {}));

    assert.equal(list().length, 1);
    items.set([{ id: 'a' }, { id: 'b' }]);
    assert.equal(list().length, 2);
});

test('TwoColumn() is exactly two columns — the shape the engine panel splits itself with', () => {
    const node = TwoColumn({ left: EmptyState('left'), right: EmptyState('right') });

    assert.equal(node.children.length, 2);
    assert.equal(node.children[0].props.class, 'stme-column');
});

test('EditableList() shows the empty text when there is nothing, and the rows when there is', () => {
    const items = signal([]);
    const node = EditableList({ items, renderItem: item => Badge(item.id, {}), onAdd: () => {}, empty: 'No workers yet.' });
    const body = node.children[0];

    assert.equal(body()[0].children[0], 'No workers yet.');
    items.set([{ id: 'a' }]);
    assert.equal(body()[0].tag, 'span', 'now it renders the real rows instead');
});

test('EditableList() without onAdd renders no add button — a read-only list is a legitimate use', () => {
    const node = EditableList({ items: signal([]), renderItem: () => Badge('x', {}) });

    assert.equal(node.children.filter(Boolean).length, 1);
});

test('Slider() keeps its signal NUMERIC — a range input hands back a string, and "every: \'5\'" would reach the Директор as text', () => {
    const value = signal(3);
    const node = Slider('Every N replies', value, { min: 1, max: 50 });

    const input = node.children.find(child => child?.tag === 'input');
    input.props['on:input']({ target: { value: '7' } });

    assert.equal(value(), 7);
    assert.equal(typeof value(), 'number');
    assert.equal(input.props.min, 1);
    assert.equal(input.props.max, 50);
});

test('Slider() shows the live value next to its label, so the number is readable without dragging', () => {
    const value = signal(12);
    const node = Slider('Every N minutes', value);

    const head = node.children.find(child => child?.props?.class === 'stme-slider-head');
    assert.equal(head.children.at(-1).children[0], value, 'the signal itself feeds the <output>');
});

test('Toggle() is a real switch — the checkbox stays the source of truth, the track is only what you see', () => {
    const on = signal(false);
    let observed = null;
    const node = Toggle('Enabled', on, { onChange: value => { observed = value; } });

    assert.equal(node.props.class, 'stme-switch');
    const input = node.children.find(child => child?.tag === 'input');
    assert.equal(input.props.checked, on, 'state comes from the signal, not from a duplicated class');
    input.props['on:change']({ target: { checked: true } });
    assert.equal(on(), true);
    assert.equal(observed, true);
});

test('Section() is FLAT — no frame of its own, because only the top-level Card draws one', () => {
    const node = Section('status', { actions: [Button('Remove', () => {})] }, 'body');

    assert.equal(node.props.class, 'stme-section');
    assert.notEqual(node.props.class, 'stme-card', 'a Section must never render as a Card — that is the nested-frame problem');
});

test('Card() and Section() are collapsible for real — a native <details>/<summary>, not a hand-rolled hidden flag', () => {
    for (const node of [Card('Engine', {}, 'body'), Section('status', {}, 'body')]) {
        assert.equal(node.tag, 'details');
        assert.equal(node.props.open, false, 'collapsed by default — the whole panel does not fit on one screen');
        assert.equal(node.children[0].tag, 'summary', 'the header IS the collapse control');
    }
});

test('Card() opens when the caller says so, and reports its own toggling back', () => {
    assert.equal(Card('Engine', { open: true }, 'body').props.open, true);

    let reported = null;
    const node = Card('Engine', { open: false, onToggle: value => { reported = value; } }, 'body');
    node.props['on:toggle']({ target: { open: true } });
    assert.equal(reported, true, 'without this the panel could never learn what the user folded');
});

test('a click on a header action does NOT collapse the card — <summary> toggles on any click on itself', () => {
    let saved = 0;
    const node = Card('Model connections', { actions: [Button('Save', () => { saved += 1; })] }, 'body');

    const actions = node.children[0].children.find(child => child?.props?.class === 'stme-card-actions');
    let stopped = false;
    actions.props['on:click']({ stopPropagation: () => { stopped = true; } });

    assert.equal(stopped, true, 'without this, pressing Save would also fold the card shut');
    assert.equal(saved, 0, 'the wrapper only stops bubbling; the button keeps its own handler');
});

test('a header puts the title BEFORE the actions, in that order — the stylesheet anchors buttons by column position', () => {
    const node = Card('Modules', { subtitle: 'What you plug in yourself', actions: [Button('Enable', () => {})] }, 'body');
    const head = node.children[0];

    assert.deepEqual(head.children.map(child => child?.props?.class), ['stme-card-title', 'stme-card-actions']);
});

test('FloatingPanel() offers both collapse and close — a window you cannot put away is worse than no window', () => {
    const node = FloatingPanel('Tracked state', { collapsed: signal(false), onToggle: () => {}, onClose: () => {} }, 'body');
    const head = node.children[0];

    const buttons = head.children.filter(child => child?.tag === 'button');
    assert.equal(buttons.length, 2);
    assert.ok(head.children.some(child => child?.props?.class === 'stme-floating-panel-grip'), 'and a visible grip, so it is obvious it can be dragged');
});

test('FloatingPanel() writes NO width/height when none is set — the browser owns the size, and a re-render must not undo a resize', () => {
    const node = FloatingPanel('Tracked state', { position: signal({ left: 20, top: 30 }), size: signal({}) }, 'body');

    assert.deepEqual(node.props.style(), { left: '20px', top: '30px', resize: 'none' });
});

test('FloatingPanel() applies a stored size when there is one', () => {
    const node = FloatingPanel('T', { position: signal({}), size: signal({ width: 300, height: 200 }) }, 'body');

    assert.deepEqual(node.props.style(), { width: '300px', height: '200px', resize: 'none' });
});

test('FloatingPanel() carries an extra className alongside its base class, for a per-instance CSS variant', () => {
    const node = FloatingPanel('Map', { className: 'stme-floating-panel--map' }, 'body');
    assert.equal(node.props.class, 'stme-floating-panel stme-floating-panel--map');
});

test('FloatingPanel() ALWAYS enforces minWidth/minHeight, even before any resize — unlike width/height, which stay unset until the user actually resizes', () => {
    const node = FloatingPanel('Map', { position: signal({}), size: signal({}), minWidth: 640, minHeight: 480 }, 'body');
    assert.deepEqual(node.props.style(), { minWidth: '640px', minHeight: '480px', resize: 'none' });
});

test('FloatingPanel() without onResize is immutable — inline resize:none kills the CSS grip and no size is ever persisted', () => {
    const node = FloatingPanel('Music', { position: signal({}), size: signal({}) }, 'body');

    assert.equal(node.props.style().resize, 'none');
    assert.equal(node.props['on:pointerup'], undefined);
});

test('FloatingPanel() with onResize but resizable:false is ALSO immutable — the caller decides, not the presence of the callback', () => {
    const node = FloatingPanel('Music', { onResize: () => {}, resizable: false }, 'body');

    assert.equal(node.props.style().resize, 'none');
    assert.equal(node.props['on:pointerup'], undefined);
});

test('FloatingPanel() pointerup does NOT persist the size while collapsed — the CSS has squashed the window to the header height, and saving it would shrink the expanded window to a header (caught live: expanded window stayed header-sized after un-collapse)', () => {
    const saved = [];
    const collapsed = signal(true);
    const node = FloatingPanel('T', {
        collapsed,
        onToggle: () => {},
        onResize: next => saved.push(next),
        resizable: true,
    }, 'body');

    // Свёрнуто: клик по кнопке «+» (pointerup раньше click) — не пишем ничего.
    node.props['on:pointerup']({ currentTarget: { getBoundingClientRect: () => ({ width: 300, height: 44 }) } });
    assert.deepEqual(saved, [], 'collapsed pointerup must not overwrite the remembered pre-collapse size');

    // Развёрнуто: обычный resize работает как раньше.
    collapsed.set(false);
    node.props['on:pointerup']({ currentTarget: { getBoundingClientRect: () => ({ width: 300, height: 200 }) } });
    assert.deepEqual(saved, [{ width: 300, height: 200 }]);
});

test('FloatingPanel() WITHOUT collapsed signal keeps the pointerup behavior untouched — panels without a collapse button still persist sizes', () => {
    const saved = [];
    const node = FloatingPanel('T', { onResize: next => saved.push(next), resizable: true }, 'body');
    node.props['on:pointerup']({ currentTarget: { getBoundingClientRect: () => ({ width: 10, height: 20 }) } });
    assert.deepEqual(saved, [{ width: 10, height: 20 }]);
});

test('StatBlock() shows NOTHING and marks itself pending until a value arrives — no placeholder pretending to be data', () => {
    const value = signal('');
    const node = StatBlock('Current RP time', value);

    assert.match(node.props.class(), /stme-stat-pending/);
    const valueNode = node.children.find(child => child?.props?.class === 'stme-stat-value');
    assert.equal(valueNode.children[0](), '', 'пусто, а не «(not established yet)» и не прошлое значение');

    value.set('09:15 (Morning)');

    assert.doesNotMatch(node.props.class(), /pending/);
    assert.equal(valueNode.children[0](), '09:15 (Morning)');
});

test('StatBlock() treats blank space as no value — a model answering with spaces must not look settled', () => {
    assert.match(StatBlock('X', signal('   ')).props.class(), /stme-stat-pending/);
});

test('StatBlock() separates the label from the value — they were one run of text before, which read as prose', () => {
    const node = StatBlock('Health', signal('90'), { icon: '♥' });

    const head = node.children.find(child => child?.props?.class === 'stme-stat-head');
    assert.equal(head.children[0].children[0], '♥');
    assert.equal(head.children[1].children[0], 'Health');
    assert.ok(node.children.some(child => child?.props?.class === 'stme-stat-value'));
});

test('ProgressBar() clamps and rounds the percent into [0,100] — a caller\'s raw done/total math must not produce a bar past full or a negative width', () => {
    const fillWidth = bar => bar.children[0].children[0].props.style.width;
    assert.equal(fillWidth(ProgressBar(150, 'x')), '100%');
    assert.equal(fillWidth(ProgressBar(-10, 'x')), '0%');
    assert.equal(fillWidth(ProgressBar(42.6, 'x')), '43%');
});

test('ProgressBar() renders the caller\'s own label text as-is, and omits the label node entirely when none is given', () => {
    const withLabel = ProgressBar(50, 'Building… 50%');
    assert.equal(withLabel.children[1].props.class, 'stme-progress-label');
    assert.equal(withLabel.children[1].children[0], 'Building… 50%');

    const withoutLabel = ProgressBar(50);
    assert.equal(withoutLabel.children.length, 1, 'no label given -> no second child at all, not an empty one');
});

/** Двойник `event.currentTarget.classList` — только `add`/`remove`, ничего больше HoldButton не трогает. */
function fakeButtonEvent() {
    const classes = new Set();
    return { currentTarget: { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } }, classes };
}

test('HoldButton() defaults to the danger variant, carries menu_button chrome, and exposes holdMs as a CSS custom property for the fill\'s own transition duration', () => {
    const node = HoldButton('Hold to delete graph', () => {}, { holdMs: 1200 });
    assert.equal(node.tag, 'button');
    assert.equal(node.props.class, 'menu_button stme-hold-button stme-danger');
    assert.equal(node.props.style['--stme-hold-ms'], '1200ms');
    assert.equal(node.children[0].props.class, 'stme-hold-button-fill');
    assert.equal(node.children[1].props.class, 'stme-hold-button-label');
    assert.equal(node.children[1].children[0], 'Hold to delete graph');
});

test('HoldButton() with variant:"default" does NOT carry the danger class — not every hold-to-confirm action is destructive', () => {
    assert.equal(HoldButton('Hold to confirm', () => {}, { variant: 'default' }).props.class, 'menu_button stme-hold-button');
});

test('HoldButton() fires onConfirm only after being held for the full holdMs — a quick tap must not trigger an irreversible action', async () => {
    let confirmed = 0;
    const node = HoldButton('Hold', () => { confirmed += 1; }, { holdMs: 10 });
    const event = fakeButtonEvent();

    node.props['on:pointerdown'](event);
    assert.equal(confirmed, 0, 'must not fire immediately on press');
    assert.ok(event.classes.has('stme-holding'), 'fill animation class must be armed while held');

    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(confirmed, 1);
    assert.ok(!event.classes.has('stme-holding'), 'holding class comes off once the action actually fires');
});

test('HoldButton() releasing early (pointerup) cancels the pending confirm — the whole point of requiring a hold', async () => {
    let confirmed = 0;
    const node = HoldButton('Hold', () => { confirmed += 1; }, { holdMs: 10 });
    const event = fakeButtonEvent();

    node.props['on:pointerdown'](event);
    node.props['on:pointerup'](event);
    assert.ok(!event.classes.has('stme-holding'), 'releasing must immediately roll back the fill, not wait for holdMs');

    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(confirmed, 0, 'a cancelled hold must never fire, even after the original holdMs would have elapsed');
});

test('HoldButton() ignores pointerdown while disabled — the same guard Button() already applies via the disabled prop, just also enforced in the handler', async () => {
    let confirmed = 0;
    const node = HoldButton('Hold', () => { confirmed += 1; }, { holdMs: 10, disabled: true });
    assert.equal(node.props.disabled, true);

    node.props['on:pointerdown'](fakeButtonEvent());
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(confirmed, 0);
});

/**
 * Реальный баг, найден живьём (жалоба пользователя: заливка доходит до 100%
 * и там застревает, отпускание кнопки ничего не удаляет). Причина —
 * `event.currentTarget` валиден ТОЛЬКО во время диспетчеризации самого
 * события: браузер сбрасывает его в `null` сразу по возврату из обработчика
 * (спецификация DOM), а старый код читал `event.currentTarget` СНОВА внутри
 * `setTimeout()`-колбэка — то есть уже `null`, `.classList` бросал наружу,
 * и до `onConfirm()` дело не доходило. Прежние fakeButtonEvent()-тесты
 * этого не ловили: их поддельный объект держит `currentTarget` живым
 * вечно, ровно та деталь настоящего DOM, которой не хватало. Здесь —
 * тот же fake, но с явной симуляцией конца диспетчеризации.
 */
test('HoldButton() must NOT read event.currentTarget from inside its setTimeout callback — the real DOM resets it to null right after the handler returns, well before holdMs elapses', async () => {
    let confirmed = 0;
    const node = HoldButton('Hold', () => { confirmed += 1; }, { holdMs: 10 });
    const event = fakeButtonEvent();

    node.props['on:pointerdown'](event);
    event.currentTarget = null; // конец диспетчеризации, тем же способом, что настоящий браузер

    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(confirmed, 1, 'onConfirm must still fire — the element must have been captured at pointerdown time, not re-read later');
});

test('DockButton() places itself via a position signal, same convention as FloatingPanel, and carries any drag handlers verbatim', () => {
    const position = signal({ left: 40, top: 60 });
    const onClick = () => {};
    const node = DockButton('🗺', { position, drag: { 'on:pointerdown': () => {}, 'on:click': onClick }, title: 'Open Map' });

    assert.equal(node.tag, 'button');
    assert.equal(node.props.class, 'stme-dock-button');
    assert.equal(node.props.title, 'Open Map');
    assert.deepEqual(node.props.style(), { left: '40px', top: '60px' });
    assert.equal(typeof node.props['on:pointerdown'], 'function');
});

test('DockButton() writes no left/top at all before the user ever moves it — CSS owns the default corner', () => {
    const node = DockButton('🗺', {});
    assert.deepEqual(node.props.style(), {});
});

test('EdgeDrawer() toggles its open class from the signal, and the tab click reports the OPPOSITE of the current state', () => {
    const open = signal(false);
    const toggled = [];
    const node = EdgeDrawer(open, { onToggle: value => toggled.push(value) }, 'settings form here');

    assert.equal(node.props.class(), 'stme-edge-drawer');
    const tab = node.children[0];
    tab.props['on:click']();
    assert.deepEqual(toggled, [true]);

    open.set(true);
    assert.equal(node.props.class(), 'stme-edge-drawer stme-edge-drawer-open');
});

test('IconButton() carries its own class (never menu_button chrome) and marks the active state, for toggle-style tool palettes', () => {
    let clicked = 0;
    const inactive = IconButton('📍', () => { clicked += 1; });
    const active = IconButton('📍', () => {}, { active: true, title: 'Add marker' });

    assert.equal(inactive.tag, 'button');
    assert.equal(inactive.props.class, 'stme-icon-button');
    inactive.props['on:click']();
    assert.equal(clicked, 1);
    assert.equal(active.props.class, 'stme-icon-button stme-icon-button-active');
    assert.equal(active.props.title, 'Add marker');
});

// --- Chat Viewport chrome (план `chat-viewport`) --------------------------

test('Avatar() renders a real <img> at the given size when a url is provided', () => {
    const node = Avatar('https://example.com/pic.png', { size: 64, name: 'Alice' });
    assert.equal(node.tag, 'img');
    assert.equal(node.props.src, 'https://example.com/pic.png');
    assert.equal(node.props.style.width, '64px');
    assert.equal(node.props.style.height, '64px');
    assert.match(node.props.alt, /Alice/);
});

test('Avatar() defaults to 56px — deliberately bigger than SillyTavern\'s own native avatar size (owner\'s explicit request)', () => {
    const node = Avatar('https://example.com/pic.png');
    assert.equal(node.props.style.width, '56px');
});

test('Avatar() with no url falls back to an initial-letter placeholder instead of a broken <img>', () => {
    const node = Avatar(null, { name: 'bob' });
    assert.equal(node.tag, 'div');
    assert.match(node.props.class, /stme-avatar-fallback/);
    assert.equal(node.children[0], 'B', 'the fallback initial is uppercased regardless of input casing');
});

test('Avatar() with neither url nor name falls back to "?" rather than an empty circle', () => {
    const node = Avatar(null, {});
    assert.equal(node.children[0], '?');
});

test('Timestamp() renders the caller\'s already-formatted text verbatim, with an optional title for the full value', () => {
    const node = Timestamp('2 min ago', { title: '2024-01-01 12:00:00' });
    assert.equal(node.tag, 'time');
    assert.equal(node.children[0], '2 min ago');
    assert.equal(node.props.title, '2024-01-01 12:00:00');
});

test('MessageHeader() shows the turn-index badge only when given one, and the generation-time badge only for non-user messages', () => {
    const withBoth = MessageHeader({ name: 'Narrator', turnIndex: 3, genDurationMs: 2500, isUser: false });
    const info = withBoth.children[1];
    const nameRow = info.children[0];
    assert.equal(nameRow.children[0].children[0], 'Narrator');
    assert.ok(nameRow.children.some(c => c?.children?.[0] === '#3'));
    assert.ok(nameRow.children.some(c => c?.children?.[0] === '2.5s'));

    const userHeader = MessageHeader({ name: 'You', turnIndex: 2, genDurationMs: 2500, isUser: true });
    const userNameRow = userHeader.children[1].children[0];
    assert.ok(!userNameRow.children.some(c => c?.children?.[0] === '2.5s'), 'a user message never had a generation time — showing one would be nonsensical');
});

test('MessageHeader() places "actions" in the SAME name-row as the name/badges, not a separate row below — owner: "любые кнопки должны быть в ряд с именем"', () => {
    const actionsNode = MessageActionsRow({ onDelete: () => {} });
    const header = MessageHeader({ name: 'Narrator', turnIndex: 1, actions: actionsNode });
    const nameRow = header.children[1].children[0];

    assert.ok(nameRow.children.includes(actionsNode), 'the actions tree must be a child of the name-row itself');
});

test('MessageHeader() without "actions" renders just the name in the name-row — h() filters the missing actions out entirely, actions stay optional', () => {
    const header = MessageHeader({ name: 'Narrator' });
    const nameRow = header.children[1].children[0];
    assert.equal(nameRow.children.length, 1);
    assert.equal(nameRow.children[0].children[0], 'Narrator');
});

test('MessageHeader() falls back to "You"/"Narrator" when no name is given', () => {
    const user = MessageHeader({ isUser: true });
    const npc = MessageHeader({ isUser: false });
    assert.equal(user.children[1].children[0].children[0].children[0], 'You');
    assert.equal(npc.children[1].children[0].children[0].children[0], 'Narrator');
});

test('MessageActionsRow() only shows swipe controls/counter when swipeCount is given and greater than 1', () => {
    const withoutSwipe = MessageActionsRow({ onEdit: () => {}, onDelete: () => {} });
    assert.equal(withoutSwipe.children.filter(Boolean).length, 2);

    const withSwipe = MessageActionsRow({ onEdit: () => {}, onSwipeLeft: () => {}, onSwipeRight: () => {}, swipeIndex: 1, swipeCount: 4 });
    const counter = withSwipe.children.find(c => c?.props?.class === 'stme-message-swipe-counter');
    assert.equal(counter.children[0], '2/4');
});

test('MessageActionsRow() with swipeCount:1 (no real alternative swipes) hides the swipe controls entirely', () => {
    const node = MessageActionsRow({ onSwipeLeft: () => {}, onSwipeRight: () => {}, swipeCount: 1 });
    assert.equal(node.children.filter(Boolean).length, 0);
});

test('MessageActionsRow() omits a button entirely when its handler is not given, rather than rendering a disabled/dead one', () => {
    const node = MessageActionsRow({ onDelete: () => {} });
    const buttons = node.children.filter(Boolean);
    assert.equal(buttons.length, 1);
});

test('ReasoningBlock() renders nothing at all for a message with no reasoning text — not an empty collapsed section', () => {
    assert.equal(ReasoningBlock(''), null);
    assert.equal(ReasoningBlock(null), null);
});

test('ReasoningBlock() wraps real reasoning text in a collapsed-by-default <details>', () => {
    const node = ReasoningBlock('Because the bandit flinched first.');
    assert.equal(node.tag, 'details');
    assert.equal(node.props.open, undefined, 'no `open` prop at all means collapsed, same convention as Details()');
});
