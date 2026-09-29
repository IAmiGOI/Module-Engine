import { h } from './tree.js';
import { signal, computed } from './reactive.js';
import { Button, TextInput, Row, Field, Badge, Select, EmptyState } from '../../libraries/shared/widgets.js';
import { TABS, normalizeTab, filterAndSort, cardModel } from './memory-graph/library-view.js';

/**
 * Вкладки «Graph | Library» окна графа и сама вкладка Library (MEMORY_GRAPH_TYPES_PLAN.md, этап 9). Модель (поиск,
 * сортировка, карточки) — `memory-graph/library-view.js`; здесь — сигналы и DOM. `call` — вызов контракта Ядра, `getThumbnail`
 * — SVG миниатюры текущего графа (у окна есть раскладка), `afterChange` — окно перечитывает граф после операций над ним.
 */
export function createLibraryTab({ call, getThumbnail, afterChange = async () => {}, setStatus = () => {}, onTabChange = () => {}, hasLibraryId = () => false }) {
    const activeTab = signal('graph');
    const entries = signal([]);
    const query = signal('');
    const sort = signal('date');
    const saveName = signal('');
    const busy = signal(false);

    async function refresh() {
        const result = await call('memoryGraph.library.list');
        entries.set(result.ok ? (result.value ?? []) : []);
    }

    function selectTab(tab) {
        activeTab.set(normalizeTab(tab));
        if (activeTab.peek() === 'library') refresh();
        onTabChange(activeTab.peek());
    }

    /** Обёртка операции: занято на время, результат — в строку статуса, список перечитывается. */
    async function run(operation, okText) {
        busy.set(true);
        try {
            const result = await operation();
            const value = result.value;
            if (!result.ok || value?.ok === false) setStatus(`Failed: ${value?.error ?? result.error?.message ?? 'unknown error'}`);
            else setStatus(value?.warning ? `${okText} Warning: ${value.warning}` : okText);
            await refresh();
            return result;
        } finally {
            busy.set(false);
        }
    }

    const saveCurrent = () => run(async () => {
        const result = await call('memoryGraph.library.save', { name: saveName(), thumbnail: getThumbnail() });
        if (result.ok && result.value?.ok) saveName.set('');
        return result;
    }, 'Saved to the library.');

    async function open(entry) {
        const first = await call('memoryGraph.library.open', { id: entry.id });
        if (first.ok && first.value?.needsConfirmation) {
            if (!globalThis.confirm?.(`Open "${entry.name}"? It replaces the graph of this chat — the current graph is saved to the library first as "${entry.name} (before open)".`)) return;
            await run(() => call('memoryGraph.library.open', { id: entry.id, confirmed: true }), 'Graph opened.');
        } else {
            await run(async () => first, 'Graph opened.');
        }
        await afterChange();
        if (first.ok && first.value?.ok !== false || activeTab.peek() === 'library') selectTab('graph');
    }

    const rename = entry => {
        const name = globalThis.prompt?.('Rename graph', entry.name);
        if (name) run(() => call('memoryGraph.library.rename', { id: entry.id, name }), 'Renamed.');
    };
    const duplicate = entry => run(() => call('memoryGraph.library.duplicate', { id: entry.id }), 'Duplicated.');
    const exportEntry = entry => run(() => call('memoryGraph.library.export', { id: entry.id }), 'Exported.');
    const remove = entry => {
        if (globalThis.confirm?.(`Delete "${entry.name}" from the library? This cannot be undone.`)) run(() => call('memoryGraph.library.delete', { id: entry.id }), 'Deleted.');
    };
    const saveBack = () => run(() => call('memoryGraph.library.saveBack', { thumbnail: getThumbnail() }), 'Changes saved back.');

    async function importFile(event) {
        const file = event.target.files?.[0];
        if (!file) return;
        const text = await file.text();
        event.target.value = '';
        await run(() => call('memoryGraph.library.import', { text }), 'Imported.');
    }

    function card(entry) {
        const model = cardModel(entry);
        return h('div', { class: 'stme-mg-library-card' },
            // Миниатюра — SVG-строка из Ядра, но показывается картинкой (data-URL), а не разметкой: ничего не исполняется и не вставляется в DOM.
            model.thumbnail ? h('img', { class: 'stme-mg-library-thumb', alt: '', width: 120, height: 120, src: `data:image/svg+xml;utf8,${encodeURIComponent(model.thumbnail)}` }) : h('div', { class: 'stme-mg-library-thumb' }),
            h('div', { class: 'stme-mg-library-meta' },
                h('strong', {}, model.name),
                Row(Badge(model.modeLabel, { tone: model.modeLabel === 'Structured' ? 'ok' : 'muted' }), h('small', { class: 'stme-module-hint' }, model.sizeText)),
                h('small', { class: 'stme-module-hint' }, model.countsText),
                h('small', { class: 'stme-module-hint' }, model.datesText),
                model.fromText ? h('small', { class: 'stme-module-hint' }, model.fromText) : null,
            ),
            Row(
                Button('Open', () => open(entry), { disabled: busy }), Button('Duplicate', () => duplicate(entry), { disabled: busy }),
                Button('Rename', () => rename(entry), { disabled: busy }), Button('Export', () => exportEntry(entry), { disabled: busy }),
                Button('Delete', () => remove(entry), { variant: 'danger', disabled: busy }),
            ),
        );
    }

    /** Полоса вкладок над канвасом. */
    function tabStrip() {
        return h('div', { class: 'stme-mg-tabs', style: { display: 'flex', gap: '4px', padding: '4px 8px' } },
            ...TABS.map(tab => computed(() => Button(tab === 'graph' ? 'Graph' : 'Library', () => selectTab(tab), { variant: activeTab() === tab ? 'primary' : undefined }))),
        );
    }

    /** Сама вкладка Library — сетка карточек, скрыта, пока активна вкладка Graph. */
    function view() {
        const listed = computed(() => filterAndSort(entries(), { query: query(), sort: sort() }));
        return h('div', { class: 'stme-mg-library', style: computed(() => ({ display: activeTab() === 'library' ? 'flex' : 'none', flexDirection: 'column', gap: '8px', flex: '1', minHeight: '0', overflow: 'auto', padding: '8px' })) },
            Row(
                Field('Name', TextInput(saveName, { placeholder: 'Character — date' })),
                Button('Save current graph…', saveCurrent, { disabled: busy }),
                computed(() => (hasLibraryId() ? Button('Save changes back', saveBack, { disabled: busy }) : null)),
                h('label', { class: 'stme-button' }, 'Import', h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' }, 'on:change': importFile })),
            ),
            Row(
                h('input', { class: 'text_pole', type: 'text', placeholder: 'Search by name…', value: query, 'on:input': event => query.set(event.target.value) }),
                Select(sort, [{ value: 'date', label: 'Newest' }, { value: 'name', label: 'Name' }, { value: 'size', label: 'Size' }]),
            ),
            computed(() => (listed().length
                ? h('div', { class: 'stme-mg-library-grid', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '8px' } }, listed().map(card))
                : EmptyState(entries().length ? 'No graph matches this search.' : 'The library is empty. Save the current graph to reuse it in any chat.'))),
        );
    }

    return { activeTab, tabStrip, view, refresh, selectTab, saveCurrent, open };
}
