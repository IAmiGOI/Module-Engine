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
            'ui.messageFooter.claim', 'ui.messageFooter.release', 'ui.messageFooter.liveMesid', 'ui.messageFooter.attach',
        ],
    });
    const module = createPostprocessModule(moduleHost);

    /**
     * Прогон авто-цепочки тем же путём, что и вживую: эмит `generation.completed`
     * на Шину событий — ровно то, что публикует Ядро генерации в settle().
     * Подписка модуля отвечает асинхронно, поэтому ждём завершения: busy поднялся
     * → спал до его снятия (аналог await у «RP Time» в тестах).
     */
    async function emitGenerationCompleted() {
        engine.events.emit('generation.completed', { runId: 'run_1', outcome: 'ended', toolCalls: 0 });
        for (let i = 0; i < 200 && module.busy.peek(); i += 1) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        if (module.busy.peek()) throw new Error('emitGenerationCompleted: the auto-run chain did not finish');
    }

    return { engine, module, calls, answers, claims, live, modelFn, settingsContext, emitGenerationCompleted };
}

test('module loads and claims the center slot', async () => {
    const { module, claims } = buildEngine();
    await module.load();

    assert.equal(claims.length, 1);
    assert.equal(claims[0].slot, 'center');
    assert.equal(claims[0].ownerId, MODULE_ID);
    assert.equal(typeof claims[0].node, 'function');
});

test('a fresh reply is rewritten through the whole chain on generation.completed', async () => {
    const { module, calls, live, settingsContext, emitGenerationCompleted } = buildEngine({ replies: [' REWRITTEN TEXT '] });
    await module.load();
    module.passes.set([ONE_PASS]);
    await module.save();

    live.mesid = '1';
    await emitGenerationCompleted();

    const message = settingsContext.chat[1];
    assert.equal(message.mes, 'REWRITTEN TEXT');
    assert.ok(calls.length >= 1);
    assert.match(calls[0].systemPrompt, /Return ONLY the rewritten text/);
});

test('the trace lands in the annotations and a no-op result writes nothing', async () => {
    const { engine, module, live, settingsContext, emitGenerationCompleted } = buildEngine({ replies: ['The sun climbs as the road unwinds.'] });
    await module.load();

    live.mesid = '1';
    await emitGenerationCompleted();

    const message = settingsContext.chat[1];
    assert.equal(message.mes, 'The sun climbs as the road unwinds.');
    const annotations = await engine.resolveAs(MODULE_ID, 'chatHistory.annotations', { namespace: MODULE_ID });
    assert.ok(annotations.ok);
    assert.equal(Object.keys(annotations.value ?? {}).length, 0);
});

test('a second generation.completed does not reprocess the same reply', async () => {
    // Двойной прогон безопасен: begin видит аннотацию «уже обработано» и уходит
    // в skip — модель зовётся ровно один раз, текст перезаписывается один раз.
    const { module, calls, live, settingsContext, emitGenerationCompleted } = buildEngine({ replies: [' REWRITTEN TEXT '] });
    await module.load();
    module.passes.set([ONE_PASS]);
    await module.save();

    live.mesid = '1';
    await emitGenerationCompleted();
    await emitGenerationCompleted();

    assert.equal(calls.length, 1);
    assert.equal(settingsContext.chat[1].mes, 'REWRITTEN TEXT');
});

test('a failed pass does not abort the chain — the next pass still runs', async () => {
    const { module, calls, live, settingsContext, emitGenerationCompleted } = buildEngine({
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
    await module.save();

    live.mesid = '1';
    await emitGenerationCompleted();

    // Оба pass'а реально вызывались, провал первого не остановил второй.
    assert.equal(calls.length, 2);
    const message = settingsContext.chat[1];
    assert.equal(message.mes, 'SECOND PASS OUTPUT');
});

test('the badge annotation is stored and cleared on reroll via messageDeleted', async () => {
    const { engine, module, live, emitGenerationCompleted } = buildEngine({ replies: [' REWRITTEN '] });
    await module.load();
    module.passes.set([ONE_PASS]);
    await module.save();

    live.mesid = '1';
    await emitGenerationCompleted();
    const annotations = await engine.resolveAs(MODULE_ID, 'chatHistory.annotations', { namespace: MODULE_ID });
    assert.ok((annotations.value ?? {})['1'], 'trace annotation written for the processed message');

    // Реролл «Regenerate»: ST укорачивает чат и шлёт MESSAGE_DELETED с индексом.
    engine.events.emit('st.messageDeleted', { args: ['1'] });
    await new Promise(resolve => setTimeout(resolve, 0));
    const after = await engine.resolveAs(MODULE_ID, 'chatHistory.annotations', { namespace: MODULE_ID });
    assert.ok(!after.value['1'], 'reroll clears the badge so the new answer is processed again');
});

// --- Номера сообщений — индексы: гонки с удалением, заменой ответа и очередью (жалобы бета-тестера) ---

const waitMs = ms => new Promise(resolve => setTimeout(resolve, ms));
const message = (name, mes, sendDate, extra = {}) => ({ name, is_user: false, is_system: false, mes, send_date: sendDate, ...extra });
const seedChat = (settingsContext, ...items) => { settingsContext.chat.length = 0; settingsContext.chat.push(...items); };
const waitIdle = async module => { for (let i = 0; i < 300 && module.busy.peek(); i += 1) await waitMs(5); await waitMs(5); };

async function readyModule(options) {
    const built = buildEngine(options);
    await built.module.load();
    built.module.passes.set([ONE_PASS]);
    await built.module.save();
    return built;
}

test('a mark left on an index by a deleted message does not block the new reply that lands there, and does not show its badge', async () => {
    const { module, calls, live, engine, settingsContext, claims, emitGenerationCompleted } = await readyModule({ replies: [' REWRITTEN '] });
    seedChat(settingsContext, message('U', 'u0', 'd0', { is_user: true }), message('A', 'a1', 'd1'), message('U', 'u2', 'd2', { is_user: true }), message('A', 'a3', 'd3'), message('U', 'u4', 'd4', { is_user: true }), message('A', 'a5 first draft', 'd5'));
    live.mesid = '5';
    await emitGenerationCompleted();
    assert.equal(calls.length, 1);
    assert.equal(settingsContext.chat[5].mes, 'REWRITTEN');
    const oldEntry = module.badges.peek()['5'];
    // The pair u2/a3 in the middle is deleted: index 5 is free again, but its mark stays.
    settingsContext.chat.splice(2, 2);
    engine.events.emit('st.messageDeleted', { args: [3] });
    engine.events.emit('st.messageDeleted', { args: [2] });
    await waitMs(20);
    settingsContext.chat.push(message('U', 'new question', 'd8', { is_user: true }), message('A', 'a brand new reply', 'd9'));
    live.mesid = String(settingsContext.chat.length - 1);
    assert.equal(live.mesid, '5');
    // The footer shows no badge under the new reply (the mark belongs to the deleted one)...
    const factory = claims[0].node;
    assert.equal(factory({ mesid: '5', sendDate: 'd9', name: 'A', text: 'a brand new reply' }), null);
    assert.notEqual(factory({ mesid: '5', sendDate: 'd5', name: 'A', text: 'REWRITTEN' }), null, 'the message the mark was made for still wears it');
    // ...and the new reply is processed instead of being skipped as "already processed".
    await emitGenerationCompleted();
    assert.equal(calls.length, 2);
    assert.equal(settingsContext.chat[5].mes, 'REWRITTEN');
    assert.equal(module.badges.peek()['5'].original, 'a brand new reply');
    assert.notEqual(module.badges.peek()['5'], oldEntry);
    assert.equal(module.lastRun.peek().status, 'rewritten');
});

test('marks made before the fingerprint existed carry none and still count as processed; the rule when both messages have a date is date and name, else the text', async () => {
    const { entryMatchesMessage } = await import('../modules/postprocess/index.js');
    assert.equal(entryMatchesMessage({ original: 'a', trace: [] }, { mesid: '1', sendDate: 'd1', name: 'A', text: 'old reply' }), true);
    assert.equal(entryMatchesMessage(null, { mesid: '1' }), false);
    assert.equal(entryMatchesMessage({ fp: { sendDate: 'd1', name: 'A', text: 'x' } }, { sendDate: 'd1', name: 'A', text: 'changed later' }), true);
    assert.equal(entryMatchesMessage({ fp: { sendDate: 'd1', name: 'A', text: 'x' } }, { sendDate: 'd2', name: 'A', text: 'x' }), false);
    assert.equal(entryMatchesMessage({ fp: { sendDate: null, name: 'A', text: 'same text' } }, { sendDate: null, name: 'A', text: 'same text' }), true);
    assert.equal(entryMatchesMessage({ fp: { sendDate: null, name: 'A', text: 'same text' } }, { sendDate: null, name: 'A', text: 'other' }), false);
});

test('a rewrite is never written over a message that is no longer the reply that was processed (deleted and replaced while the pass was running)', async () => {
    const { module, live, settingsContext, engine } = await readyModule({ modelFn: async () => { await waitMs(80); return ' REWRITE OF THE OLD REPLY '; } });
    seedChat(settingsContext, message('U', 'u0', 'd0', { is_user: true }), message('A', 'OLD reply that the user will delete', 'd1'));
    live.mesid = '1';
    engine.events.emit('generation.completed', { runId: 'run_1', outcome: 'ended', toolCalls: 0 });
    await waitMs(20);
    settingsContext.chat.splice(1, 1);
    engine.events.emit('st.messageDeleted', { args: [1] });
    settingsContext.chat.push(message('A', 'NEW reply, being written right now', 'd2'));
    await waitIdle(module);
    assert.equal(settingsContext.chat[1].mes, 'NEW reply, being written right now', 'the new reply is untouched');
    assert.equal(module.badges.peek()['1'], undefined, 'no badge for a rewrite that was not applied');
    assert.equal(module.lastRun.peek().status, 'stale');
    assert.match(module.lastRun.peek().reason, /changed while it was being processed/);
});

test('the same holds when the reply is edited by someone else while the pass runs: the user\'s own edit wins', async () => {
    const { module, live, settingsContext, engine } = await readyModule({ modelFn: async () => { await waitMs(60); return ' REWRITE '; } });
    seedChat(settingsContext, message('U', 'u0', 'd0', { is_user: true }), message('A', 'first text', 'd1'));
    live.mesid = '1';
    engine.events.emit('generation.completed', { runId: 'run_1', outcome: 'ended', toolCalls: 0 });
    await waitMs(15);
    settingsContext.chat[1].mes = 'text edited by the user meanwhile';
    await waitIdle(module);
    assert.equal(settingsContext.chat[1].mes, 'text edited by the user meanwhile');
    assert.equal(module.lastRun.peek().status, 'stale');
});

test('a reply that finishes while the previous one is still being processed is queued and processed next, not dropped', async () => {
    const { module, calls, live, settingsContext, engine } = await readyModule({ modelFn: async params => { await waitMs(50); return ` REWRITE ${calls.length} `; } });
    seedChat(settingsContext, message('U', 'u0', 'd0', { is_user: true }), message('A', 'a1 original', 'd1'));
    live.mesid = '1';
    engine.events.emit('generation.completed', { runId: 'run_1', outcome: 'ended', toolCalls: 0 });
    await waitMs(10);
    assert.equal(module.busy.peek(), true);
    settingsContext.chat.push(message('U', 'u2', 'd2', { is_user: true }), message('A', 'a3 new reply', 'd3'));
    live.mesid = '3';
    engine.events.emit('generation.completed', { runId: 'run_2', outcome: 'ended', toolCalls: 0 });
    assert.equal(module.lastRun.peek().status, 'queued');
    await waitMs(250);
    await waitIdle(module);
    assert.equal(calls.length, 2, 'both replies went through the passes');
    assert.match(settingsContext.chat[1].mes, /^REWRITE/);
    assert.match(settingsContext.chat[3].mes, /^REWRITE/);
    assert.equal(module.lastRun.peek().status, 'rewritten');
});

test('every skip says why: the last message is yours, a system message (tool calls), empty, or already processed; with auto-run off nothing runs at all', async () => {
    const { module, calls, live, settingsContext, emitGenerationCompleted } = await readyModule({ replies: [' REWRITTEN '] });
    const skippedWith = async (items, mesid) => { seedChat(settingsContext, ...items); live.mesid = mesid; await emitGenerationCompleted(); assert.equal(module.lastRun.peek().status, 'skipped'); return module.lastRun.peek().reason; };
    assert.match(await skippedWith([message('U', 'u0', 'd0', { is_user: true }), message('A', 'a1', 'd1'), message('U', 'u2', 'd2', { is_user: true })], '2'), /is yours, not a reply/);
    assert.match(await skippedWith([message('U', 'u0', 'd0', { is_user: true }), message('A', '', 'd1'), message('System', 'Tool calls', 'd2', { is_system: true, extra: { tool_invocations: [{}] } })], '2'), /system message \(tool calls or a hidden message\)/);
    assert.match(await skippedWith([message('U', 'u0', 'd0', { is_user: true }), message('A', '   ', 'd1')], '1'), /is empty/);
    assert.equal(calls.length, 0, 'none of these reached the model');
    seedChat(settingsContext, message('U', 'u0', 'd0', { is_user: true }), message('A', 'a1', 'd1'));
    live.mesid = '1';
    await emitGenerationCompleted();
    assert.equal(module.lastRun.peek().status, 'rewritten');
    await emitGenerationCompleted();
    assert.match(module.lastRun.peek().reason, /already processed/);
    module.autoRun.set(false);
    await module.save();
    const before = module.lastRun.peek();
    await emitGenerationCompleted();
    assert.equal(module.lastRun.peek(), before, 'auto-run off: not even a skip is recorded');
});

test('a reply the passes left unchanged is not sent to the model again by a repeated completion event, but the manual button still runs it', async () => {
    const { module, calls, live, settingsContext, emitGenerationCompleted } = await readyModule({ modelFn: () => ' Same text ' });
    seedChat(settingsContext, message('U', 'u0', 'd0', { is_user: true }), message('A', 'Same text', 'd1'));
    live.mesid = '1';
    await emitGenerationCompleted();
    assert.equal(calls.length, 1);
    assert.equal(module.lastRun.peek().status, 'unchanged');
    await emitGenerationCompleted();
    assert.equal(calls.length, 1, 'no second paid run for the same reply');
    assert.match(module.lastRun.peek().reason, /already run through the passes/);
    await module.processNow();
    assert.equal(calls.length, 2, 'the button always runs');
    settingsContext.chat[1].mes = 'Different text after a reroll';
    settingsContext.chat[1].send_date = 'd2';
    await emitGenerationCompleted();
    assert.equal(calls.length, 3, 'a rerolled reply is a new reply');
});

test('the manual button names the reason when there is nothing to process', async () => {
    const { module, live, settingsContext } = await readyModule();
    seedChat(settingsContext, message('U', 'u0', 'd0', { is_user: true }));
    live.mesid = '0';
    await module.processNow();
    assert.equal(module.lastRun.peek().auto, false);
    assert.match(module.lastRun.peek().reason, /is yours, not a reply/);
});
