import test from 'node:test';
import assert from 'node:assert/strict';
import { createWidgetManager } from '../cores/ui/home/widgets.js';

function widget(id, log = [], extra = {}) {
    return { id, title: id.toUpperCase(), size: { w: 200, h: 100 }, create: host => ({ html: () => `<div>${id}:${host.instanceId}</div>`, start: () => log.push(`start ${host.instanceId}`), stop: () => log.push(`stop ${host.instanceId}`), ...extra }) };
}

function setup({ files = {}, modules = {}, log = [] } = {}) {
    const events = [];
    const manager = createWidgetManager({
        baseUrl: '/widgets/',
        fetchJson: async url => { if (!(url in files)) throw new Error(`404 ${url}`); return files[url]; },
        importModule: async url => { if (!(url in modules)) throw new Error(`cannot import ${url}`); return modules[url]; },
        createHost: (def, instanceId) => ({ storage: { key: `${def.id}/${instanceId}` } }),
        onChange: event => events.push(event),
    });
    return { manager, events, log };
}

test('the folder catalog: index.json lists the folders, each widget.js is imported; one broken widget does not stop the rest', async () => {
    const { manager } = setup({
        files: { '/widgets/index.json': { widgets: ['a', 'b', 'broken', 'junk'] } },
        modules: { '/widgets/a/widget.js': { default: widget('a') }, '/widgets/b/widget.js': { default: widget('b') }, '/widgets/junk/widget.js': { default: { id: 'BAD' } } },
    });
    const result = await manager.loadCatalog();
    assert.deepEqual(result.loaded, ['a', 'b']);
    assert.deepEqual(result.failed.map(item => item.id), ['broken', 'junk']);
    assert.deepEqual(manager.available().map(item => item.id), ['a', 'b']);
    assert.equal(manager.available()[0].source, 'folder');
    const missing = await setup().manager.loadCatalog();
    assert.equal(missing.loaded.length, 0, 'no index.json — an empty catalog, not a crash');
    assert.equal(missing.failed[0].id, 'index.json');
});

test('registering on the fly needs nothing from us: a plain object with create(host) is enough; a bad one is refused with a reason', () => {
    const { manager, events } = setup();
    assert.deepEqual(manager.register(widget('live')), { ok: true, replaced: false });
    assert.equal(manager.has('live'), true);
    assert.deepEqual(events.at(-1), { type: 'defs', id: 'live', replaced: false });
    const refused = manager.register({ id: 'x' });
    assert.equal(refused.ok, false);
    assert.equal(manager.has('x'), false);
});

test('an instance gets a host with its own instanceId, the injected storage/rights and invalidate(); start runs after mounting, stop on removal', () => {
    const log = [];
    const { manager, events } = setup({ log });
    manager.register(widget('w', log));
    assert.equal(manager.mount('w1', 'w'), true);
    const { instance } = manager.state('w1');
    assert.equal(instance.html(), '<div>w:w1</div>');
    assert.deepEqual(log, ['start w1']);
    manager.unmount('w1');
    assert.deepEqual(log, ['start w1', 'stop w1']);
    assert.equal(manager.state('w1').instance, null);
    manager.register({ ...widget('inv'), create: host => ({ html: () => `<i>${host.storage.key}</i>`, poke: () => host.invalidate() }) });
    manager.mount('x1', 'inv');
    manager.state('x1').instance.poke();
    assert.deepEqual(events.at(-1), { type: 'invalidate', instanceId: 'x1' });
    assert.equal(manager.state('x1').instance.html(), '<i>inv/x1</i>');
});

test('hot swap: re-registering an id restarts its instances with the new code; unregistering leaves an "unavailable" placeholder that comes alive when the widget returns', () => {
    const log = [];
    const { manager } = setup({ log });
    manager.register(widget('w', log));
    manager.mount('w1', 'w');
    log.length = 0;
    manager.register({ ...widget('w', log), title: 'NEW' });
    assert.deepEqual(log, ['stop w1', 'start w1'], 'old instance stopped, new one started');
    assert.equal(manager.title('w'), 'NEW');
    assert.equal(manager.unregister('w'), true);
    assert.equal(manager.state('w1').instance, null);
    assert.equal(manager.state('w1').error, 'not installed');
    assert.equal(manager.unregister('w'), false);
    log.length = 0;
    manager.register(widget('w', log));
    assert.ok(manager.state('w1').instance, 'the saved instance came back to life by itself');
    assert.deepEqual(log, ['start w1']);
});

test('a widget that throws in create() or returns no html() is contained: the instance is marked failed, nothing else breaks', () => {
    const { manager } = setup();
    manager.register({ ...widget('bad'), create: () => { throw new Error('boom'); } });
    manager.register({ ...widget('junk'), create: () => ({}) });
    manager.register(widget('fine'));
    assert.equal(manager.mount('b1', 'bad'), false);
    assert.equal(manager.state('b1').error, 'boom');
    assert.equal(manager.mount('j1', 'junk'), false);
    assert.match(manager.state('j1').error, /html/);
    assert.equal(manager.mount('f1', 'fine'), true);
});

test('sync() makes the running instances match the desktop list: extras stopped, new ones started, an unknown widget waits as a placeholder', () => {
    const log = [];
    const { manager } = setup({ log });
    manager.register(widget('w', log));
    manager.sync([{ instanceId: 'a', widgetId: 'w' }, { instanceId: 'b', widgetId: 'ghost' }]);
    assert.ok(manager.state('a').instance);
    assert.equal(manager.state('b').instance, null);
    manager.sync([{ instanceId: 'b', widgetId: 'ghost' }]);
    assert.equal(manager.state('a').instance, null);
    assert.deepEqual(log, ['start a', 'stop a']);
    manager.dispose();
    assert.deepEqual(manager.available(), []);
});
