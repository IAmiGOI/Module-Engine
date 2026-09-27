import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEngine } from '../libraries/shared/engine.js';
import { describeWorldInfo, describePreset } from '../libraries/core/guide-st-settings.js';
import { registerStWorldInfoService } from '../services/st-worldinfo.js';
import { registerStPresetService } from '../services/st-preset.js';
import { detectFocus, NEUTRAL } from '../libraries/core/guide-relevance.js';
import { createGuideContext } from '../cores/guide/context.js';
import { parseArticle, selectArticles } from '../libraries/core/guide-knowledge.js';

const read = path => fs.readFileSync(new URL(`../guide/${path}`, import.meta.url), 'utf8');

// --- Настройки ST для гида: только чтение, только для анализа ---

test('describeWorldInfo() turns the raw global settings into one readable line; describePreset() does the same for the active generation preset', () => {
    const wi = describeWorldInfo({
        depth: 4, budget: 25, budgetCap: 0, insertionStrategy: 'evenly', recursive: true, maxRecursionSteps: 3,
        includeNames: false, caseSensitive: false, matchWholeWords: true, useGroupScoring: false,
        minActivations: 0, minActivationsDepthMax: 0, overflowAlert: false,
    });
    assert.match(wi, /scan depth 4 messages/);
    assert.match(wi, /token budget 25/);
    assert.ok(!wi.includes('hard cap'), 'no cap set — not mentioned');
    assert.match(wi, /recursive scanning on \(max 3 steps\)/);
    assert.equal(describeWorldInfo(null), '', 'no data — no line, never a fake description');

    // found live: describePreset once used the DOM-binding table's KEYS ('temperature', 'top_p'...) as if they were oai_settings'
    // own field names — they are not. The real object (default_settings in openai.js) keeps them under a "_openai" suffix
    // (temp_openai, top_p_openai...); the bare names below must be ignored, not misread as the real field.
    const preset = describePreset({
        api: 'openai', name: 'My Preset', values: { temp_openai: 0.9, top_p_openai: 0.95, temperature: 99, unknownField: 'x' },
        contextTemplate: 'Default', instructEnabled: false, instructTemplate: '',
    });
    assert.match(preset, /API: openai/);
    assert.match(preset, /preset name: "My Preset"/);
    assert.match(preset, /sampler: temperature: 0\.9, top_p: 0\.95/);
    assert.ok(!preset.includes('99'), 'the bare "temperature" is not a real oai_settings field — must not be read');
    assert.ok(!preset.includes('unknownField'), 'fields the API does not define for samplers are never invented');
    assert.match(preset, /context template: "Default"/);
    assert.ok(!preset.includes('instruct mode'), 'instruct is off and empty — not mentioned');
    assert.equal(describePreset({}), '', 'no values — no line');

    // openai_max_tokens is the RESPONSE length, openai_max_context is the total context window — two different numbers, both labelled distinctly.
    const withTokens = describePreset({ api: 'openai', name: 'X', values: { openai_max_tokens: 4000, openai_max_context: 128000 } });
    assert.match(withTokens, /max output tokens: 4000/);
    assert.match(withTokens, /max context: 128000/);

    // Each API names the same sampler field differently — describePreset must use ITS OWN field names, not a generic guess.
    const kobold = describePreset({ api: 'kobold', name: 'GUI KoboldAI Settings', values: { temp: 1.1, rep_pen: 1.05, temperature: 99 } });
    assert.match(kobold, /sampler: temperature: 1\.1, repetition penalty: 1\.05/);
    assert.ok(!kobold.includes('99'), 'kobold\'s own field is "temp", not "temperature" — the openai-shaped field is ignored, never misread');
    assert.equal(describePreset({ api: 'kobold', name: 'GUI KoboldAI Settings', values: 'gui' }), 'API: kobold; preset name: "GUI KoboldAI Settings"', 'the placeholder "gui" preset has no real settings object — reported honestly, no crash, no invented sampler line');
});

test('stWorldInfo.settings reads the live bindings of the real ST module — a fresh call sees a value changed after the first one, not a snapshot from import time', async () => {
    const live = { world_info_depth: 4, world_info_budget: 25, world_info_insertion_strategy: { evenly: 0, priority: 1 }, world_info_character_strategy: 0 };
    const bus = createEngine().buses.services;
    registerStWorldInfoService(bus, { importScript: async () => live });
    const first = await new Promise(resolve => bus.subscribe('stWorldInfo.settings', {}, resolve));
    assert.equal(first.value.depth, 4);
    assert.equal(first.value.insertionStrategy, 'evenly');
    live.world_info_depth = 9;
    const second = await new Promise(resolve => bus.subscribe('stWorldInfo.settings', {}, resolve));
    assert.equal(second.value.depth, 9, 'live binding, not a cached snapshot');
});

test('stPreset.current reads live sampler values, NOT PresetManager.getSelectedPreset() — found live: that call returns the <option> value ("gui", a name, or an index), never the settings object', async () => {
    // openai (Chat Completion): the live settings are public on getContext() itself.
    const openaiBus = createEngine().buses.services;
    const openaiContext = {
        mainApi: 'openai',
        getPresetManager: () => ({ getSelectedPreset: () => 'my-preset-name', getSelectedPresetName: () => 'My Preset' }),
        chatCompletionSettings: { temp_openai: 0.7, top_p_openai: 0.9 },
        powerUserSettings: { context: { preset: 'Default' }, instruct: { enabled: false, preset: 'Alpaca' } },
    };
    registerStPresetService(openaiBus, { getContext: () => openaiContext });
    const openaiResult = await new Promise(resolve => openaiBus.subscribe('stPreset.current', {}, resolve));
    assert.equal(openaiResult.value.name, 'My Preset');
    assert.equal(openaiResult.value.values.temp_openai, 0.7, 'the real settings object, not the option value "my-preset-name"');

    // kobold: not public on getContext() — read live from kai-settings.js, the same trick as st-worldinfo.js.
    const koboldBus = createEngine().buses.services;
    const live = { temp: 1, rep_pen: 1.1, preset_settings: 'gui' };
    const koboldContext = { mainApi: 'kobold', getPresetManager: () => ({ getSelectedPreset: () => 'gui', getSelectedPresetName: () => 'GUI KoboldAI Settings' }) };
    registerStPresetService(koboldBus, { getContext: () => koboldContext, importKai: async () => ({ kai_settings: live }) });
    const koboldResult = await new Promise(resolve => koboldBus.subscribe('stPreset.current', {}, resolve));
    assert.equal(koboldResult.value.values.temp, 1);
    live.temp = 1.4;
    const koboldAgain = await new Promise(resolve => koboldBus.subscribe('stPreset.current', {}, resolve));
    assert.equal(koboldAgain.value.values.temp, 1.4, 'live binding, not a snapshot');

    const empty = createEngine().buses.services;
    registerStPresetService(empty, { getContext: () => null });
    const none = await new Promise(resolve => empty.subscribe('stPreset.current', {}, resolve));
    assert.equal(none.value, null);
});

// --- Фокус на теме "пресет" ---

test('preset-sounding words (or the Preset card open) put "preset" in focus, same as the other sticky topics', () => {
    const found = detectFocus({ query: 'what does the temperature setting do in the preset?', anchors: [], modules: [] });
    assert.equal(found.preset, true);
    assert.equal(detectFocus({ query: 'tell me a joke', anchors: [], modules: [] }), null);
    const byAnchor = detectFocus({ query: 'hi', anchors: ['card:preset'], modules: [] });
    assert.equal(byAnchor.preset, true);
});

// --- Проводка: editable() читает их, только пока тема в фокусе ---

test('editable() adds World Info / preset info only while that topic is in focus, via callService — not read at all otherwise', async () => {
    const calls = [];
    const callService = async (contract) => {
        calls.push(contract);
        if (contract === 'stWorldInfo.settings') return { ok: true, value: { depth: 4, budget: 25, insertionStrategy: 'evenly', recursive: false, includeNames: false, caseSensitive: false, matchWholeWords: false, useGroupScoring: false } };
        if (contract === 'stPreset.current') return { ok: true, value: { api: 'openai', name: 'Default', values: { temp_openai: 0.7 } } };
        return { ok: false };
    };
    const context = createGuideContext({
        call: async contract => ({ ok: true, value: ({ 'tracking.trackers': [], 'macros.programs': [], 'lorebook.find': [] })[contract] }),
        callService,
        modules: { list: () => [], enabled: () => [] },
    });
    const neither = await context.editable({ focus: NEUTRAL });
    assert.ok(!neither.includes('World Info') && !neither.includes('generation preset'));
    assert.deepEqual(calls, []);

    const withLore = await context.editable({ focus: { ...NEUTRAL, lorebook: true, modules: [] } });
    assert.match(withLore, /SillyTavern's own global World Info settings \(NOT the engine's Lorebook card.*do not link to card:lorebook.*\): scan depth 4 messages/);
    assert.ok(!withLore.includes('generation preset'));

    const withPreset = await context.editable({ focus: { ...NEUTRAL, preset: true, modules: [] } });
    assert.match(withPreset, /SillyTavern's own active generation preset \(NOT the engine's Preset card.*do not link to card:preset.*\): API: openai/);
});

// --- Знания: статья находится по своим словам ---

test('the "SillyTavern\'s own World Info settings and generation preset" article is chosen for a question about scan depth or temperature', () => {
    const articles = JSON.parse(read('knowledge/index.json')).articles.map(file => parseArticle(read(`knowledge/${file}`), file));
    const forWorldInfo = selectArticles(articles, 'what does scan depth and token budget actually do in world info settings?').map(article => article.title);
    assert.ok(forWorldInfo.includes("SillyTavern's own World Info settings and generation preset"));
    const forPreset = selectArticles(articles, 'my preset temperature seems high, what does that change?').map(article => article.title);
    assert.ok(forPreset.includes("SillyTavern's own World Info settings and generation preset"));
});

// --- Не путать с движковыми card:lorebook / card:preset ---

test('found live: the model linked to the engine\'s own Preset/Lorebook cards when discussing ST\'s native settings — this article must carry NO anchors, so it never appears as a suggested link (buildGuideSystemPrompt would print "Related anchors: card:preset" otherwise)', () => {
    const article = parseArticle(read('knowledge/st-native-settings.md'), 'st-native-settings.md');
    assert.deepEqual(article.anchors, []);
});
