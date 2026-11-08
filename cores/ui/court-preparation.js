import { h } from './tree.js';
import { signal } from './reactive.js';
import { Button, Row, TextInput } from '../../libraries/shared/widgets.js';
import { normalizePreparation, preparationStepText } from '../../libraries/core/decision-preparation.js';

/**
 * Плашка подготовки над дорожками The Court: текущий шаг, что делает роль,
 * ошибка с кнопкой Retry, ссылка на канал Советника, когда God ждёт ответов.
 * После `ready` — «Save as Canon» с именем. Данные — контракты
 * `decision.preparation` / `decision.canonList`; ничего не будит само.
 */
const text = value => String(value ?? '').trim();

export function createCourtPreparation({ call, subscribe, onOpenCounsellor = null }) {
    const state = signal(null);
    const name = signal('');
    const note = signal('');
    const busy = signal(false);
    const unsubscribers = [];

    async function refresh() {
        const result = await call('decision.preparation').catch(() => null);
        state.set(result?.ok && result.value ? normalizePreparation(result.value) : null);
    }

    async function retry() {
        if (busy.peek()) return;
        busy.set(true);
        note.set('');
        try {
            const result = await call('decision.preparationRetry');
            if (!result?.ok) note.set(result?.error?.message ?? 'The step was not retried.');
        } catch (error) {
            note.set(error?.message ?? String(error));
        } finally {
            busy.set(false);
            await refresh().catch(() => {});
        }
    }

    async function saveCanon() {
        const value = text(name.peek());
        if (!value || busy.peek()) return;
        busy.set(true);
        note.set('');
        try {
            const result = await call('decision.canonSave', { name: value });
            if (result?.ok) {
                name.set('');
                note.set(`Canon “${value}” saved.`);
            } else {
                note.set(result?.error?.message ?? 'The Canon was not saved.');
            }
        } catch (error) {
            note.set(error?.message ?? String(error));
        } finally {
            busy.set(false);
            await refresh().catch(() => {});
        }
    }

    function banner(value) {
        const step = preparationStepText(value.step);
        return h('div', { class: 'stme-prep', role: 'status', 'aria-live': 'polite' },
            h('div', { class: 'stme-prep-text' },
                h('div', { class: 'stme-prep-title' }, step.label),
                step.detail ? h('div', { class: 'stme-prep-detail' }, step.detail) : null,
                step.role ? h('div', { class: 'stme-prep-role' }, `Role: ${step.role}`) : null,
                value.step === 'answers'
                    ? h('button', { class: 'stme-prep-link', type: 'button', 'on:click': () => onOpenCounsellor?.() }, 'God has questions — open the Counsellor’s channel')
                    : null,
                value.error
                    ? h('div', { class: 'stme-prep-error' },
                        h('span', {}, value.error),
                        Button('Retry', retry, { disabled: busy }))
                    : null,
                note() ? h('div', { class: 'stme-prep-note' }, note()) : null));
    }

    function canonBar() {
        return h('div', { class: 'stme-prep stme-prep-ready' },
            h('div', { class: 'stme-prep-text' },
                h('div', { class: 'stme-prep-title' }, 'The game is ready'),
                note() ? h('div', { class: 'stme-prep-note' }, note()) : null),
            Row(
                TextInput(name, { placeholder: 'Canon name' }),
                Button('Save as Canon', saveCanon, { disabled: busy })));
    }

    function tree() {
        const value = state();
        if (!value) return null;
        return value.step === 'ready' ? canonBar() : banner(value);
    }

    function start() {
        if (unsubscribers.length) return;
        for (const event of ['decision.preparation.changed', 'decision.reloaded', 'st.chatChanged']) {
            unsubscribers.push(subscribe(event, () => { refresh().catch(() => {}); }));
        }
        refresh().catch(() => {});
    }

    return {
        tree, refresh, start, retry, saveCanon,
        state: () => state.peek(),
        stop: () => { for (const unsubscribe of unsubscribers.splice(0)) unsubscribe(); },
    };
}
