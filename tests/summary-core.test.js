import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerHttpService } from '../services/http.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { registerChatMetadataService } from '../services/chat-metadata.js';
import { registerStChatService } from '../services/st-chat.js';
import { createInternalEngineModelsCore } from '../cores/models/internal-engine.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { createChatMemoryCore } from '../cores/memory/index.js';
import { createChatHistoryCore } from '../cores/chat-history/index.js';
import { createPipelineCore } from '../cores/pipeline/index.js';
import {
    createBasicSummaryCore, DEFAULT_SETTINGS, clampSummarySettings,
    groupIntoUnits, shouldFold, sortByStart, activeSummaries,
} from '../cores/summary/index.js';

// --- Unit level: pure logic, no Ядро/Сервис involved -----------------------

test('groupIntoUnits() keeps a plain message as its own unit', () => {
    const units = groupIntoUnits([{ mesid: '0', isToolCall: false }, { mesid: '1', isToolCall: false }]);
    assert.deepEqual(units.map(unit => unit.map(m => m.mesid)), [['0'], ['1']]);
});

test('groupIntoUnits() collapses a ToolCall chain PLUS its real reply into ONE unit', () => {
    const units = groupIntoUnits([
        { mesid: '0', isToolCall: true },
        { mesid: '1', isToolCall: true },
        { mesid: '2', isToolCall: false }, // the real continuation reply
        { mesid: '3', isToolCall: false },
    ]);
    assert.deepEqual(units.map(unit => unit.map(m => m.mesid)), [['0', '1', '2'], ['3']]);
});

test('groupIntoUnits() holds back an ORPHAN ToolCall chain at the tail — no reply arrived yet', () => {
    const units = groupIntoUnits([
        { mesid: '0', isToolCall: false },
        { mesid: '1', isToolCall: true }, // no reply follows — incomplete
    ]);
    assert.deepEqual(units.map(unit => unit.map(m => m.mesid)), [['0']]);
});

test('a message with hasReasoning stays a single unit — CoT lives inside the message, not as a separate entry', () => {
    const units = groupIntoUnits([{ mesid: '0', isToolCall: false, hasReasoning: true }]);
    assert.equal(units.length, 1);
    assert.equal(units[0].length, 1);
});

test('shouldFold() triggers the instant the backlog beyond the protected window reaches a full batch', () => {
    assert.equal(shouldFold(29, 20, 10), false);
    assert.equal(shouldFold(30, 20, 10), true);
    assert.equal(shouldFold(31, 20, 10), true);
});

test('clampSummarySettings() falls back to defaults on garbage input, without throwing', () => {
    const settings = clampSummarySettings({ levels: 'nope', protectedWindow: -5 });
    assert.deepEqual(settings.levels, DEFAULT_SETTINGS.levels);
    assert.equal(settings.protectedWindow, 1);
});

test('activeSummaries() excludes folded records and sorts by startIndex — oldest first', () => {
    const list = [
        { id: 'b', startIndex: 10, folded: false },
        { id: 'a', startIndex: 0, folded: false },
        { id: 'c', startIndex: 5, folded: true },
    ];
    assert.deepEqual(activeSummaries(list).map(r => r.id), ['a', 'b']);
});

test('sortByStart() does not mutate the input array', () => {
    const list = [{ id: 'b', startIndex: 1 }, { id: 'a', startIndex: 0 }];
    sortByStart(list);
    assert.equal(list[0].id, 'b', 'original order must survive — sortByStart returns a copy');
});

// --- Scenario level (TESTING.md "Уровень 2"): real engine, real Гейты ------

function fakeFetchReplying(reply) {
    return async () => ({
        status: 200, ok: true, headers: { entries: () => [] },
        text: async () => JSON.stringify({ choices: [{ message: { content: reply } }] }),
    });
}

function buildEngine({ chat = [], fetchReply = 'A concise summary of the excerpt.', fetch = fakeFetchReplying(fetchReply) } = {}) {
    const engine = createEngine();
    const context = { chat, saveChat: async () => {} };
    registerStChatService(engine.buses.services, { getContext: () => context });
    registerChatMetadataService(engine.buses.services, { getContext: () => context });
    registerHttpService(engine.buses.network, { fetch });
    const settingsContext = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });

    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    createChatMemoryCore(engine.registerCaller('core.memory.chat', 'cores', { tier: 'official' }));
    createChatHistoryCore(engine.registerCaller('core.chatHistory', 'cores', { tier: 'official' }));

    const modelsHost = engine.registerCaller('core.models.internal', 'cores', { tier: 'official', networkAccess: true });
    const modelsCore = createInternalEngineModelsCore(modelsHost);
    modelsCore.configureWorkers([{ id: 'fast', endpoint: 'https://fast.example.com', model: 'm1', format: 'openai' }]);

    const pipelineCore = createPipelineCore(engine.registerCaller('core.pipeline', 'cores', { tier: 'official' }), { resolveAs: engine.resolveAs });
    pipelineCore.define({ id: 'generation.prepare', mode: 'collect' });
    pipelineCore.define({ id: 'generation.beforeSend', mode: 'collect' });

    const summaryCore = createBasicSummaryCore(engine.registerCaller('core.summary', 'cores', { tier: 'official' }));

    const caller = engine.registerCaller('module.probe', 'modules', {
        tier: 'community',
        allowedContracts: ['summary.settings', 'summary.configure', 'summary.list', 'summary.update', 'summary.delete', 'summary.check'],
    });

    return { engine, context, pipelineCore, summaryCore, caller };
}

function call(caller, contract, params) {
    return new Promise(resolve => caller.cores.subscribe(contract, { params }, resolve));
}

/** Каждое сообщение — своя, легко узнаваемая единица; is_system всегда false, чтобы chatHistory.messages() отдавала все N штук. */
function makeChat(count) {
    return Array.from({ length: count }, (_, i) => ({ is_user: i % 2 === 0, is_system: false, name: i % 2 === 0 ? 'Player' : 'Character', mes: `line ${i}`, send_date: `2024-01-01 @${String(i).padStart(2, '0')}h` }));
}

test('checkAndFold() does nothing below threshold — backlog has not reached a full batch yet', async () => {
    const chat = makeChat(4); // protectedWindow(2)+batchSize(3) = 5, so 4 is one short
    const { caller, summaryCore } = buildEngine({ chat });
    await summaryCore.load();
    await call(caller, 'summary.configure', { levels: [{ batchSize: 3 }], protectedWindow: 2 });

    await call(caller, 'summary.check');
    const list = await call(caller, 'summary.list');

    assert.deepEqual(list.value, []);
});

test('checkAndFold() folds the OLDEST batch the instant the threshold is crossed, and hides those real messages', async () => {
    const chat = makeChat(5); // threshold = 2+3 = 5
    const { caller, summaryCore, context } = buildEngine({ chat });
    await summaryCore.load();
    await call(caller, 'summary.configure', { levels: [{ batchSize: 3 }], protectedWindow: 2 });

    await call(caller, 'summary.check');
    const list = await call(caller, 'summary.list');

    assert.equal(list.value.length, 1);
    assert.equal(list.value[0].level, 1);
    assert.equal(list.value[0].text, 'A concise summary of the excerpt.');
    assert.deepEqual(list.value[0].coveredIds, ['0', '1', '2'], 'the OLDEST 3, not the newest');
    assert.deepEqual(context.chat.slice(0, 3).map(m => m.is_system), [true, true, true]);
    assert.deepEqual(context.chat.slice(3).map(m => m.is_system), [false, false], 'the protected tail must stay untouched');
});

test('checkAndFold() cascades: enough level-1 summaries fold into a level-2 summary automatically', async () => {
    // batchSize 2 at both levels, protectedWindow 1 (the minimum allowed — 0 is
    // clamped away, an always-empty protected buffer defeats its own purpose).
    // Threshold = 1+2 = 3. 8 raw messages -> level-1 loop stops once fewer than
    // 3 units remain: folds [0,1], [2,3], [4,5], leaves [6,7] raw/protected.
    // Level-2 then has 3 active level-1 summaries and a batch size of 2: folds
    // the OLDEST two ([0,1]+[2,3]) into one level-2, leaving the third ([4,5])
    // active on its own — not enough left for a second level-2 fold.
    const chat = makeChat(8);
    const { caller, summaryCore, context } = buildEngine({ chat });
    await summaryCore.load();
    await call(caller, 'summary.configure', { levels: [{ batchSize: 2 }, { batchSize: 2 }], protectedWindow: 1 });

    await call(caller, 'summary.check');
    const list = await call(caller, 'summary.list');

    assert.deepEqual(list.value.map(r => r.level).sort(), [1, 2]);
    const level2 = list.value.find(r => r.level === 2);
    const level1 = list.value.find(r => r.level === 1);
    assert.deepEqual([level2.startIndex, level2.endIndex], [0, 3], 'level-2 must cover the OLDEST two level-1 summaries');
    assert.deepEqual([level1.startIndex, level1.endIndex], [4, 5], 'the third level-1 summary has no partner yet, so it stays active');
    assert.equal(context.chat[6].is_system, false, 'mesid 6-7 are still beyond the fold threshold — must remain real, visible messages');
});

test('checkAndFold() clamps an out-of-range protectedWindow (e.g. 0) up to the minimum of 1 — an always-empty protected buffer defeats its own purpose', async () => {
    const { caller, summaryCore } = buildEngine({ chat: makeChat(2) });
    await summaryCore.load();

    const result = await call(caller, 'summary.configure', { protectedWindow: 0 });

    assert.equal(result.value.protectedWindow, 1);
});

test('a later batch failing mid-cascade does NOT lose an earlier batch already folded in the SAME checkAndFold() call — found live in the browser, where a real HTTP 401 on the second call would otherwise have hidden messages with no summary to show for them', async () => {
    let calls = 0;
    const fetchOnceThenFail = async () => {
        calls += 1;
        if (calls === 1) return { status: 200, ok: true, headers: { entries: () => [] }, text: async () => JSON.stringify({ choices: [{ message: { content: 'First batch summary.' } }] }) };
        return { status: 401, ok: false, headers: { entries: () => [] }, text: async () => 'Unauthorized' };
    };
    // batchSize 2, protectedWindow 1 -> threshold 3. 6 raw messages: fold [0,1]
    // (succeeds, 1st HTTP call), units drop to 4 (still >= 3) -> attempt fold
    // [2,3] (2nd HTTP call, fails) -> checkAndFold() rejects.
    const chat = makeChat(6);
    const { caller, summaryCore, context } = buildEngine({ chat, fetch: fetchOnceThenFail });
    await summaryCore.load();
    await call(caller, 'summary.configure', { levels: [{ batchSize: 2 }], protectedWindow: 1 });

    const result = await call(caller, 'summary.check');

    assert.equal(result.ok, false, 'the second batch\'s failure must surface as a real error, not be swallowed');
    const list = await call(caller, 'summary.list');
    assert.equal(list.value.length, 1, 'the FIRST batch\'s summary must survive the second batch\'s later failure');
    assert.deepEqual(list.value[0].coveredIds, ['0', '1']);
    assert.deepEqual(context.chat.slice(0, 2).map(m => m.is_system), [true, true], 'the first batch\'s messages were really hidden');
    assert.equal(context.chat[2].is_system, false, 'the second (failed) batch\'s messages must NOT have been hidden');
});

test('a later batch failing mid-cascade still announces summary.folded for the earlier batch that DID save — the panel only ever refreshes off this event, so a swallowed announcement left saved data invisible until the next page load', async () => {
    let calls = 0;
    const fetchOnceThenFail = async () => {
        calls += 1;
        if (calls === 1) return { status: 200, ok: true, headers: { entries: () => [] }, text: async () => JSON.stringify({ choices: [{ message: { content: 'First batch summary.' } }] }) };
        return { status: 401, ok: false, headers: { entries: () => [] }, text: async () => 'Unauthorized' };
    };
    const chat = makeChat(6); // same setup as the "does NOT lose an earlier batch" test above
    const { engine, caller, summaryCore } = buildEngine({ chat, fetch: fetchOnceThenFail });
    await summaryCore.load();
    await call(caller, 'summary.configure', { levels: [{ batchSize: 2 }], protectedWindow: 1 });
    const foldedEvents = [];
    engine.events.subscribe('summary.folded', payload => foldedEvents.push(payload));

    await call(caller, 'summary.check');

    assert.equal(foldedEvents.length, 1, 'the first batch\'s save must be announced even though the second batch afterward failed');
    assert.equal(foldedEvents[0].count, 1);
});

test('checkAndFold() announces summary.foldFailed with the real error message on failure — the automatic pipeline path has no other way to surface it to the user', async () => {
    const failingFetch = async () => ({ status: 401, ok: false, headers: { entries: () => [] }, text: async () => 'Unauthorized' });
    const chat = makeChat(5);
    const { engine, caller, summaryCore } = buildEngine({ chat, fetch: failingFetch });
    await summaryCore.load();
    await call(caller, 'summary.configure', { levels: [{ batchSize: 3 }], protectedWindow: 2 });
    const failures = [];
    engine.events.subscribe('summary.foldFailed', payload => failures.push(payload));

    const result = await call(caller, 'summary.check');

    assert.equal(result.ok, false);
    assert.equal(failures.length, 1);
    assert.match(failures[0].message, /HTTP 401/);
});

test('summary.update lets a person edit the generated text, and marks it edited', async () => {
    const chat = makeChat(5);
    const { caller, summaryCore } = buildEngine({ chat });
    await summaryCore.load();
    await call(caller, 'summary.configure', { levels: [{ batchSize: 3 }], protectedWindow: 2 });
    await call(caller, 'summary.check');
    const before = (await call(caller, 'summary.list')).value[0];

    const updated = await call(caller, 'summary.update', { id: before.id, text: 'Hand-edited version.' });

    assert.equal(updated.value.text, 'Hand-edited version.');
    assert.equal(updated.value.edited, true);
});

test('summary.delete removes a record for good', async () => {
    const chat = makeChat(5);
    const { caller, summaryCore } = buildEngine({ chat });
    await summaryCore.load();
    await call(caller, 'summary.configure', { levels: [{ batchSize: 3 }], protectedWindow: 2 });
    await call(caller, 'summary.check');
    const before = (await call(caller, 'summary.list')).value[0];

    await call(caller, 'summary.delete', { id: before.id });
    const after = await call(caller, 'summary.list');

    assert.deepEqual(after.value, []);
});

test('the beforeSend stage inserts every ACTIVE summary as its OWN chat message, oldest first, ahead of the real tail', async () => {
    const chat = makeChat(5);
    const { caller, summaryCore, pipelineCore } = buildEngine({ chat, fetchReply: 'S1' });
    await summaryCore.load();
    await call(caller, 'summary.configure', { levels: [{ batchSize: 3 }], protectedWindow: 2 });
    await call(caller, 'summary.check');

    const outgoing = [{ mes: 'line 3' }, { mes: 'line 4' }]; // what ST would send after its own is_system filter
    const result = await pipelineCore.run({ pipelineId: 'generation.beforeSend', input: { chat: outgoing } });

    assert.equal(outgoing.length, 3);
    assert.equal(outgoing[0].is_system, true);
    assert.match(outgoing[0].mes, /\[Summary of earlier messages #\d+–#\d+, covering .+ → .+\]\nS1$/, 'explicit Summary header with the replaced-messages period, then the text itself');
    assert.equal(outgoing[1].mes, 'line 3', 'the real tail must stay in place, right after the summary');
});

test('the beforeSend stage contributes nothing when there is no summary yet', async () => {
    const { caller, summaryCore, pipelineCore } = buildEngine({ chat: makeChat(2) });
    await summaryCore.load();
    await call(caller, 'summary.configure', { levels: [{ batchSize: 3 }], protectedWindow: 2 });
    await call(caller, 'summary.check');
    const outgoing = [{ mes: 'a' }];

    await pipelineCore.run({ pipelineId: 'generation.beforeSend', input: { chat: outgoing } });

    assert.deepEqual(outgoing, [{ mes: 'a' }]);
});

test('the beforeSend stage CUTS hidden ToolCall messages covered by a summary — ST keeps them in the prompt otherwise', async () => {
    // Живая проблема 11.09: ST'овский фильтр `is_system` имеет исключение для
    // тул-коллов (`script.js`: `!x.is_system || (canUseTools &&
    // Array.isArray(x.extra?.tool_invocations))`), поэтому `chatHistory.hide`
    // прячет обычные сообщения, а тул-коллы остаются в промпте вместе с
    // содержимым. Пара «вызов + результат» живёт ВНУТРИ одного объекта
    // (`extra.tool_invocations`), вырезание убирает её целиком.
    //
    // Граница «свежести» — от КОНЦА истории (решение архитектора 11.09):
    // тул-колл рождается в ST уже системным, «скрыт саммари» и «свежий
    // тул-колл» по is_system не различаются. Режутся только СТАРЕЕ
    // защищённого окна (protectedWindow = 2 единицы от конца).
    const chat = makeChat(6); // юниты: [0],[1,2],[3],[4],[5] (1 — тул-колл, тянет 2 в цепочку) → 5 = protectedWindow(2)+batchSize(3) → фолд покрывает 0..3
    chat[1].extra = { tool_invocations: [{ name: 'Notebook', parameters: '{"action":"write"}', result: 'Saved note.' }] }; // тул-колл ВНУТРИ сворачиваемого батча
    const { caller, summaryCore, pipelineCore } = buildEngine({ chat, fetchReply: 'S1' });
    await summaryCore.load();
    await call(caller, 'summary.configure', { levels: [{ batchSize: 3 }], protectedWindow: 2 });
    await call(caller, 'summary.check'); // сворачивает 0..3, chatHistory.hide ставит is_system=true на 0..3

    // Что ST отдал бы в перехватчик: скрывает is_system, но тул-коллы оставляет.
    // Второй тул-колл (line 4) — СВЕЖИЙ, внутри защищённого окна: его резать нельзя.
    const outgoing = [
        { mes: 'line 0', is_system: true },
        { mes: 'line 1', is_system: true, extra: { tool_invocations: [{ name: 'Notebook', parameters: '{}', result: 'Saved.' }] } },
        { mes: 'line 2', is_system: true },
        { mes: 'line 3', is_system: true },
        { mes: 'line 4', is_system: true, extra: { tool_invocations: [{ name: 'Notebook', parameters: '{}', result: 'Fresh call.' }] } },
        { mes: 'line 5' },
    ];
    const result = await pipelineCore.run({ pipelineId: 'generation.beforeSend', input: { chat: outgoing } });

    assert.equal(result.ok, true);
    const surviving = outgoing.filter(m => m.mes?.startsWith('line'));
    assert.equal(surviving.some(m => m.mes === 'line 1'), false, 'hidden ToolCall OLDER than the protected window must be CUT entirely — call AND its results');
    assert.equal(surviving.some(m => m.mes === 'line 4'), true, 'a FRESH ToolCall inside the protected window (counted from the END) must never be cut');
    // Обычные скрытые (is_system) сообщения остаются в копии — ST сам их
    // отфильтрует; вырезать нужно ТОЛЬКО тул-коллы, иначе сломаем фильтр ST.
    assert.equal(surviving.map(m => m.mes).join(','), 'line 0,line 2,line 3,line 4,line 5', 'ordinary hidden messages stay — ST filters them itself; ONLY old toolcalls are cut');
});

test('st.chatChanged re-reads summaries so a stale-empty core does not OVERWRITE old records with a new fold — real complaint: summaries of the previous session vanished, not just the freshly folded one', async () => {
    // Гонка как в жизни: `load()` движка стартует ДО того, как ST подгрузил
    // chatMetadata текущего чата (см. modules/notebook/index.js, doc-comment
    // на st.chatChanged). Симуляция: chatMetadata пуст на момент load(),
    // «диск» догружается только потом.
    const chat = makeChat(4); // protectedWindow(2)+batchSize(3) = 5 -> сам по себе фолд не случится
    const { engine, context, caller, summaryCore } = buildEngine({ chat });
    context.chatMetadata = {}; // на старте данных ещё нет — loadSummaries() увидит []
    await summaryCore.load();

    // Между тем на диске (как будто ST догрузил метаданные после старта движка) уже лежат два старых саммари.
    const oldSummaries = [
        { id: 'old_1', level: 1, coveredIds: ['0', '1'], startIndex: 0, endIndex: 1, startTime: null, endTime: null, text: 'Old summary one.', createdAt: 1, edited: false, folded: false },
        { id: 'old_2', level: 1, coveredIds: ['2', '3'], startIndex: 2, endIndex: 3, startTime: null, endTime: null, text: 'Old summary two.', createdAt: 2, edited: false, folded: false },
    ];
    context.chatMetadata = { stme_memory: { 'core.summary': { summaries: oldSummaries } } };

    // ST сменил/догрузил чат — движок должен перечитать список с диска.
    engine.events.emit('st.chatChanged', {});
    await new Promise(resolve => setImmediate(resolve)); // подписка запускает async-перезагрузку — даём ей осесть

    // Порог ещё не достигнут — фолд не добавит ничего, но и СТАРОЕ затереть не должен.
    await call(caller, 'summary.check');
    const list = await call(caller, 'summary.list');

    assert.deepEqual(list.value.map(r => r.id).sort(), ['old_1', 'old_2'], 'pre-existing summaries must survive a fold cycle that started from a stale-empty core');
});

test('st.chatChanged publishes summary.reloaded with the fresh active count — the panel refreshes without a manual Fold', async () => {
    // Панель движка перечитывает список ТОЛЬКО по событиям (doc-comment
    // engine-panel.js на summary.folded). Без события после перезагрузки
    // списка при смене чата она показывала саммари ПРОШЛОГО чата до ручного
    // «Fold now» — сам тест краснеет, если убрать publishEvent('summary.
    // reloaded') из reloadSummariesForChat().
    const chat = makeChat(4);
    const { engine, context, summaryCore } = buildEngine({ chat });
    const reloaded = [];
    engine.events.subscribe('summary.reloaded', payload => reloaded.push(payload));

    // В чате уже лежат два старых саммари (об «активных»).
    context.chatMetadata = { stme_memory: { 'core.summary': { summaries: [
        { id: 'old_1', level: 1, coveredIds: ['0', '1'], startIndex: 0, endIndex: 1, startTime: null, endTime: null, text: 'Old one.', createdAt: 1, edited: false, folded: false },
        { id: 'old_2', level: 1, coveredIds: ['2', '3'], startIndex: 2, endIndex: 3, startTime: null, endTime: null, text: 'Old two.', createdAt: 2, edited: false, folded: true },
    ] } } };
    await summaryCore.load();
    // Загрузка при старте НЕ через chatChanged — события быть не должно.
    assert.equal(reloaded.length, 0);

    engine.events.emit('st.chatChanged', {});
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(reloaded.length, 1);
    // Счётчик — по АКТИВНЫМ (не folded): один из двух записей скрыт уровнем выше.
    assert.deepEqual(reloaded[0], { count: 1 });
});

// --- Proving the threshold guard actually guards (project discipline) -----
// Verified during development, not just asserted here: temporarily reverting
// shouldFold() to `unitCount >= protectedWindow` (dropping `+ batchSize`) made
// BOTH 'checkAndFold() does nothing below threshold' and the cascade test fail
// loudly (4 summaries created instead of 3, extra beforeSend contributions
// where none were expected) — confirming these tests really do pin the
// `+ batchSize` behavior and are not vacuously true. Restored immediately
// after, full suite re-confirmed green.
