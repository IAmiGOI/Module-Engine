import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerStChatService } from '../services/st-chat.js';

/**
 * Сервис уровня (TESTING.md "Уровень 1") — реальный движок, реальная Шина
 * сервисов, но `getContext()` — фейк. Поля `sendDate`/`isToolCall`/
 * `hasReasoning` и запись `stChat.setHidden` нужны BasicSummary (ROADMAP.md):
 * без первых нечем отличить ToolCall-цепочку/CoT от простого сообщения при
 * подсчёте порога свёртки, без второй — нечем скрыть старое сообщение, не
 * сдвинув `mesid` остальных (см. doc-comment services/st-chat.js).
 */

function buildService(chat = [], contextExtra = {}) {
    const engine = createEngine();
    const context = { chat, saveChat: async () => {}, ...contextExtra };
    registerStChatService(engine.buses.services, { getContext: () => context });
    const caller = engine.registerCaller('module.probe', 'modules', {
        tier: 'community',
        allowedContracts: [
            'stChat.messages', 'stChat.setHidden', 'stChat.setText',
            'stChat.deleteMessage', 'stChat.swipe', 'stChat.regenerate', 'stChat.formatMessage',
        ],
    });
    return { engine, context, caller };
}

function call(caller, contract, params) {
    return new Promise(resolve => caller.services.subscribe(contract, { params }, resolve));
}

test('stChat.messages exposes sendDate/isToolCall/hasReasoning alongside the existing fields', async () => {
    const { caller } = buildService([
        { is_user: true, is_system: false, mes: 'Hi', send_date: '2024-01-01 @12h00m00s' },
        { is_user: false, is_system: false, mes: 'Calling a tool', extra: { tool_invocations: [{ id: 't1' }] } },
        { is_user: false, is_system: false, mes: 'Thinking then answering', extra: { reasoning: 'because...' } },
    ]);

    const result = await call(caller, 'stChat.messages', { limit: 10 });

    assert.equal(result.ok, true);
    assert.equal(result.value[0].sendDate, '2024-01-01 @12h00m00s');
    assert.equal(result.value[0].isToolCall, false);
    assert.equal(result.value[0].hasReasoning, false);
    assert.equal(result.value[1].isToolCall, true);
    assert.equal(result.value[2].hasReasoning, true);
});

test('stChat.messages treats an empty tool_invocations array as NOT a tool call', async () => {
    const { caller } = buildService([
        { is_user: false, is_system: false, mes: 'Plain reply', extra: { tool_invocations: [] } },
    ]);

    const result = await call(caller, 'stChat.messages', { limit: 10 });

    assert.equal(result.value[0].isToolCall, false);
});

test('stChat.messages exposes swipeIndex/swipeCount/reasoningText/avatarUrl for Chat Viewport chrome', async () => {
    const { caller } = buildService([
        { is_user: false, is_system: false, mes: 'B', swipe_id: 2, swipes: ['A', 'B', 'C'], extra: { reasoning: 'thinking...' } },
        { is_user: true, is_system: false, mes: 'Hi', force_avatar: 'personas/me.png' },
    ]);

    const result = await call(caller, 'stChat.messages', { limit: 10 });

    assert.equal(result.value[0].swipeIndex, 2);
    assert.equal(result.value[0].swipeCount, 3);
    assert.equal(result.value[0].reasoningText, 'thinking...');
    assert.equal(result.value[0].avatarUrl, null);
    assert.equal(result.value[1].avatarUrl, 'personas/me.png');
});

test('stChat.messages resolves a non-user message\'s avatar from characters[characterId] (via getThumbnailUrl) when force_avatar is absent — same logic as ST\'s own updateMessageElement()', async () => {
    const { caller } = buildService(
        [{ is_user: false, is_system: false, mes: 'Reply', name: 'Alice' }],
        {
            characters: [{ avatar: 'alice.png' }],
            characterId: 0,
            getThumbnailUrl: (type, file) => `/thumbnail?type=${type}&file=${file}`,
        },
    );

    const result = await call(caller, 'stChat.messages', { limit: 10 });

    assert.equal(result.value[0].avatarUrl, '/thumbnail?type=avatar&file=alice.png');
});

test('stChat.messages avatar resolution: force_avatar always wins over characters[characterId] — a persona/voice override must not be shadowed by the "current character"', async () => {
    const { caller } = buildService(
        [{ is_user: false, is_system: false, mes: 'Reply', force_avatar: 'override.png' }],
        { characters: [{ avatar: 'alice.png' }], characterId: 0, getThumbnailUrl: (t, f) => `/thumb/${f}` },
    );

    const result = await call(caller, 'stChat.messages', { limit: 10 });

    assert.equal(result.value[0].avatarUrl, 'override.png');
});

test('stChat.messages avatar resolution treats characters[characterId].avatar === "none" as no avatar, not a literal filename', async () => {
    const { caller } = buildService(
        [{ is_user: false, is_system: false, mes: 'Reply' }],
        { characters: [{ avatar: 'none' }], characterId: 0, getThumbnailUrl: (t, f) => `/thumb/${f}` },
    );

    const result = await call(caller, 'stChat.messages', { limit: 10 });

    assert.equal(result.value[0].avatarUrl, null);
});

test('stChat.messages avatar resolution never applies characters[characterId] to a USER message — that would show the character\'s avatar on the player\'s own line', async () => {
    const { caller } = buildService(
        [{ is_user: true, is_system: false, mes: 'Hi' }],
        { characters: [{ avatar: 'alice.png' }], characterId: 0, getThumbnailUrl: (t, f) => `/thumb/${f}` },
    );

    const result = await call(caller, 'stChat.messages', { limit: 10 });

    assert.equal(result.value[0].avatarUrl, null);
});

test('stChat.messages computes genDurationMs from gen_started/gen_finished, the same pair ST\'s own formatGenerationTimer() uses', async () => {
    const { caller } = buildService([
        { is_user: false, is_system: false, mes: 'Reply', gen_started: '2024-01-01T00:00:00.000Z', gen_finished: '2024-01-01T00:00:02.500Z' },
    ]);

    const result = await call(caller, 'stChat.messages', { limit: 10 });

    assert.equal(result.value[0].genDurationMs, 2500);
});

test('stChat.messages returns null (not 0) genDurationMs when ST never set gen_started/gen_finished — a user message, or an old chat predating these fields', async () => {
    const { caller } = buildService([{ is_user: true, is_system: false, mes: 'Hi' }]);

    const result = await call(caller, 'stChat.messages', { limit: 10 });

    assert.equal(result.value[0].genDurationMs, null);
});

test('stChat.messages defaults swipeCount to 1 (not 0) and swipeIndex to 0 when ST never set swipe fields — a single-version message is still "1 of 1"', async () => {
    const { caller } = buildService([{ is_user: false, is_system: false, mes: 'Only version' }]);

    const result = await call(caller, 'stChat.messages', { limit: 10 });

    assert.equal(result.value[0].swipeIndex, 0);
    assert.equal(result.value[0].swipeCount, 1);
});

test('stChat.messages defaults sendDate to null when ST never set one', async () => {
    const { caller } = buildService([{ is_user: true, is_system: false, mes: 'Hi' }]);

    const result = await call(caller, 'stChat.messages', { limit: 10 });

    assert.equal(result.value[0].sendDate, null);
});

test('stChat.setHidden flips is_system on the real chat message AND saves', async () => {
    let saved = false;
    const { caller, context } = buildService(
        [{ is_user: false, is_system: false, mes: 'Old message' }],
        { saveChat: async () => { saved = true; } },
    );

    const result = await call(caller, 'stChat.setHidden', { mesid: '0', hidden: true });

    assert.equal(result.ok, true);
    assert.equal(context.chat[0].is_system, true);
    assert.equal(saved, true, 'ST\'s real saveChat must be called, or the hide would not survive a reload');
});

test('stChat.setHidden can un-hide too, and still does not touch neighboring mesids', async () => {
    const { caller, context } = buildService([
        { is_user: false, is_system: true, mes: 'A' },
        { is_user: false, is_system: false, mes: 'B' },
    ]);

    await call(caller, 'stChat.setHidden', { mesid: '0', hidden: false });

    assert.equal(context.chat[0].is_system, false);
    assert.equal(context.chat[1].is_system, false, 'unrelated mesid must stay untouched');
});

test('stChat.setHidden on an out-of-range mesid fails with a clear error, never hangs or throws unhandled', async () => {
    const { caller } = buildService([{ is_user: false, is_system: false, mes: 'Only one' }]);

    const result = await call(caller, 'stChat.setHidden', { mesid: '5', hidden: true });

    assert.equal(result.ok, false);
    assert.match(result.error.message, /mesid/);
});

test('stChat.setText edits ANY message (user included) — the old BasicSummary-only "not user" restriction is gone for general editing', async () => {
    const { caller, context } = buildService([{ is_user: true, is_system: false, mes: 'Old text' }]);

    const result = await call(caller, 'stChat.setText', { mesid: '0', text: 'New text' });

    assert.equal(result.ok, true);
    assert.equal(context.chat[0].mes, 'New text');
});

test('stChat.setText emits MESSAGE_EDITED before the redraw and MESSAGE_UPDATED after, so other ST subscribers (translation, memory) learn about the edit', async () => {
    const emitted = [];
    const eventTypes = { MESSAGE_EDITED: 'message_edited', MESSAGE_UPDATED: 'message_updated' };
    const { caller } = buildService(
        [{ is_user: false, is_system: false, mes: 'Old' }],
        {
            eventTypes,
            eventSource: { emit: async (name, index) => emitted.push([name, index]) },
            updateMessageBlock: () => emitted.push(['updateMessageBlock']),
        },
    );

    await call(caller, 'stChat.setText', { mesid: '0', text: 'New' });

    assert.deepEqual(emitted, [
        ['message_edited', 0],
        ['updateMessageBlock'],
        ['message_updated', 0],
    ]);
});

test('stChat.setText rejects empty text with a clear error', async () => {
    const { caller } = buildService([{ is_user: false, is_system: false, mes: 'Old' }]);

    const result = await call(caller, 'stChat.setText', { mesid: '0', text: '   ' });

    assert.equal(result.ok, false);
    assert.match(result.error.message, /"text" is required/);
});

test('stChat.deleteMessage calls SillyTavern\'s own deleteMessage(index, undefined, false) — no confirmation popup, that is Chat Viewport\'s own UI\'s job', async () => {
    const calls = [];
    const { caller } = buildService(
        [{ is_user: false, is_system: false, mes: 'A' }],
        { deleteMessage: async (...args) => calls.push(args) },
    );

    const result = await call(caller, 'stChat.deleteMessage', { mesid: '0' });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, [[0, undefined, false]]);
});

test('stChat.deleteMessage with an invalid mesid fails clearly instead of calling ST with NaN', async () => {
    const { caller } = buildService([{ is_user: false, is_system: false, mes: 'A' }]);

    const result = await call(caller, 'stChat.deleteMessage', { mesid: 'not-a-number' });

    assert.equal(result.ok, false);
    assert.match(result.error.message, /invalid mesid/);
});

test('stChat.swipe passes null as the event (ST\'s own swipe_left/swipe_right explicitly accept no real DOM event) and the exact chat message object as "message", not just its index', async () => {
    const calls = [];
    const targetMessage = { is_user: false, is_system: false, mes: 'B' };
    const { caller } = buildService(
        [{ is_user: false, is_system: false, mes: 'A' }, targetMessage],
        {
            swipe_left: async (...args) => calls.push(['left', ...args]),
            swipe_right: async (...args) => calls.push(['right', ...args]),
        },
    );

    await call(caller, 'stChat.swipe', { mesid: '1', direction: 'left' });
    await call(caller, 'stChat.swipe', { mesid: '1', direction: 'right' });

    assert.deepEqual(calls, [
        ['left', null, { message: targetMessage }],
        ['right', null, { message: targetMessage }],
    ]);
});

test('stChat.regenerate calls ST\'s generate("regenerate") — the same call ST\'s own regenerate button makes, no mesid needed since ST targets the current last message itself', async () => {
    const calls = [];
    const { caller } = buildService([{ is_user: false, is_system: false, mes: 'A' }], {
        generate: async type => calls.push(type),
    });

    const result = await call(caller, 'stChat.regenerate', {});

    assert.equal(result.ok, true);
    assert.deepEqual(calls, ['regenerate']);
});

test('stChat.formatMessage forwards the message\'s own text/name/isSystem/isUser/mesid straight to ST\'s messageFormatting(), so Chat Viewport never has to know the shape of context.chat', async () => {
    const calls = [];
    const { caller } = buildService(
        [{ is_user: false, is_system: false, mes: 'Hello *world*', name: 'Alice' }],
        { messageFormatting: (...args) => { calls.push(args); return '<p>Hello <em>world</em></p>'; } },
    );

    const result = await call(caller, 'stChat.formatMessage', { mesid: '0' });

    assert.equal(result.ok, true);
    assert.equal(result.value, '<p>Hello <em>world</em></p>');
    assert.deepEqual(calls[0], ['Hello *world*', 'Alice', false, false, 0, {}, false]);
});

test('a Модуль without the right to stChat.setHidden is refused before the Сервис is ever reached', async () => {
    const { engine, context } = buildService([{ is_user: false, is_system: false, mes: 'A' }]);
    const untrusted = engine.registerCaller('module.untrusted', 'modules', { tier: 'community', allowedContracts: [] });

    const result = await call(untrusted, 'stChat.setHidden', { mesid: '0', hidden: true });

    assert.equal(result.ok, false);
    assert.equal(context.chat[0].is_system, false, 'the Гейт must block the write, not just the response');
});
