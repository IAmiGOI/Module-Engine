import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';
import { Button, Row, Badge, EmptyState } from '../../../libraries/shared/widgets.js';
import { Select } from './dropdown.js';

/** Вкладка предпросмотра: системные строки, блок пользователя на своей глубине и плашки данных. */
export function createPreviewTab({ call }) {
    const section = signal('director');
    const result = signal(null);
    const busy = signal(false);
    const error = signal('');
    const sectionOptions = [{ value: 'director', label: 'Director' }, { value: 'writer', label: 'Writer' }];

    async function refresh() {
        busy.set(true);
        error.set('');
        const answer = await call('decision.preview', { section: section.peek() });
        busy.set(false);
        if (!answer.ok) { error.set(answer.error?.message ?? 'Could not build the preview.'); return; }
        result.set(answer.value);
    }

    function rowView(row) {
        if (row.kind === 'system') {
            return h('details', { class: 'stme-dp-preview-system' },
                h('summary', {}, h('span', { class: 'stme-dp-lock' }, '🔒'), ` ${row.label}`, h('small', { class: 'stme-dp-detail' }, ` · ${row.detail}`)),
                h('pre', { class: 'stme-dp-block-text' }, row.text));
        }
        if (row.kind === 'block' || row.kind === 'block-empty') {
            return h('div', { class: `stme-dp-preview-block${row.kind === 'block-empty' ? ' stme-dp-preview-empty' : ''}` },
                h('strong', {}, row.label), h('small', { class: 'stme-dp-detail' }, ` · ${row.detail}`),
                row.text ? h('pre', { class: 'stme-dp-block-text' }, row.text) : null);
        }
        return h('div', { class: 'stme-dp-preview-data' },
            h('span', { class: 'stme-dp-preview-dot' }, '·'),
            h('span', { class: 'stme-dp-preview-label' }, row.label),
            h('small', { class: 'stme-dp-detail' }, row.detail ?? ''),
            row.text ? h('details', {}, h('summary', {}, 'template'), h('pre', { class: 'stme-dp-block-text' }, row.text)) : null);
    }

    function tree() {
        return h('div', { class: 'stme-dp-preview' },
            Row(
                Select(section, sectionOptions, { onChange: () => refresh() }),
                Button('Refresh preview', refresh),
                computed(() => (busy() ? Badge('working…') : null)),
            ),
            computed(() => (error() ? EmptyState(error()) : null)),
            computed(() => {
                const data = result();
                if (!data) return EmptyState('Press Refresh to see what the section sends.');
                return h('div', {},
                    ...(data.warnings ?? []).map(text => h('p', { class: 'stme-dp-warning' }, text)),
                    h('div', { class: 'stme-dp-preview-rows' }, (data.rows ?? []).map(rowView)),
                );
            }),
        );
    }

    return { tree, refresh, section };
}
