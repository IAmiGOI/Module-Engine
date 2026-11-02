import { h } from './tree.js';
import { signal, computed } from './reactive.js';
import { request } from '../../libraries/shared/request.js';
import { Button, Row } from '../../libraries/shared/widgets.js';

/**
 * Секция дата-банков в окне директора: список, прогресс холодного запуска,
 * текст с ручной правкой и пересборкой. Контракты — `decision.banks`,
 * `decision.bankProgress`, `decision.bankWrite`, `decision.bankRebuild`.
 */
const text = value => String(value ?? '').trim();

export function createBanksView({ call, onChanged = () => {} }) {
    const banks = signal([]);
    const progress = signal(null);
    const drafts = signal({});

    async function refresh() {
        const [list, state] = await Promise.all([call('decision.banks'), call('decision.bankProgress')]);
        banks.set(list.ok && Array.isArray(list.value) ? list.value : []);
        progress.set(state.ok && state.value ? state.value : null);
    }

    function readyCount() {
        return banks().filter(bank => bank.status === 'ready').length;
    }

    function draftFor(bank) {
        return drafts()[bank.sourceKey] ?? bank.text;
    }

    function edit(bank, value) {
        drafts.set({ ...drafts.peek(), [bank.sourceKey]: value });
    }

    async function save(bank) {
        const value = text(draftFor(bank));
        if (!value) return;
        await call('decision.bankWrite', { name: bank.name, text: value });
        await refresh();
        onChanged();
    }

    async function rebuild(bank) {
        await call('decision.bankRebuild', { name: bank.name });
        await refresh();
        onChanged();
    }

    function bankNode(bank) {
        const status = `${bank.status}${bank.error ? `: ${bank.error}` : ''}`;
        return h('details', { class: `stme-dw-bank stme-dw-bank-${bank.status}` },
            h('summary', {},
                h('strong', {}, bank.name || 'Character'),
                h('span', { class: 'stme-dw-bank-kind' }, ` · ${bank.sourceKind} · ${bank.sizeBand} · ${status}`)),
            h('textarea', {
                class: 'text_pole stme-dw-bank-text', rows: 5,
                value: draftFor(bank),
                'on:input': event => edit(bank, event.target?.value ?? ''),
            }),
            Row(
                Button('Save bank', () => save(bank)),
                Button('Rebuild from source', () => rebuild(bank))));
    }

    function section() {
        return computed(() => {
            const list = banks();
            const state = progress();
            const summary = `Character banks: ${readyCount()} of ${list.length} ready${state?.errors ? ` · ${state.errors} error${state.errors === 1 ? '' : 's'}` : ''}${state?.status === 'partial' ? ' · cold start timed out' : ''}`;
            return h('details', { class: 'stme-dw-banks' },
                h('summary', {}, summary),
                state ? h('div', { class: 'stme-dw-bank-progress' }, `Cold start: ${state.status} · ${state.done ?? 0}/${state.total ?? list.length}${state.timedOut ? ' · continuing in the background' : ''}`) : null,
                list.length ? list.map(bankNode) : h('small', { class: 'stme-dw-muted' }, 'No character banks yet.'));
        });
    }

    return { refresh, section, banks, progress, drafts };
}
