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
        allowedContracts: ['stChat.messages', 'stChat.setHidden'],
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

test('a Модуль without the right to stChat.setHidden is refused before the Сервис is ever reached', async () => {
    const { engine, context } = buildService([{ is_user: false, is_system: false, mes: 'A' }]);
    const untrusted = engine.registerCaller('module.untrusted', 'modules', { tier: 'community', allowedContracts: [] });

    const result = await call(untrusted, 'stChat.setHidden', { mesid: '0', hidden: true });

    assert.equal(result.ok, false);
    assert.equal(context.chat[0].is_system, false, 'the Гейт must block the write, not just the response');
});
