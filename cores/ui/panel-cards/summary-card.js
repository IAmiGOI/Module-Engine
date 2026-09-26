import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';
import { Button, TextArea, NumberInput, Select, Toggle, Field, Row, Card, Section, EditableList } from '../../../libraries/shared/widgets.js';
import { nextUid } from './uid.js';

/** Карточка «Chat Summary»: пирамида сводок старой истории, пороги и уровни. */
export function createSummaryCard(deps) {
    const { call, summaries, memoryGraphNodeCount, memoryGraphThresholdK, notify, summaryLevels, summaryProtectedWindow, summaryWorkerId, summaryVerifyEnabled, summaryVerifyWorkerId, flash, collapse, workers } = deps;

    /**
     * Свёртка старой истории (BasicSummary, ROADMAP.md) — тоже часть ЭКРАНА
     * ДВИЖКА, не Модуль: как и у Macros/Lorebook, это не отключаемая фича, а
     * общий механизм управления контекстом. Панель — тонкая проводка к
     * контрактам [cores/summary/index.js](../summary/index.js):
     * `summary.list`/`update`/`delete` (записи), `summary.settings`/
     * `configure` (пороги/уровни), `summary.check` (ручной «Fold now» —
     * тот же контракт, что дёргает сам движок автоматически на
     * `generation.prepare`, так что кнопка честно показывает то же самое
     * поведение, а не отдельную имитацию).
     */
    function toSummaryRecord(record) {
        return {
            key: `summary_${record.id}`,
            id: record.id,
            level: record.level,
            startIndex: record.startIndex,
            endIndex: record.endIndex,
            text: signal(record.text),
            edited: record.edited,
            flash: signal(''),
        };
    }

    function toLevelRecord(level = {}) {
        return { key: `level_${nextUid()}`, batchSize: signal(level.batchSize ?? 5) };
    }

    async function loadSummaries() {
        const result = await call('summary.list');
        summaries.set((result.ok ? result.value ?? [] : []).map(toSummaryRecord));
    }

    /** Только счётчик — сам граф рисует и правит `cores/ui/memory-graph-panel.js`'s отдельное окно, эта карточка лишь открывает его. */
    async function loadMemoryGraphCount() {
        const result = await call('memoryGraph.nodes');
        if (result.ok) memoryGraphNodeCount.set(result.value.length);
    }

    async function loadMemoryGraphSettings() {
        const result = await call('memoryGraph.settings');
        if (result.ok) memoryGraphThresholdK.set(result.value.thresholdK);
    }

    async function saveMemoryGraphThresholdK() {
        const result = await call('memoryGraph.configure', { thresholdK: memoryGraphThresholdK.peek() });
        if (result.ok) memoryGraphThresholdK.set(result.value.thresholdK); // отражает реальный клэмп (0.1-10), не то, что могло быть введено вручную
        await notify(result.ok ? 'ok' : 'error', result.ok ? 'Saved sensitivity' : result.error.message);
    }

    async function loadSummarySettings() {
        const result = await call('summary.settings');
        if (!result.ok || !result.value) return;
        summaryLevels.set(result.value.levels.map(toLevelRecord));
        summaryProtectedWindow.set(result.value.protectedWindow);
        summaryWorkerId.set(result.value.workerId ?? '');
        summaryVerifyEnabled.set(Boolean(result.value.verifyEnabled));
        summaryVerifyWorkerId.set(result.value.verifyWorkerId ?? '');
    }

    function addSummaryLevel() {
        summaryLevels.set([...summaryLevels.peek(), toLevelRecord({ batchSize: 5 })]);
    }

    function removeSummaryLevel(record) {
        summaryLevels.set(summaryLevels.peek().filter(item => item !== record));
    }

    async function saveSummarySettings() {
        const levels = summaryLevels.peek().map(record => ({ batchSize: record.batchSize.peek() }));
        const result = await call('summary.configure', {
            levels, protectedWindow: summaryProtectedWindow.peek(), workerId: summaryWorkerId.peek().trim() || null,
            verifyEnabled: summaryVerifyEnabled.peek(), verifyWorkerId: summaryVerifyWorkerId.peek().trim() || null,
        });
        if (result.ok) {
            summaryLevels.set(result.value.levels.map(toLevelRecord));
            summaryProtectedWindow.set(result.value.protectedWindow);
        }
        await notify(result.ok ? 'ok' : 'error', result.ok ? 'Saved summary settings' : result.error.message);
    }

    /** Тот же контракт, что и автоматический прогон на `generation.prepare` — кнопка не имитирует поведение движка отдельным путём, а честно его вызывает. */
    async function forceSummaryFold() {
        const result = await call('summary.check');
        await notify(result.ok ? 'ok' : 'error', result.ok ? `Now ${result.value.length} active summary/summaries` : result.error.message);
        if (result.ok) await loadSummaries();
    }

    async function saveSummaryText(record) {
        const result = await call('summary.update', { id: record.id, text: record.text.peek() });
        flash(record.flash, result.ok ? 'ok' : 'error');
        await notify(result.ok ? 'ok' : 'error', result.ok ? 'Saved summary' : result.error.message);
    }

    async function removeSummaryRecord(record) {
        const result = await call('summary.delete', { id: record.id });
        await notify(result.ok ? 'ok' : 'error', result.ok ? 'Deleted summary' : result.error.message);
        if (result.ok) await loadSummaries();
    }

    function summaryRow(record) {
        return Section(`Level ${record.level} summary`, {
            key: record.key,
            className: computed(() => (record.flash() ? `stme-flash stme-flash-${record.flash()}` : '')),
            ...collapse.bind(`summary:${record.key}`),
            subtitle: `covers messages ${record.startIndex}–${record.endIndex}${record.edited ? ' · edited by hand' : ''}`,
            actions: [
                Button('Save', () => saveSummaryText(record)),
                Button('Remove', () => removeSummaryRecord(record), { variant: 'danger' }),
            ],
        },
            Field('Text', TextArea(record.text, { rows: 4, placeholder: 'Summary text…' })),
        );
    }

    function summaryLevelRow(record, index) {
        return Row(
            Field(`Level ${index + 1} batch size`, NumberInput(record.batchSize, { min: 2, max: 200 })),
            Button('Remove', () => removeSummaryLevel(record), { variant: 'danger' }),
        );
    }

    function summaryCard() {
        return Card('Chat Summary', {
            ...collapse.bind('card:summary'),
            subtitle: computed(() => `${summaries().length} active summar${summaries().length === 1 ? 'y' : 'ies'}`),
        },
            h('p', { class: 'stme-summary-help' },
                'Old chat history is folded into a pyramid of summaries — each level compresses several of the level below — so the model keeps the gist of the past without paying its full token cost. The newest messages always stay untouched, real text; the protected window below sets how many.'),
            Row(
                Field('Protected window', NumberInput(summaryProtectedWindow, { min: 1, max: 2000 }), { hint: 'How many of the newest messages never get folded.' }),
                // Тот же список, что «Model connection» у Tracker'а
                // (modules/tracker/index.js) — реальные подключения из
                // `workers` (Model connections card в этой же панели), а не
                // строка, куда id воркера пришлось бы переписывать руками и
                // легко было бы опечататься/забыть, что он вообще переименован.
                Field('Worker', Select(summaryWorkerId, computed(() => [
                    { value: '', label: 'Default (any connection)' },
                    ...workers().map(record => ({ value: record.id(), label: record.id() })),
                ]))),
            ),
            h('div', { class: 'stme-summary-levels' },
                computed(() => summaryLevels().map((record, index) => summaryLevelRow(record, index))),
            ),
            Row(
                Toggle('Verify level >1 summaries', summaryVerifyEnabled, {
                    hint: 'After folding a summary of summaries, ask the model to double-check it against the original content one level further down before accepting it — catches drift the higher up the pyramid you go. Roughly doubles model calls for those folds; runs in the background, never delays a reply.',
                }),
                Field('Verify worker', Select(summaryVerifyWorkerId, computed(() => [
                    { value: '', label: 'Same as fold worker' },
                    ...workers().map(record => ({ value: record.id(), label: record.id() })),
                ]))),
            ),
            Row(
                Button('+ Add level', addSummaryLevel),
                Button('Save settings', saveSummarySettings),
                Button('Fold now', forceSummaryFold),
            ),
            EditableList({
                items: summaries,
                renderItem: summaryRow,
                empty: 'No summaries yet — they appear automatically once enough old messages queue up beyond the protected window.',
            }),
        );
    }

    return { loadSummaries, loadMemoryGraphCount, loadMemoryGraphSettings, saveMemoryGraphThresholdK, loadSummarySettings, summaryCard };
}
