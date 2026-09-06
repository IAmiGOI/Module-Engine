import test from 'node:test';
import assert from 'node:assert/strict';
import { signal, computed } from '../cores/ui/reactive.js';
import { Button, TextInput, Select, Slider, Toggle, Field, Row, Card, Section, Badge, EmptyState, List, TwoColumn, EditableList, FloatingPanel, StatBlock } from '../libraries/shared/widgets.js';

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

    assert.deepEqual(node.props.style(), { left: '20px', top: '30px' });
});

test('FloatingPanel() applies a stored size when there is one', () => {
    const node = FloatingPanel('T', { position: signal({}), size: signal({ width: 300, height: 200 }) }, 'body');

    assert.deepEqual(node.props.style(), { width: '300px', height: '200px' });
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
