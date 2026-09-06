import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createUpdateOverlayCore } from '../cores/ui/update-overlay.js';

/**
 * Экран обновления проверяется через ДЕРЕВО, а не через DOM: DOM тут и не
 * появляется — Ядро строит данные, а рисует их Ядро финального UI (UI.md).
 * Ищем в дереве узел по классу — ровно так же, как это делает Final UI.
 */
function find(node, className) {
    if (!node || typeof node !== 'object') return null;
    const resolved = typeof node.props?.class === 'function' ? node.props.class() : node.props?.class;
    if (resolved === className) return node;
    for (const child of node.children ?? []) {
        const value = typeof child === 'function' ? child() : child;
        for (const item of Array.isArray(value) ? value : [value]) {
            const found = find(item, className);
            if (found) return found;
        }
    }
    return null;
}

function buildEngine({ run } = {}) {
    const engine = createEngine();
    const runs = [];
    const selfUpdateHost = engine.registerCaller('core.selfUpdate', 'cores', { tier: 'official' });
    selfUpdateHost.own.register('selfUpdate.run', params => {
        runs.push(params);
        return run ? run(params) : { outcome: 'up-to-date' };
    });
    const core = createUpdateOverlayCore(engine.registerCaller('core.ui.updateOverlay', 'cores', { tier: 'official' }));
    return { engine, core, runs };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('nothing is shown until something actually happens — silence is the resting state', () => {
    const { core } = buildEngine();

    const tree = core.tree();

    assert.equal(find(tree, 'stme-overlay'), null, 'экрана нет');
    assert.equal(find(tree, 'stme-banner stme-banner-warn'), null, 'полосы нет');
});

test('a started update blocks the WHOLE page, not just the engine panel', async () => {
    const { engine, core } = buildEngine();
    const tree = core.tree();

    engine.events.emit('selfUpdate.started', { branch: 'Main-Stable' });
    await settle();

    assert.ok(find(tree, 'stme-overlay'), 'перекрытие появилось');
    assert.ok(find(tree, 'stme-spinner stme-spinner-md'), 'и в нём ожидание');
});

test('an APPLIED update keeps the overlay up — the reload comes next, and a flash of the page would be a lie', async () => {
    const { engine, core } = buildEngine();

    engine.events.emit('selfUpdate.started', {});
    engine.events.emit('selfUpdate.applied', {});
    await settle();

    assert.equal(core.updating(), true);
});

test('a FAILED update drops the overlay and raises the banner instead — with the reason, not just "it failed"', async () => {
    const { engine, core } = buildEngine();
    const tree = core.tree();

    engine.events.emit('selfUpdate.started', {});
    engine.events.emit('selfUpdate.failed', { reason: 'HTTP 403' });
    await settle();

    assert.equal(core.updating(), false, 'экран снят — работать снова можно');
    const banner = find(tree, 'stme-banner stme-banner-warn');
    assert.ok(banner, 'полоса поднялась');
    const text = find(banner, 'stme-banner-text');
    const value = typeof text.children[0] === 'function' ? text.children[0]() : text.children[0];
    assert.match(value, /HTTP 403/, 'причина видна прямо в полосе');
});

test('"already up to date" shows NOTHING — that is the whole promise of a quiet self-update', async () => {
    const { engine, core } = buildEngine();
    const tree = core.tree();

    engine.events.emit('selfUpdate.upToDate', { commit: 'abc1234' });
    await settle();

    assert.equal(find(tree, 'stme-overlay'), null);
    assert.equal(find(tree, 'stme-banner stme-banner-warn'), null);
});

test('Retry really re-runs the update, and forces past the cooldown — the pause exists against a loop, not against the user', async () => {
    const { engine, core, runs } = buildEngine();
    engine.events.emit('selfUpdate.failed', { reason: 'HTTP 403' });
    await settle();

    await core.retry();

    assert.deepEqual(runs, [{ force: true }]);
});

test('a successful retry clears the banner, because the update run announces its own start', async () => {
    const { engine, core } = buildEngine({
        run: () => { engine.events.emit('selfUpdate.started', {}); return { outcome: 'updated' }; },
    });
    engine.events.emit('selfUpdate.failed', { reason: 'HTTP 403' });
    await settle();
    assert.notEqual(core.failure(), '');

    await core.retry();
    await settle();

    assert.equal(core.failure(), '', 'жалоба снята');
    assert.equal(core.updating(), true);
});

test('the Ядро knows NOTHING about git or GitHub — it only listens', () => {
    const { core } = buildEngine();

    const surface = Object.keys(core);
    assert.deepEqual(surface.filter(name => /git|github|commit|branch|apply|pull/i.test(name)), []);
});
