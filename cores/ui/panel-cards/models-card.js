import { signal, computed } from '../reactive.js';
import { Button, TextInput, Select, Field, Row, Card, Section, EditableList } from '../../../libraries/shared/widgets.js';
import { nextUid } from './uid.js';

const FORMATS = Object.freeze([
    { value: 'openai', label: 'OpenAI-compatible' },
    { value: 'anthropic', label: 'Anthropic' },
    { value: 'google', label: 'Google Gemini' },
]);

/** Плоская запись воркера → набор сигналов для правки, со стабильным ключом (id можно менять, ключ — нет, иначе строка пересоздаётся на каждую букву). */
function toRecord(worker = {}) {
    return {
        key: `worker_${nextUid()}`,
        id: signal(worker.id ?? ''),
        format: signal(worker.format ?? 'openai'),
        endpoint: signal(worker.endpoint ?? ''),
        apiKey: signal(worker.apiKey ?? ''),
        model: signal(worker.model ?? ''),
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
    };
}

/** Карточка «Model connections»: список подключений к моделям (`model.workers.get/set`, проверка `model.generate`). */
export function createModelsCard(deps) {
    const { call, workers, notify, flash, collapse } = deps;

    async function loadWorkers() {
        const result = await call('model.workers.get');
        workers.set((result.ok ? result.value ?? [] : []).map(toRecord));
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

    function workerRow(record) {
        // Section, а не Card: рамку рисует «Model connections» сверху, а вложенность
        // внутри неё видна по фону.
        return Section(record.id, {
            key: record.key,
            className: computed(() => (record.flash() ? `stme-flash stme-flash-${record.flash()}` : '')),
            ...collapse.bind(`worker:${record.key}`),
            actions: [Button('Test', () => testWorker(record)), Button('Remove', () => removeWorker(record), { variant: 'danger' })],
        },
            Row(
                Field('Name', TextInput(record.id, { placeholder: 'my-connection' })),
                Field('Format', Select(record.format, FORMATS)),
            ),
            Field('Endpoint', TextInput(record.endpoint, { placeholder: 'https://api.example.com/v1' })),
            Row(
                Field('API key', TextInput(record.apiKey, { type: 'password', placeholder: 'optional for local' })),
                Field('Model', TextInput(record.model, { placeholder: 'model name' })),
            ),
        );
    }

    function modelsCard() {
        // Save живёт ВНУТРИ блока, а не в шапке: шапка — отдельная полоса с
        // своим фоном, и кнопка в ней читается как относящаяся к разделу
        // целиком, а не к списку под ней.
        return Card('Model connections', {
            ...collapse.bind('card:models'),
            subtitle: 'Where the engine gets its own generations from',
        },
            EditableList({
                items: workers,
                renderItem: workerRow,
                onAdd: addWorker,
                addLabel: '+ Add connection',
                empty: 'No connections yet. Add one to let the engine run its own model calls.',
                actions: [Button('Save', saveWorkers)],
            }),
        );
    }

    return { loadWorkers, modelsCard };
}
