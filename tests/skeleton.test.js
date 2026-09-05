import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';

/**
 * ROADMAP.md step 3 — "простой, но уже структурный билд": один фиктивный
 * Модуль зовёт один фиктивный Ядро, которое само зовёт один фиктивный
 * Сервис — три домена подряд (Модуль → Ядро → Сервис), каждый переход
 * через настоящий Гейт с настоящей проверкой прав, ответ реально
 * возвращается всю дорогу назад. Единственное, что здесь "фиктивно" — САМИ
 * Ядро/Модуль/Сервис (никакого реального Tracker/Macros/HTTP ещё не
 * написано); механизм связности, через который они говорят — настоящий,
 * не заглушка. Это и есть первый сценарный тест уровня 2 (TESTING.md).
 */

function setupSkeleton() {
    const engine = createEngine();

    // Фиктивный Сервис — единственная вещь, которая в РЕАЛЬНОЙ системе
    // трогала бы что-то за пределами движка (см. ARCHITECTURE.md). Сервисы
    // не заводятся через registerCaller/domain здесь напрямую — реальный
    // Сервис регистрируется на Шине сервисов так же, как поставщик любого
    // другого контракта.
    engine.buses.services.register('http.request', ({ prompt }) => `[model reply to: ${prompt}]`);

    // Фиктивное Ядро — само зовёт Сервис через СВОЙ Гейт (Ядро -> Сервис),
    // затем оборачивает результат.
    const core = engine.registerCaller('core.demo', 'cores', {
        tier: 'community',
        allowedContracts: ['http.request'],
    });
    core.own.register('demo.generate', async ({ prompt }) => {
        const serviceResult = await new Promise(resolve => core.services.subscribe('http.request', { params: { prompt } }, resolve));
        if (!serviceResult.ok) throw new Error(`upstream service failed: ${serviceResult.error.message}`);
        return `Core wrapped: ${serviceResult.value}`;
    });

    return engine;
}

test('a fictional Module reaches a fictional Core, which itself reaches a fictional Service — the whole 3-domain chain works end to end', async () => {
    const engine = setupSkeleton();
    const trustedModule = engine.registerCaller('module.demo', 'modules', {
        tier: 'community',
        allowedContracts: ['demo.generate'],
    });

    const result = await new Promise(resolve => trustedModule.cores.subscribe('demo.generate', { params: { prompt: 'hello' } }, resolve));

    assert.deepEqual(result, { ok: true, value: 'Core wrapped: [model reply to: hello]' });
});

test('a Module without rights to the Core\'s contract is refused before the Core — and therefore the Service behind it — ever runs', async () => {
    const engine = setupSkeleton();
    let coreHandlerRan = false;
    engine.buses.cores.register('tripwire.shouldNeverRun', () => { coreHandlerRan = true; });
    const untrustedModule = engine.registerCaller('module.untrusted', 'modules', { tier: 'community', allowedContracts: [] });

    const result = await new Promise(resolve => untrustedModule.cores.subscribe('demo.generate', {}, resolve));

    assert.equal(result.ok, false);
    assert.equal(coreHandlerRan, false, 'sanity check that this scenario CAN detect an inner call — a denied outer request must never reach that far');
});

test('the Core\'s OWN lack of rights to the Service stops the chain too, surfaced back to the Module as a normal failure envelope', async () => {
    const engine = createEngine();
    engine.buses.services.register('http.request', () => 'should never be reached');
    // This Core is deliberately NOT granted "http.request" — its own attempt
    // to reach the Service must be refused by ITS Gate, exactly like the
    // Module-level refusal above, just one hop deeper in the chain.
    const underprivilegedCore = engine.registerCaller('core.underprivileged', 'cores', { tier: 'community', allowedContracts: [] });
    underprivilegedCore.own.register('demo.generate', async ({ prompt }) => {
        const serviceResult = await new Promise(resolve => underprivilegedCore.services.subscribe('http.request', { params: { prompt } }, resolve));
        if (!serviceResult.ok) throw new Error(`upstream service failed: ${serviceResult.error.message}`);
        return serviceResult.value;
    });
    const module = engine.registerCaller('module.demo', 'modules', { tier: 'community', allowedContracts: ['demo.generate'] });

    const result = await new Promise(resolve => module.cores.subscribe('demo.generate', { params: { prompt: 'x' } }, resolve));

    assert.equal(result.ok, false);
    assert.match(result.error.message, /upstream service failed/);
});

test('the same 3-domain chain also runs on a "when" event condition, echoing a real generation-lifecycle trigger (PIPELINE.md)', async () => {
    const engine = setupSkeleton();
    const module = engine.registerCaller('module.demo', 'modules', { tier: 'community', allowedContracts: ['demo.generate'] });

    const deliveries = [];
    module.cores.subscribe('demo.generate', { params: { prompt: 'ping' }, when: { event: 'generation.beforeSend' } }, r => deliveries.push(r));

    assert.equal(deliveries.length, 0, 'must not fire before the lifecycle event at all');
    engine.events.emit('generation.beforeSend');
    await flushMicrotasks();

    assert.deepEqual(deliveries, [{ ok: true, value: 'Core wrapped: [model reply to: ping]' }]);
});

async function flushMicrotasks(rounds = 10) {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
}
