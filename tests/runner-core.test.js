import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunnerCore } from '../cores/runner/index.js';
import { createBuiltinRunner, BUILTIN_MODULES, ENGINE_VERSION } from '../harness/engine-wiring.js';
import { createEngine } from '../libraries/shared/engine.js';

const header = (id, extra = '') => `/*@module\nid: ${id}\nversion: 1.0.0\nengine: ^0.2\n${extra}\n*/\n`;

function runnerWith(sources, options = {}) {
    return createRunnerCore({
        engineVersion: '0.2.1',
        readSource: async path => sources[path],
        resolveStme: path => (path === 'widgets' ? 'http://x/widgets.js' : null),
        importBlob: async source => ({ default: host => ({ fromBlob: source, host }) }),
        ...options,
    });
}

test('every built-in Module has a valid header whose id matches the id the code exports, and a real factory', async () => {
    const engine = createEngine();
    const { runner, ready } = createBuiltinRunner({ engine });
    const { problems } = await ready;
    assert.deepEqual(problems, [], 'no built-in Module may fail to load');
    assert.equal(runner.definitions.length, BUILTIN_MODULES.length);
    assert.equal(new Set(runner.definitions.map(d => d.id)).size, BUILTIN_MODULES.length, 'ids are unique');
    for (const entry of BUILTIN_MODULES) {
        const exports = await entry.load();
        const definition = runner.definitions.find(d => d.title && entry.path);
        assert.ok(definition);
        const idConstants = Object.entries(exports).filter(([name, value]) => /MODULE_ID$/.test(name) && typeof value === 'string').map(([, value]) => value);
        const ids = runner.definitions.map(d => d.id);
        assert.ok(idConstants.some(value => ids.includes(value)), `${entry.path}: header id must match an exported *_MODULE_ID`);
    }
    for (const d of runner.definitions) {
        assert.equal(d.rights.tier, 'community');
        assert.ok(d.rights.allowedContracts.length > 0, `${d.id} declares its rights`);
        assert.equal(d.origin, 'builtin');
    }
});

test('built-in Modules keep the folder and the rights they had before the Runner', async () => {
    const { runner, ready } = createBuiltinRunner({ engine: createEngine() });
    await ready;
    const byId = Object.fromEntries(runner.definitions.map(d => [d.id, d]));
    assert.equal(byId['module.notebook'].folder, 'Tools');
    assert.equal(byId['module.secrets'].folder, 'Tools');
    assert.equal(byId['module.tracker'].folder, undefined);
    assert.ok(byId['module.tracker'].rights.allowedContracts.includes('pipeline.stages.add'));
    assert.ok(byId['module.map'].rights.allowedContracts.includes('map.position.move'));
    assert.ok(byId['module.music'].rights.allowedContracts.includes('classifier.decide'));
    assert.equal(ENGINE_VERSION, '0.2.1');
});

test('the Runner builds definitions in dependency order from headers alone', async () => {
    const runner = runnerWith({
        'a.js': header('module.a', 'requires: module.b@^1.0.0'),
        'b.js': header('module.b'),
    });
    const { definitions, problems } = await runner.discover([
        { origin: 'builtin', path: 'a.js', load: async () => ({ default: () => 'a' }) },
        { origin: 'builtin', path: 'b.js', load: async () => ({ default: () => 'b' }) },
    ]);
    assert.deepEqual(definitions.map(d => d.id), ['module.b', 'module.a']);
    assert.deepEqual(problems, []);
    assert.equal(await definitions[0].create({}), 'b');
});

test('one bad Module never stops the others: bad header, missing dependency, wrong engine each become a problem', async () => {
    const runner = runnerWith({
        'ok.js': header('module.ok'),
        'bad.js': 'export const x = 1;',
        'needs.js': header('module.needs', 'requires: module.ghost'),
        'future.js': '/*@module\nid: module.future\nversion: 1.0.0\nengine: ^9.0.0\n*/',
    });
    const load = async () => ({ default: () => ({}) });
    const { definitions, problems } = await runner.discover(['ok.js', 'bad.js', 'needs.js', 'future.js'].map(path => ({ origin: 'builtin', path, load })));
    assert.deepEqual(definitions.map(d => d.id), ['module.ok']);
    const byState = Object.fromEntries(problems.map(p => [p.path, p]));
    assert.equal(byState['bad.js'].state, 'invalid');
    assert.equal(byState['needs.js'].state, 'blocked');
    assert.match(byState['needs.js'].reason, /not installed/);
    assert.match(byState['future.js'].reason, /needs engine/);
});

test('an unreadable source is a problem, not a crash', async () => {
    const runner = createRunnerCore({ engineVersion: '0.2.1', readSource: async () => { throw new Error('HTTP 404'); } });
    const { definitions, problems } = await runner.discover([{ origin: 'builtin', path: 'gone.js', load: async () => ({}) }]);
    assert.deepEqual(definitions, []);
    assert.match(problems[0].reason, /HTTP 404/);
});

test('a missing factory export fails at create(), with a message naming it', async () => {
    const runner = runnerWith({ 'm.js': header('module.m', 'factory: makeIt') });
    const { definitions } = await runner.discover([{ origin: 'builtin', path: 'm.js', load: async () => ({ other() {} }) }]);
    await assert.rejects(() => definitions[0].create({}), /no export "makeIt"/);
});

test('an installed Module is scanned: clean code gets scanned-safe, rights from the scan, network never auto-granted', async () => {
    const source = header('community.dice', 'network: true') + `import { Button } from 'stme:widgets';\nexport default () => 1;`;
    const runner = runnerWith({});
    const { definitions, problems } = await runner.discover([{ origin: 'installed', path: 'dice.js', source }]);
    assert.deepEqual(problems, []);
    const [definition] = definitions;
    assert.equal(definition.tier, 'scanned-safe');
    assert.equal(definition.rights.tier, 'scanned-safe');
    assert.equal(definition.rights.networkAccess, false, 'asking for network in the header is only a request');
    assert.match(definition.hash, /^[0-9a-f]{64}$/);
    const instance = await definition.create({ me: 1 });
    assert.ok(instance.fromBlob.includes("'http://x/widgets.js'"), 'the executed text has the stme: import swapped for a real URL');
});

test('an installed Module that touches the network undeclared is scanned-unsafe and denied http.request', async () => {
    const source = header('community.leaky') + `await fetch('/x'); export default () => 1;`;
    const { definitions } = await runnerWith({}).discover([{ origin: 'installed', path: 'leaky.js', source }]);
    assert.equal(definitions[0].tier, 'scanned-unsafe');
    assert.deepEqual(definitions[0].rights.deniedContracts, ['http.request']);
    assert.ok(definitions[0].findings.some(f => f.rule === 'network'));
});

test('an installed Module with eval or a foreign import is rejected before any code runs', async () => {
    let imported = false;
    const runner = runnerWith({}, { importBlob: async () => { imported = true; return {}; } });
    const { definitions, problems } = await runner.discover([
        { origin: 'installed', path: 'evil.js', source: header('community.evil') + `eval('1');` },
        { origin: 'installed', path: 'foreign.js', source: header('community.foreign') + `import x from 'https://evil.example/x.js';` },
        { origin: 'installed', path: 'unknown.js', source: header('community.unknown') + `import x from 'stme:nope';` },
    ]);
    assert.deepEqual(definitions, []);
    assert.deepEqual(problems.map(p => p.state), ['rejected', 'rejected', 'rejected']);
    assert.equal(imported, false);
});

test('a quarantined installed Module is refused, by id or hash, and says so', async () => {
    const source = header('community.bad') + `export default () => 1;`;
    const runner = runnerWith({}, { isQuarantined: id => id === 'community.bad' });
    const { definitions, problems } = await runner.discover([{ origin: 'installed', path: 'bad.js', source }]);
    assert.deepEqual(definitions, []);
    assert.equal(problems[0].state, 'quarantined');
});

test('an installed Module can require a built-in one, and is blocked if that one cannot load', async () => {
    const runner = runnerWith({ 'base.js': header('module.base', 'requires: module.ghost') });
    const dependant = header('community.fan', 'requires: module.base') + `export default () => 1;`;
    const { definitions, problems } = await runner.discover([
        { origin: 'builtin', path: 'base.js', load: async () => ({}) },
        { origin: 'installed', path: 'fan.js', source: dependant },
    ]);
    assert.deepEqual(definitions, []);
    assert.equal(problems.length, 2);
});
