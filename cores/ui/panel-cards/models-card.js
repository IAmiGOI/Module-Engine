import { signal, computed } from '../reactive.js';
import { h } from '../tree.js';
import { Button, TextInput, NumberInput, Select, Field, Row, Card, Section, EditableList, Badge } from '../../../libraries/shared/widgets.js';
import { ST_MAIN_FORMAT, ST_MAIN_WORKER_ID } from '../../../libraries/core/st-main-request.js';
import { nextUid } from './uid.js';
import { JEV_DEFAULT_ENDPOINT, JEV_DEFAULT_MODEL, JEV_DEFAULT_TIMEOUT_MS } from '../../../libraries/core/jev-request.js';

const FORMATS = Object.freeze([
    { value: 'openai', label: 'OpenAI-compatible' },
    { value: 'anthropic', label: 'Anthropic' },
    { value: 'google', label: 'Google Gemini' },
    { value: ST_MAIN_FORMAT, label: 'SillyTavern main connection' },
]);
const STATE_BADGES = Object.freeze({ up: ['Up', 'ok'], degraded: ['Unstable', 'muted'], down: ['Down', 'error'], unknown: ['Not checked', 'muted'] });

/** Плоская запись воркера → набор сигналов для правки, со стабильным ключом (id можно менять, ключ — нет, иначе строка пересоздаётся на каждую букву). */
function toRecord(worker = {}) {
    return {
        key: `worker_${nextUid()}`,
        id: signal(worker.id ?? ''),
        format: signal(worker.format ?? 'openai'),
        endpoint: signal(worker.endpoint ?? ''),
        apiKey: signal(worker.apiKey ?? ''),
        model: signal(worker.model ?? ''),
        // Сколько запросов воркер тянет одновременно: локальная модель — 1, облачный API — больше (dispatch-queue.js).
        maxConcurrent: signal(Math.max(1, Math.floor(Number(worker.maxConcurrent) || 1))),
        // Не строка статуса, а КРАТКОВРЕМЕННОЕ состояние блока: '' | 'testing' |
        // 'ok' | 'error'. Результат словами уходит в уведомления, здесь
        // остаётся только вспышка обводки — она относится к КОНКРЕТНОМУ
        // подключению, и показывать её надо на нём, а не строкой под ним.
        flash: signal(''),
    };
}

function fromRecord(record) {
    return {
        id: record.id.peek().trim(),
        format: record.format.peek(),
        endpoint: record.endpoint.peek().trim(),
        apiKey: record.apiKey.peek(),
        model: record.model.peek().trim(),
        maxConcurrent: Math.max(1, Math.min(64, Math.floor(Number(record.maxConcurrent.peek()) || 1))),
    };
}

/** Подключение к классификатору (Jev и подобные): отдельная категория моделей, у неё нет генерации текста, поэтому своего формата и очереди нет. */
function toClassifierRecord(connection = {}) {
    return {
        key: `classifier_${nextUid()}`,
        id: signal(connection.id ?? ''),
        endpoint: signal(connection.endpoint ?? ''),
        apiKey: signal(connection.apiKey ?? ''),
        model: signal(connection.model ?? ''),
        timeoutMs: signal(connection.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS),
        flash: signal(''),
    };
}

function fromClassifierRecord(record) {
    return { id: record.id.peek().trim(), endpoint: record.endpoint.peek().trim(), apiKey: record.apiKey.peek(), model: record.model.peek().trim(), timeoutMs: Number(record.timeoutMs.peek()) || JEV_DEFAULT_TIMEOUT_MS };
}

function formatAgo(at) {
    if (!at) return 'never';
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    return `${Math.round(seconds / 3600)}h ago`;
}

/** Строка живого состояния воркера (`model.workers.status`): надёжность, задержка, сбои недоступности, последняя ошибка. */
function statusLine(entry) {
    if (!entry) return h('small', { class: 'stme-module-hint' }, 'Not checked yet — save the list to start monitoring.');
    const [label, tone] = STATE_BADGES[entry.state] ?? STATE_BADGES.unknown;
    const parts = [
        entry.reliability === null ? null : `reliability ${Math.round(entry.reliability * 100)}%`,
        entry.latencyMs === null ? null : `~${entry.latencyMs}ms`,
        `ok ${entry.totals.success} · unavailable ${entry.totals.unavailable} · rejected ${entry.totals.rejected}`,
        `running ${entry.running}/${entry.maxConcurrent}${entry.waiting ? ` · ${entry.waiting} waiting` : ''}`,
        `checked ${formatAgo(entry.lastProbeAt)}`,
    ].filter(Boolean);
    return h('div', { class: 'stme-worker-status' },
        Row(Badge(entry.probing ? 'Checking…' : label, { tone: entry.probing ? 'muted' : tone }), h('small', { class: 'stme-module-hint' }, parts.join(' · '))),
        entry.lastError ? h('small', { class: 'stme-module-hint', title: entry.lastError.message }, `Last error (${formatAgo(entry.lastError.at)}): ${entry.lastError.message}`) : null);
}

/**
 * Карточка «Model connections»: список подключений к моделям (`model.workers.get/set`, проверка `model.generate`) и их живое
 * состояние (`model.workers.status`, событие `model.workers.status.changed`, «Check now» — `model.workers.probe`).
 */
export function createModelsCard(deps) {
    const { call, callService, workers, notify, flash, collapse } = deps;
    const statusById = signal({});
    const mainConnection = signal(null);
    const classifiers = signal([]);

    function applyStatus(list) {
        statusById.set(Object.fromEntries((list ?? []).map(entry => [entry.workerId, entry])));
    }

    async function loadWorkers() {
        const result = await call('model.workers.get');
        workers.set((result.ok ? result.value ?? [] : []).map(toRecord));
        const status = await call('model.workers.status');
        if (status.ok) applyStatus(status.value);
        const main = callService ? await callService('stGeneration.mainConnection') : null;
        mainConnection.set(main?.ok ? main.value : null);
        await loadClassifiers();
    }

    async function loadClassifiers() {
        const result = await call('classifier.connections.get');
        classifiers.set((result.ok ? result.value ?? [] : []).map(toClassifierRecord));
    }

    async function saveClassifiers() {
        const list = classifiers.peek().map(fromClassifierRecord).filter(connection => connection.id);
        const result = await call('classifier.connections.set', { connections: list });
        await notify(result.ok ? 'ok' : 'error', result.ok ? `Saved ${list.length} classifier${list.length === 1 ? '' : 's'}` : result.error.message);
        return result.ok;
    }

    async function testClassifier(record) {
        const id = record.id.peek().trim();
        if (!id) { await notify('error', 'Give the classifier a name first'); flash(record.flash, 'error'); return; }
        // Как и у текстовых моделей: тест идёт по СОХРАНЁННОЙ конфигурации.
        await saveClassifiers();
        record.flash.set('testing');
        const result = await call('classifier.test', { connectionId: id });
        const ok = result.ok && result.value.ok;
        flash(record.flash, ok ? 'ok' : 'error');
        await notify(ok ? 'ok' : 'error', ok ? `${id}: works — ${Math.round(result.value.chance * 100)}% in ${result.value.ms}ms` : `${id}: ${result.ok ? result.value.error : result.error.message}`);
    }

    function addClassifier() {
        classifiers.set([...classifiers.peek(), toClassifierRecord({ id: classifiers.peek().length ? `classifier_${classifiers.peek().length + 1}` : 'jev', endpoint: JEV_DEFAULT_ENDPOINT, model: JEV_DEFAULT_MODEL })]);
    }

    function classifierRow(record) {
        return Section(record.id, {
            key: record.key,
            className: computed(() => (record.flash() ? `stme-flash stme-flash-${record.flash()}` : '')),
            ...collapse.bind(`classifier:${record.key}`),
            actions: [Button('Test', () => testClassifier(record)), Button('Remove', () => classifiers.set(classifiers.peek().filter(item => item !== record)), { variant: 'danger' })],
        },
        Row(Field('Name', TextInput(record.id, { placeholder: 'jev' })), Field('Timeout, ms', NumberInput(record.timeoutMs, { min: 500, max: 20000, step: 100 }))),
        Field('Endpoint', TextInput(record.endpoint, { placeholder: JEV_DEFAULT_ENDPOINT })),
        Row(Field('API key', TextInput(record.apiKey, { type: 'password', placeholder: 'required' })), Field('Model', TextInput(record.model, { placeholder: JEV_DEFAULT_MODEL }))));
    }

    function classifiersCard() {
        return Card('Classifiers', {
            ...collapse.bind('card:classifiers'),
            subtitle: 'Small models that rate how likely a statement about the chat is (for example Jev). A Prompt Manager block can be sent only when one of them finds a statement likely enough. If the classifier does not answer in time, the block is sent.',
        },
        EditableList({
            items: classifiers,
            renderItem: classifierRow,
            onAdd: addClassifier,
            addLabel: '+ Add classifier',
            empty: 'No classifiers yet. Add Jev (OpenRouter or NanoGPT) to let prompt blocks depend on the chat.',
            actions: [Button('Save', saveClassifiers)],
        }));
    }

    async function checkNow(record) {
        const id = record?.id.peek().trim();
        const result = await call('model.workers.probe', id ? { workerId: id } : {});
        if (!result.ok) { await notify('error', result.error.message); return; }
        const down = result.value.filter(entry => entry.state === 'down' || entry.state === 'degraded');
        await notify(down.length ? 'error' : 'ok', down.length ? `${down.map(entry => entry.workerId).join(', ')}: not stable` : 'All checked connections answered');
    }

    async function saveWorkers() {
        const list = workers.peek().map(fromRecord).filter(worker => worker.id);
        const result = await call('model.workers.set', { workers: list });
        await notify(result.ok ? 'ok' : 'error',
            result.ok ? `Saved ${list.length} connection${list.length === 1 ? '' : 's'}` : result.error.message);
        return result.ok;
    }

    async function testWorker(record) {
        const id = record.id.peek().trim();
        if (!id) { await notify('error', 'Give the connection a name first'); flash(record.flash, 'error'); return; }
        // Тест идёт по СОХРАНЁННОЙ конфигурации: иначе «работает» означало бы
        // «работало бы, если бы ты нажал сохранить» — худший вид зелёной галочки.
        await saveWorkers();
        record.flash.set('testing');
        const startedAt = Date.now();
        const result = await call('model.generate', { prompt: 'Reply with exactly: OK', maxTokens: 16, workerId: id });
        flash(record.flash, result.ok ? 'ok' : 'error');
        await notify(result.ok ? 'ok' : 'error',
            result.ok ? `${id}: OK in ${Date.now() - startedAt}ms` : `${id}: ${result.error.message}`);
    }

    function removeWorker(record) {
        workers.set(workers.peek().filter(item => item !== record));
    }

    function addWorker() {
        workers.set([...workers.peek(), toRecord({ id: `connection_${workers.peek().length + 1}`, format: 'openai' })]);
    }

    /** Основное подключение ST — обычный воркер со своим форматом: адрес, ключ и модель берутся из текущих настроек ST. */
    function addMainConnection() {
        if (workers.peek().some(record => record.format.peek() === ST_MAIN_FORMAT)) { notify('error', 'SillyTavern main connection is already in the list'); return; }
        workers.set([...workers.peek(), toRecord({ id: ST_MAIN_WORKER_ID, format: ST_MAIN_FORMAT })]);
    }

    function mainConnectionHint() {
        const main = mainConnection();
        if (!main) return 'Uses the API, model and key selected in SillyTavern right now.';
        if (!main.supported) return `SillyTavern's current API (${main.api || 'unknown'}) cannot be used here — switch ST to Chat Completion or Text Completion.`;
        return `Uses SillyTavern's current connection: ${[main.source, main.model].filter(Boolean).join(' · ') || main.api}. Change it in ST — this follows.`;
    }

    function workerRow(record) {
        // Section, а не Card: рамку рисует «Model connections» сверху, а вложенность
        // внутри неё видна по фону.
        return Section(record.id, {
            key: record.key,
            className: computed(() => (record.flash() ? `stme-flash stme-flash-${record.flash()}` : '')),
            ...collapse.bind(`worker:${record.key}`),
            actions: [
                Button('Test', () => testWorker(record)),
                Button('Check now', () => checkNow(record)),
                Button('Remove', () => removeWorker(record), { variant: 'danger' }),
            ],
        },
            computed(() => statusLine(statusById()[record.id().trim()])),
            Row(
                Field('Name', TextInput(record.id, { placeholder: 'my-connection' })),
                Field('Format', Select(record.format, FORMATS)),
                Field('Parallel requests', NumberInput(record.maxConcurrent, { min: 1, max: 64 })),
            ),
            computed(() => (record.format() === ST_MAIN_FORMAT
                ? h('small', { class: 'stme-module-hint' }, mainConnectionHint())
                : h('div', {},
                    Field('Endpoint', TextInput(record.endpoint, { placeholder: 'https://api.example.com/v1' })),
                    Row(
                        Field('API key', TextInput(record.apiKey, { type: 'password', placeholder: 'optional for local' })),
                        Field('Model', TextInput(record.model, { placeholder: 'model name' })),
                    )))),
        );
    }

    function modelsCard() {
        // Save живёт ВНУТРИ блока, а не в шапке: шапка — отдельная полоса с
        // своим фоном, и кнопка в ней читается как относящаяся к разделу
        // целиком, а не к списку под ней.
        return Card('Model connections', {
            ...collapse.bind('card:models'),
            subtitle: 'Where the engine gets its own generations from. Each connection is checked every 10 minutes; unstable ones get fewer requests.',
        },
            EditableList({
                items: workers,
                renderItem: workerRow,
                onAdd: addWorker,
                addLabel: '+ Add connection',
                empty: 'No connections yet. Add one to let the engine run its own model calls.',
                actions: [
                    Button('Save', saveWorkers),
                    Button('+ SillyTavern main connection', addMainConnection),
                    Button('Check all', () => checkNow(null)),
                ],
            }),
        );
    }

    return { loadWorkers, modelsCard, classifiersCard, applyStatus };
}
