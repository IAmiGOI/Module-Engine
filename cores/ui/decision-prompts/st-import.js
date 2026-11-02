import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';
import { Button, Row, Badge, EmptyState } from '../../../libraries/shared/widgets.js';
import { Select } from './dropdown.js';

const TARGETS = [
    { value: 'skip', label: 'Skip' },
    { value: 'director', label: 'Director' },
    { value: 'writer', label: 'Writer' },
];

/** Выбор раздела для каждого промпта из файла ST. Маркеры и пустые тексты по умолчанию пропускаются. */
export function StImportPanel({ prompts = [], onConfirm, onCancel }) {
    const values = new Map();
    const choices = prompts.map(prompt => {
        const fallback = prompt.marker || !prompt.content.trim() ? 'skip' : 'director';
        const value = signal(fallback);
        values.set(prompt.key, value);
        return { prompt, value };
    });

    function confirm() {
        const chosen = {};
        for (const [key, value] of values) chosen[key] = value.peek();
        onConfirm(chosen);
    }

    return h('div', { class: 'stme-dp-editor stme-dp-import' },
        h('p', { class: 'stme-dp-help' }, 'Choose where each prompt goes. Markers and empty prompts are skipped. Nothing is written until you press Import.'),
        choices.length
            ? h('div', { class: 'stme-dp-import-list' }, choices.map(({ prompt, value }) => h('div', { class: 'stme-dp-import-row' },
                h('div', { class: 'stme-dp-import-name' },
                    h('strong', {}, prompt.name),
                    prompt.marker ? Badge(`marker: ${prompt.markerText}`) : null,
                    h('small', { class: 'stme-dp-help' }, `${prompt.content.trim().slice(0, 160) || '(empty)'}`)),
                Select(value, TARGETS),
            )))
            : EmptyState('This file has no prompts to import.'),
        Row(
            Button('Import', confirm, { disabled: !choices.length }),
            Button('Cancel', onCancel),
        ),
    );
}
