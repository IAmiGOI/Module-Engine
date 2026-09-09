import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createModuleHost,
    persistedSettings,
    chatCollection,
    pipelineStage,
    stTool,
} from '../libraries/shared/module-kit.js';
import { createFakeBuses } from '../libraries/shared/fake-buses.js';

/**
 * Тесты Библиотеки module-kit — на офлайн-фейках шин (см.
 * libraries/shared/fake-buses.js), как и остальные тесты движка.
 */

function makeHost() {
    const buses = createFakeBuses();
    return {
        buses,
        host: {
            cores: buses.cores,
            events: buses.events,
            own: buses.modules, // фейк Шины модулей — register возвращает отписку
        },
    };
}

test('createModuleHost: call идёт на Шину ядер, notify кладёт тон и текст', async () => {
    const { host, buses } = makeHost();
    const { call, notify } = createModuleHost(host);
    const seen = [];
    buses.cores.register('ui.notify', params => { seen.push(params); return { ok: true }; });
    await notify.ok('всё хорошо');
    assert.deepEqual(seen, [{ tone: 'ok', text: 'всё хорошо' }]);
    const result = await call('ui.notify', { tone: 'error', text: 'беда' });
    assert.deepEqual(seen.at(-1), { tone: 'error', text: 'беда' });
    assert.equal(result.ok, true);
});

test('persistedSettings: restore применяет clamp к мусору с диска', async () => {
    const { host, buses } = makeHost();
    buses.cores.register('storage.settings.get', async () => ({ maxNotes: 'garbage', injectionDepth: 999 }));
    const clamp = values => ({
        maxNotes: Number.isFinite(Number(values.maxNotes)) ? Math.max(1, Math.round(Number(values.maxNotes))) : 12,
        injectionDepth: Math.min(100, Math.max(0, Math.round(Number(values.injectionDepth) || 4))),
    });
    const settings = persistedSettings(host, { namespace: 'module.test', clamp });
    const applied = [];
    const restored = await settings.restore(v => applied.push(v));
    assert.equal(restored.maxNotes, 12);
    assert.equal(restored.injectionDepth, 100);
    assert.deepEqual(applied, [restored]);
});

test('persistedSettings: save пишет уже зажатое и применяет к сигналам через apply', async () => {
    const { host, buses } = makeHost();
    const writes = [];
    buses.cores.register('storage.settings.set', params => { writes.push(params); return { ok: true }; });
    const clamp = v => ({ ...v, max: Math.min(10, v.max) });
    const settings = persistedSettings(host, { namespace: 'module.test', clamp });
    const applied = [];
    await settings.save({ max: 50 }, v => applied.push(v));
    assert.deepEqual(writes, [{ namespace: 'module.test', key: 'settings', value: { max: 10 } }]);
    assert.deepEqual(applied, [{ max: 10 }]);
});

test('persistedSettings: restore без сохранённого ничего не применяет', async () => {
    const { host, buses } = makeHost();
    // Поставщика нет — Шина отвечает стандартным { ok: false } (Контракт на ошибки).
    const settings = persistedSettings(host, { namespace: 'module.test' });
    const applied = [];
    const restored = await settings.restore(v => applied.push(v));
    assert.equal(restored, null);
    assert.deepEqual(applied, []);
});

test('chatCollection: persist пишет И flush-ит, load читает fallback на не-ok', async () => {
    const { host, buses } = makeHost();
    const calls = [];
    buses.cores.register('storage.chatMemory.set', params => { calls.push(['set', params]); });
    buses.cores.register('storage.chatMemory.flush', params => { calls.push(['flush', params]); });
    // get не зарегистрирован — Шина отвечает { ok: false }
    buses.events.subscribe('st.chatChanged', () => {}); // фейк позволяет подписку

    const signal = { current: null, set(v) { this.current = v; } };
    const collection = chatCollection(host, { namespace: 'module.test', key: 'notes', signal });
    await collection.persist([{ id: 'n1' }]);
    assert.deepEqual(calls.map(c => c[0]), ['set', 'flush']); // flush сразу после set — класс бага 1 закрыт

    const loaded = await collection.load();
    assert.deepEqual(loaded, []); // не-ok → fallback
    assert.deepEqual(signal.current, []);
});

test('chatCollection: смена чата перечитывает память (класс бага 2)', async () => {
    const { host, buses } = makeHost();
    let stored = [{ id: 'old' }];
    buses.cores.register('storage.chatMemory.get', async () => stored);
    const seen = [];
    const signal = { current: null, set(v) { this.current = v; } };
    const collection = chatCollection(host, { namespace: 'module.test', key: 'notes', signal, onChange: v => seen.push(v) });
    await collection.load();
    assert.deepEqual(signal.current, [{ id: 'old' }]);

    stored = [{ id: 'new' }];
    // Фейковая Шина событий: как у остальных тестов — подписчики вызываются напрямую.
    // Сам `load()` асинхронный — даём микротаскам доработать до assertions.
    buses.events.emit('st.chatChanged', {});
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(signal.current, [{ id: 'new' }]);
    assert.deepEqual(seen.at(-1), [{ id: 'new' }]);
    collection.stop();
});

test('pipelineStage: add регистрирует контракт на host.own и добавляет этап', async () => {
    const { host, buses } = makeHost();
    const added = [];
    buses.cores.register('pipeline.stages.add', params => { added.push(params); return { ok: true }; });
    const registered = [];
    host.own.register = (contract, handler) => { registered.push({ contract, handler }); return () => {}; };

    const executed = [];
    const stage = pipelineStage(host, {
        pipelineId: 'generation.beforeSend',
        stageId: 'test:inject',
        contract: 'community.test.inject',
        params: { chat: { $from: '$input.chat' } },
        onExhausted: 'flag',
        execute: p => { executed.push(p); return true; },
    });
    await stage.add();
    assert.equal(added.length, 1);
    assert.equal(added[0].stage.contract, 'community.test.inject');
    assert.equal(registered[0].contract, 'community.test.inject');
    assert.equal(registered[0].handler({ chat: [] }), true);
    assert.deepEqual(executed, [{ chat: [] }]);
});

test('pipelineStage: без execute бросает при создании', () => {
    const { host } = makeHost();
    assert.throws(() => pipelineStage(host, { stageId: 'x', contract: 'c' }), /execute/);
});

test('stTool: onError returnText превращает брошенное в текст', async () => {
    const { host, buses } = makeHost();
    const registered = [];
    buses.cores.register('generation.registerTool', params => { registered.push(params); return { ok: true }; });
    const tool = stTool(host, {
        schema: { name: 'Test', parameters: {} },
        onError: 'returnText',
        action: async () => { throw new Error('опечатка модели'); },
    });
    await tool.register();
    const action = registered[0].definition.action;
    assert.equal(await action({}), 'опечатка модели'); // не бросил
});

test('stTool: unregister снимает по имени, formatMessage доезжает в определение', async () => {
    const { host, buses } = makeHost();
    const registered = [];
    const unregistered = [];
    buses.cores.register('generation.registerTool', params => { registered.push(params); return { ok: true }; });
    buses.cores.register('generation.unregisterTool', params => { unregistered.push(params); return { ok: true }; });
    const tool = stTool(host, {
        schema: { name: 'Test', parameters: {} },
        action: async () => 'ok',
        formatMessage: () => 'msg',
    });
    await tool.register();
    assert.equal(registered[0].definition.formatMessage(), 'msg');
    await tool.unregister();
    assert.deepEqual(unregistered, [{ name: 'Test' }]);
});
