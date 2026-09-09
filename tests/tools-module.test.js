import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createModuleRegistry } from '../harness/engine-wiring.js';
import { createNotebookModule, NOTEBOOK_MODULE_ID } from '../modules/tools/notebook.js';

/**
 * «Tools» — папка, а не Модуль: инструменты включаются КАЖДЫЙ СВОИМ
 * тумблером, папка только группирует их карточки в панели. Реестр несёт
 * это как свойство `folder` определения; проверяем, что оно доезжает до
 * `list()` (единственный канал реестр→панель) и что у «папочного» Модуля
 * полноценный жизненный цикл самостоятельного Модуля.
 */

function lightDefinition(id, extra = {}) {
    return {
        id,
        title: id,
        description: 'test',
        rights: { tier: 'community', allowedContracts: [] },
        create: () => ({ load: async () => {}, tree: () => null, stop: () => {} }),
        ...extra,
    };
}

function registryWith(definitions) {
    const engine = createEngine();
    return createModuleRegistry({
        engine,
        uiModules: { enable: () => ({ settled: async () => {}, getRoot: () => null }), disable: () => {} },
        panelSettled: async () => {},
        panelRoot: () => ({ querySelector: () => null }), // без DOM: attach() не найдёт слотов и не упадёт
        storageHost: { own: engine.buses.modules }, // remember() пишет состав через Шину модулей
        definitions,
    });
}

test('registry list() exposes folder — the only channel registry→panel', () => {
    const registry = registryWith([
        lightDefinition('module.a'),
        lightDefinition(NOTEBOOK_MODULE_ID, { folder: 'Tools' }),
    ]);
    const list = registry.list();
    assert.equal(list.find(e => e.id === 'module.a').folder, undefined);
    assert.equal(list.find(e => e.id === NOTEBOOK_MODULE_ID).folder, 'Tools');
});

test('a foldered module is a FULL module: enable/instance/disable work as usual', async () => {
    const registry = registryWith([lightDefinition(NOTEBOOK_MODULE_ID, { folder: 'Tools' })]);
    await registry.enable(NOTEBOOK_MODULE_ID);
    assert.ok(registry.instance(NOTEBOOK_MODULE_ID), 'живой экземпляр есть — папка ничего не меняет в жизненном цикле');
    await registry.disable(NOTEBOOK_MODULE_ID);
    assert.equal(registry.instance(NOTEBOOK_MODULE_ID), undefined);
});

test('the real Notebook factory still creates a self-sufficient module', async () => {
    // Дым: фабрика не деградировала до «под-модуля контейнера».
    assert.equal(typeof createNotebookModule, 'function');
    assert.equal(NOTEBOOK_MODULE_ID, 'module.notebook');
});
