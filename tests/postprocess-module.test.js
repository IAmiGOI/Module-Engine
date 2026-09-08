import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { registerChatMetadataService } from '../services/chat-metadata.js';
import { registerStChatService } from '../services/st-chat.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { createChatMemoryCore } from '../cores/memory/index.js';
import { createChatHistoryCore } from '../cores/chat-history/index.js';
import { createNotificationsCore } from '../cores/ui/notifications.js';
import {
    createPostprocessModule,
    sanitizePasses,
    buildPassRequest,
    buildContextBlock,
    cleanPassOutput,
    applyPass,
    diffWords,
    MODULE_ID,
} from '../modules/postprocess/index.js';

// --- Чистые функции -----------------------------------------------------------

test('sanitizePasses() clamps context depth and preserves pass identity', () => {
    const [first] = sanitizePasses([
        { id: 'a', name: '  Fix  ', prompt: ' fix it ', includeContext: true, contextDepth: 999 },
        { id: 'a', prompt: 'duplicate dropped' },
        { prompt: 'gets a fresh id' },
    ]);

    assert.equal(first.id, 'a');
    assert.equal(first.name, 'Fix');
    assert.equal(first.prompt, 'fix it');
    assert.equal(first.includeContext, true);
    assert.equal(first.contextDepth, 20);
});

test('buildPassRequest() without context sends only the instruction and the text', () => {
    const built = buildPassRequest({ prompt: 'Tighten prose.' }, 'A  sentence.', []);
    assert.match(built.systemPrompt, /Tighten prose\./);
    assert.match(built.systemPrompt, /Return ONLY the rewritten text/);
    assert.equal(built.prompt, 'A  sentence.');
});

test('buildPassRequest() with context puts the chat history BEFORE the text', () => {
    const built = buildPassRequest(
        { prompt: 'Tighten prose.', includeContext: true, contextDepth: 2 },
        'A sentence.',
        [{ isSystem: true, text: 'noise' }, { isUser: true, text: 'Hello.' }, { isUser: false, text: 'Hi back.' }],
    );
    assert.match(built.prompt, /^RECENT CONTEXT:/);
    assert.match(built.prompt, /Player: Hello\./);
    assert.match(built.prompt, /Character: Hi back\./);
    assert.match(built.prompt, /TEXT TO REWRITE:\nA sentence\.$/);
});

test('buildContextBlock() drops system messages and caps each message', () => {
    const block = buildContextBlock(
        [{ isUser: false, text: 'x'.repeat(1200) }, { isUser: true, text: 'short' }],
        5,
    );
    assert.match(block, /^Character: x{900}$/m);
    assert.match(block, /Player: short$/m);
});

test('cleanPassOutput() strips a code fence the model added despite being told not to', () => {
    assert.equal(cleanPassOutput('```markdown\nText\n```'), 'Text');
    assert.equal(cleanPassOutput('  plain  '), 'plain');
});

test('applyPass() with no instruction records a skip and passes the text through', async () => {
    const value = { skip: false, text: 'original', trace: [] };
    const next = await applyPass(value, { id: 'p1', name: 'Empty', prompt: '' }, async () => 'should not be called');

    assert.equal(next.text, 'original');
    assert.deepEqual(next.trace, [{ passId: 'p1', name: 'Empty', skipped: true, reason: 'no-prompt' }]);
});

test('applyPass() chains: the next pass sees the previous pass output', async () => {
    const first = await applyPass({ skip: false, text: 'one', trace: [] }, { id: 'a', name: 'A', prompt: 'p' }, async () => ' two ');
    const second = await applyPass(first, { id: 'b', name: 'B', prompt: 'p' }, async (pass, built) => {
        assert.match(built.prompt, /two/);
        return 'three';
    });

    assert.equal(second.text, 'three');
    assert.deepEqual(second.trace.map(step => [step.name, step.after]), [['A', 'two'], ['B', 'three']]);
});

test('applyPass() turns a failed model call into a skip, not a crash of the chain', async () => {
    const next = await applyPass({ skip: false, text: 'text', trace: [] }, { id: 'a', name: 'A', prompt: 'p' }, async () => {
        throw new Error('worker unreachable');
    });

    assert.equal(next.text, 'text');
    assert.deepEqual(next.trace.at(-1), { passId: 'a', name: 'A', skipped: true, reason: 'worker unreachable' });
});

test('diffWords() marks the words that changed', () => {
    assert.deepEqual(diffWords('The cat sat', 'The dog sat'), [
        { type: 'equal', text: 'The ' },
        { type: 'remove', text: 'cat' },
        { type: 'add', text: 'dog' },
        { type: 'equal', text: ' sat' },
    ]);
});

test('diffWords() falls back to one remove+add pair beyond the token cap', () => {
    const huge = 'w '.repeat(5000);
    assert.deepEqual(diffWords(huge, `${huge}more`), [
        { type: 'remove', text: huge },
        { type: 'add', text: `${huge}more` },
    ]);
});

// --- Сценарный уровень ----------------------------------------------------------

/** Один валидный pass по умолчанию — без него цепочка честно уходит в skip. */
const ONE_PASS = { id: 'p1', name: 'Rewrite', prompt: 'rewrite it', workerId: '', enabled: true, includeContext: false, contextDepth: 6, samplerPreset: '', temperature: 0.7, topP: 1, topK: 0, maxTokens: 1000, reasoningMode: 'inherit', reasoningEffort: 'low', reasoningBudget: 0 };

function buildEngine({ replies, modelFn } = {}) {
    const engine = createEngine();
    const settingsContext = { extensionSettings: {}, chatMetadata: {}, saveSettingsDebounced: () => {}, saveMetadataDebounced: () => {}, chat: [
        { is_user: true, is_system: false, mes: 'We ride out at dawn.' },
        { is_user: false, is_system: false, mes: 'The sun climbs as the road unwinds.' },
    ] };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    registerChatMetadataService(engine.buses.services, { getContext: () => settingsContext });
    registerStChatService(engine.buses.services, { getContext: () => settingsContext });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    createChatMemoryCore(engine.registerCaller('core.memory.chat', 'cores', { tier: 'official' }));
    createChatHistoryCore(engine.registerCaller('core.chatHistory', 'cores', { tier: 'official' }));
    createNotificationsCore(engine.registerCaller('core.ui.notifications', 'cores', { tier: 'official' }), { mount: node => node });

    const calls = [];
    const answers = replies ?? [' REWRITTEN TEXT '];
    const modelHost = engine.registerCaller('core.models.internal', 'cores', { tier: 'official' });
    modelHost.own.register('model.generate', async params => {
        calls.push(params);
        if (modelFn) return modelFn(params, calls.length);
        return answers[Math.min(calls.length - 1, answers.length - 1)];
    });
    modelHost.own.register('model.workers.get', () => [{ id: 'main' }, { id: 'rewriter' }]);
    let customPresets = [];
    modelHost.own.register('model.presets.get', () => customPresets);
    modelHost.own.register('model.presets.set', params => {
        customPresets = params?.presets ?? [];
        engine.events.emit('model.presets.changed', { count: customPresets.length });
        return customPresets;
    });

    const claims = [];
    const live = { mesid: null };
    const footerHost = engine.registerCaller('core.ui.messageFooter', 'cores', { tier: 'official' });
    footerHost.own.register('ui.messageFooter.claim', params => { claims.push(params); return params.slot; });
    footerHost.own.register('ui.messageFooter.release', () => true);
    footerHost.own.register('ui.messageFooter.liveMesid', () => live.mesid);
    footerHost.own.register('ui.messageFooter.attach', () => true);

    const stageCalls = [];
    const stages = new Map();
    const pipelineHost = engine.registerCaller('core.pipeline', 'cores', { tier: 'official' });
    pipelineHost.own.register('pipeline.stages.add', params => {
        stageCalls.push(['add', params.stageId ?? params.stage?.id]);
        stages.set(params.stage?.id, { ...params.stage, params: params.stage?.params ?? {} });
        return params.stage?.id;
    });
    pipelineHost.own.register('pipeline.stages.remove', params => {
        stageCalls.push(['remove', params.stageId]);
        stages.delete(params.stageId);
        return true;
    });

    const storageHost = engine.registerCaller('core.storage', 'cores', { tier: 'official' });
    const store = new Map();
    storageHost.own.register('storage.settings.get', params => ({ ok: true, value: store.get(`${params.namespace}:${params.key}`) ?? params.fallback ?? null }));
    storageHost.own.register('storage.settings.set', params => {
        store.set(`${params.namespace}:${params.key}`, params.value);
        return { ok: true, value: true };
    });

    const moduleHost = engine.registerCaller(MODULE_ID, 'modules', {
        tier: 'community',
        allowedContracts: [
            'chatHistory.messages', 'chatHistory.replaceText', 'chatHistory.annotate', 'chatHistory.annotations',
            'model.generate',
            'model.workers.get', 'model.presets.get', 'model.presets.set', 'storage.settings.get', 'storage.settings.set', 'ui.notify',
            'pipeline.stages.add', 'pipeline.stages.remove',
            'ui.messageFooter.claim', 'ui.messageFooter.release', 'ui.messageFooter.liveMesid', 'ui.messageFooter.attach',
        ],
    });
    const module = createPostprocessModule(moduleHost);

    /**
     * Полный прогон fold-цепочки — как это сделал бы сам Ядро пайплайнов на
     * `generation.completed`: вход — снимок прогона, каждый этап — resolveAs()
     * под правами владельца этапа, выход становится переносимым значением.
     * Порядок этапов ВЫВОДИТСЯ ИЗ `needs` (уровни, как в computeStageLevels;
     * внутри уровня — порядок регистрации), а не захардкожен: захардкоженный
     * порядок однажды скрыл реальный баг — `apply`, зарегистрированный до
     * появления pass'ов, исполнялся РАНЬШЕ них.
     */
    async function runCompletedPipeline() {
        let value = { runId: 'run_1', stage: 'completed' };
        const remaining = new Map(stages);
        const executed = new Set();
        while (remaining.size) {
            const level = [...remaining.values()].filter(stage => (stage.needs ?? []).every(need => executed.has(need)));
            if (!level.length) throw new Error(`runCompletedPipeline: unresolvable needs: ${[...remaining.keys()].join(', ')}`);
            for (const stage of level) {
                remaining.delete(stage.id);
                const params = stage.params ?? {};
                const resolved = {};
                for (const [key, val] of Object.entries(params)) resolved[key] = (val && val.$from === '$value') ? value : val;
                // Реальный вызов этапа — resolveAs() под правами модуля-владельца.
                const result = await engine.resolveAs(MODULE_ID, stage.contract, resolved);
                if (result.ok) value = result.value;
                executed.add(stage.id);
            }
        }
        return value;
    }

    return { engine, module, calls, answers, claims, stages, live, modelFn, settingsContext, runCompletedPipeline };
}

test('module loads, claims the center slot, and registers its stages', async () => {
    const { module, claims, stages } = buildEngine();
    await module.load();

    assert.equal(claims.length, 1);
    assert.equal(claims[0].slot, 'center');
    assert.equal(claims[0].ownerId, MODULE_ID);
    assert.equal(typeof claims[0].node, 'function');
    // begin + apply; pass-этапов нет, потому что pass'ов нет.
    assert.ok(stages.has('postprocess:begin'));
    assert.ok(stages.has('postprocess:apply'));
    assert.equal(stages.size, 2);
});

test('a fresh reply is rewritten through the whole fold chain', async () => {
    const { module, calls, live, settingsContext, runCompletedPipeline } = buildEngine({ replies: [' REWRITTEN TEXT '] });
    await module.load();
    module.passes.set([ONE_PASS]);
    await module.save();

    live.mesid = '1';
    await runCompletedPipeline();

    const message = settingsContext.chat[1];
    assert.equal(message.mes, 'REWRITTEN TEXT');
    assert.ok(calls.length >= 1);
    assert.match(calls[0].systemPrompt, /Return ONLY the rewritten text/);
});

test('the trace lands in the annotations and a no-op result writes nothing', async () => {
    const { engine, module, live, settingsContext, runCompletedPipeline } = buildEngine({ replies: ['The sun climbs as the road unwinds.'] });
    await module.load();

    live.mesid = '1';
    await runCompletedPipeline();

    const message = settingsContext.chat[1];
    assert.equal(message.mes, 'The sun climbs as the road unwinds.');
    const annotations = await engine.resolveAs(MODULE_ID, 'chatHistory.annotations', { namespace: MODULE_ID });
    assert.ok(annotations.ok);
    assert.equal(Object.keys(annotations.value ?? {}).length, 0);
});

test('passes added AFTER the first registration still run before apply — the save-time resync must rebuild the graph', async () => {
    // Регресс на реальный баг авто-запуска: модуль грузится БЕЗ pass'ов
    // (register с needs: [] у apply), затем пользователь заводит pass и жмёт
    // Save. Прежний syncStages пропускал уже зарегистрированный apply — и на
    // живом generation.completed цепочка шла begin → apply → pass: замена
    // происходила ДО переписывания, «нечего менять», авто-запуск молчал.
    const { module, calls, live, settingsContext, runCompletedPipeline, stages } = buildEngine({ replies: [' REWRITTEN TEXT '] });
    await module.load(); // первое переключение состава — ещё без pass'ов

    module.passes.set([ONE_PASS]);
    await module.save(); // второе переключение состава — pass появился

    // Граф обязан быть пересобран: apply зависит от pass-этапа.
    assert.deepEqual(stages.get('postprocess:apply').needs, ['postprocess:pass:p1']);

    live.mesid = '1';
    await runCompletedPipeline();
    assert.equal(calls.length, 1, 'the model pass must actually run');
    assert.equal(settingsContext.chat[1].mes, 'REWRITTEN TEXT', 'the rewrite must land BEFORE the replace step');
});

test('a failed pass does not abort the chain — the next pass still runs', async () => {
    const { module, calls, live, settingsContext, runCompletedPipeline } = buildEngine({
        modelFn: (params, callNumber) => {
            if (callNumber === 1) throw new Error('worker unreachable');
            return ' SECOND PASS OUTPUT ';
        },
    });
    await module.load();
    module.passes.set([
        { id: 'p1', name: 'Failing', prompt: 'p1', workerId: '', enabled: true, includeContext: false, contextDepth: 6, samplerPreset: '', temperature: 0.7, topP: 1, topK: 0, maxTokens: 1000, reasoningMode: 'inherit', reasoningEffort: 'low', reasoningBudget: 0 },
        { id: 'p2', name: 'Working', prompt: 'p2', workerId: '', enabled: true, includeContext: false, contextDepth: 6, samplerPreset: '', temperature: 0.7, topP: 1, topK: 0, maxTokens: 1000, reasoningMode: 'inherit', reasoningEffort: 'low', reasoningBudget: 0 },
    ]);
    // Синхронизировать этапы под новые pass'ы — в живом движке это делает save().
    await module.save();

    live.mesid = '1';
    await runCompletedPipeline();

    // Оба pass'а реально вызывались, провал первого не остановил второй.
    assert.equal(calls.length, 2);
    const message = settingsContext.chat[1];
    assert.equal(message.mes, 'SECOND PASS OUTPUT');
});

test('the badge annotation is stored and cleared on reroll via messageDeleted', async () => {
    const { engine, module, live, runCompletedPipeline } = buildEngine({ replies: [' REWRITTEN '] });
    await module.load();
    module.passes.set([ONE_PASS]);
    await module.save();

    live.mesid = '1';
    await runCompletedPipeline();
    const annotations = await engine.resolveAs(MODULE_ID, 'chatHistory.annotations', { namespace: MODULE_ID });
    assert.ok((annotations.value ?? {})['1'], 'trace annotation written for the processed message');

    // Реролл «Regenerate»: ST укорачивает чат и шлёт MESSAGE_DELETED с индексом.
    engine.events.emit('st.messageDeleted', { args: ['1'] });
    await new Promise(resolve => setTimeout(resolve, 0));
    const after = await engine.resolveAs(MODULE_ID, 'chatHistory.annotations', { namespace: MODULE_ID });
    assert.ok(!after.value['1'], 'reroll clears the badge so the new answer is processed again');
});
