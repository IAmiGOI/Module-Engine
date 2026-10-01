import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { request } from '../libraries/shared/request.js';
import { registerHttpService } from '../services/http.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { createInternalEngineModelsCore } from '../cores/models/internal-engine.js';
import { computeRepetitionCut } from '../libraries/core/guide-repetition.js';

function build() {
    const engine = createEngine();
    const state = { aborted: 0, started: 0 };
    // Провайдер «висит»: отвечает только когда его оборвут.
    const fetch = (url, init = {}) => new Promise((resolve, reject) => {
        state.started += 1;
        init.signal?.addEventListener('abort', () => { state.aborted += 1; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
    });
    registerHttpService(engine.buses.network, { fetch });
    const settingsContext = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    const core = createInternalEngineModelsCore(engine.registerCaller('core.models.internal', 'cores', { tier: 'official', networkAccess: true }), { workerWaitMs: 0 });
    core.configureWorkers([{ id: 'w1', endpoint: 'https://api.example.com/v1', apiKey: 'k', model: 'm', format: 'openai' }]);
    const call = (contract, params) => request(engine.buses.cores, contract, { params });
    const events = [];
    engine.events.subscribe('model.generate.failed', payload => events.push(payload));
    return { call, state, events, engine };
}

test('a running generation can be stopped by its request id: the provider connection is aborted, the request ends with a failure, and an unknown id is simply not found', async () => {
    const { call, state, events, engine } = build();
    const module = engine.registerCaller('module.guide', 'modules', { tier: 'official' });
    const pending = new Promise(resolve => module.cores.subscribe('model.generate', { params: { prompt: 'hello', requestId: 'req-1' } }, resolve));
    for (let waited = 0; waited < 50 && !state.started; waited += 1) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(state.started, 1, 'the request reached the provider');
    assert.equal((await call('model.generate.cancel', { requestId: 'nope' })).value, false);
    assert.equal((await call('model.generate.cancel', { requestId: 'req-1' })).value, true);
    const result = await pending;
    assert.equal(result.ok, false, 'the generation ended with a failure');
    assert.equal(state.aborted, 1, 'the connection to the provider was cut');
    assert.equal(events.length, 1);
    assert.equal((await call('model.generate.cancel', { requestId: 'req-1' })).value, false, 'a finished request cannot be stopped again');
});

const LOOP = 'Good — I have the infobox. Now let me read her personality. Let me pull those upLet me read the Personality, Background, and Quotes sections from the main page, and search for her physical appearance description.Let me pull up the Personality, Background, and Quotes sections from the main wiki page.Let me pull up the Personality, Background, and Quotes sections from the main wiki page.Let me pull up the Personality, Background, and Quotes sections from the main wikiLet me pull up the Personality, Background, and Quotes sections from the main wiki pageLet me pull up the Personality, Background, and Quotes sections from the main wiki page.Let me pull up the Personality, Backgr';

test('a model that loops on one phrase with small variations and no separators is caught, and the cut leaves roughly one copy; ordinary long text, tables and lists are not mistaken for a loop', () => {
    const cut = computeRepetitionCut(LOOP);
    assert.ok(cut > 0 && cut < LOOP.length - 400, `cut at ${cut}`);
    const kept = LOOP.slice(0, cut);
    assert.ok(kept.startsWith('Good — I have the infobox.'));
    assert.ok((kept.match(/Quotes sections/g) ?? []).length <= 2, 'at most about one copy is kept');
    const exact = `Intro. ${'Let me look at that for you now. '.repeat(5)}`;
    assert.ok(computeRepetitionCut(exact) > 0, 'an exact loop');
    assert.equal(computeRepetitionCut('Short text.'), -1);
    const rule = `A heading\n${'-'.repeat(200)}\n${'-'.repeat(200)}\n${'-'.repeat(200)}\nand then some real text about her appearance, which goes on and on for a good while to be long.`;
    assert.equal(computeRepetitionCut(rule), -1, 'a ruler line is not a loop');
    const prose = 'Emilia is kind. She helps others before herself. She is stubborn in her convictions and holds them even at a cost. She is naive but perceptive, and when she thinks clearly she reads people well. She speaks gently. She touches the clip when unsure. ';
    assert.equal(computeRepetitionCut(prose.repeat(1)), -1);
    const card = '```proposal\n{"action":"character.update","params":{"description":"x","first_mes":"y","mes_example":"z","personality":"p","scenario":"s","description":"x","first_mes":"y"}}';
    assert.equal(computeRepetitionCut(card), -1, 'repeated JSON keys inside a block are fine');
});
