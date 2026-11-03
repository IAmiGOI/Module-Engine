import { h } from './tree.js';
import { computed, signal } from './reactive.js';

/** Тост вопросов bootstrap: очередь, варианты, свой ответ и «Skip». */
export function createQuestionView({ host, call }) {
    const question = signal(null);
    const own = signal('');
    const busy = signal(false);
    const failure = signal(''); // причина неудачного bootstrap: тост с повтором
    const subscriptions = [];

    function show(value) {
        const next = value && typeof value === 'object' ? value : null;
        if (next?.id !== question.peek()?.id) own.set('');
        question.set(next);
    }

    // Источник правды — очередь ядра: тост показывает её первый вопрос. Гасить тост вслепую нельзя —
    // модель может задать два вопроса одним ответом, и второй приходит раньше, чем подтверждение первого.
    function sync() {
        return call('decision.question').then(result => show(result?.ok ? result.value : null)).catch(() => {});
    }

    async function answer(value, skipped = false) {
        const current = question.peek();
        if (!current || busy.peek()) return;
        busy.set(true);
        try {
            await call('decision.answerQuestion', { id: current.id, answer: skipped ? '' : String(value ?? ''), skipped });
            await sync();
        } finally {
            busy.set(false);
        }
    }

    function subscribe() {
        subscriptions.push(host.events.subscribe('decision.question.asked', () => sync()));
        subscriptions.push(host.events.subscribe('decision.question.answered', () => sync()));
        sync();
        subscriptions.push(host.events.subscribe('decision.bootstrap.started', () => failure.set('')));
        subscriptions.push(host.events.subscribe('decision.bootstrap.finished', payload => failure.set(payload?.status === 'failed' ? String(payload.error ?? 'The chat bootstrap failed.') : '')));
        call('decision.bootstrap').then(result => { if (result?.ok && result.value?.status === 'failed') failure.set(String(result.value.error ?? 'The chat bootstrap failed.')); }).catch(() => {});
    }

    async function retry() {
        if (busy.peek()) return;
        busy.set(true);
        try {
            failure.set('');
            const result = await call('decision.bootstrapRetry');
            if (result?.ok === false || result?.value?.ok === false) failure.set(String(result?.value?.error ?? result?.error?.message ?? 'The retry did not start.'));
        } finally {
            busy.set(false);
        }
    }

    function failureToast() {
        const reason = failure();
        if (!reason) return null;
        return h('div', { class: 'stme-dq-toast stme-dq-failed', role: 'alert' },
            h('div', { class: 'stme-dq-head' },
                h('span', { class: 'stme-dq-mark' }, '!'),
                h('span', { class: 'stme-dq-title' }, 'Chat bootstrap failed')),
            h('div', { class: 'stme-dq-why' }, reason),
            h('div', { class: 'stme-dq-own' },
                h('button', { type: 'button', class: 'stme-dq-send', disabled: busy, 'on:click': retry }, 'Retry bootstrap'),
                h('button', { type: 'button', class: 'stme-dq-skip', 'on:click': () => failure.set('') }, 'Go on without it')));
    }

    function toast() {
        const current = question();
        if (!current) return null;
        const options = current.options ?? [];
        const send = () => { if (own.peek().trim()) answer(own.peek()); };
        return h('div', { class: 'stme-dq-toast', role: 'dialog', 'aria-label': 'The Director asks' },
            h('div', { class: 'stme-dq-head' },
                h('span', { class: 'stme-dq-mark' }, '◎'),
                h('span', { class: 'stme-dq-title' }, 'The Director asks'),
                h('span', { class: 'stme-dq-counter' }, `Question ${current.index} of ${current.total}`)),
            h('div', { class: 'stme-dq-question' }, current.question),
            current.why ? h('div', { class: 'stme-dq-why' }, current.why) : null,
            options.length ? h('div', { class: 'stme-dq-options' },
                ...options.map((option, index) => h('button', {
                    type: 'button', class: 'stme-dq-option', disabled: busy, 'on:click': () => answer(option),
                }, h('span', { class: 'stme-dq-key' }, String(index + 1)), h('span', { class: 'stme-dq-option-text' }, option)))) : null,
            h('div', { class: 'stme-dq-own' },
                h('input', {
                    class: 'stme-dq-input', type: 'text', placeholder: 'Your own answer', value: own,
                    'on:input': event => own.set(String(event?.target?.value ?? '')),
                    'on:keydown': event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); send(); } },
                }),
                h('button', { type: 'button', class: 'stme-dq-send', disabled: computed(() => busy() || !own().trim()), 'on:click': send }, 'Answer')),
            h('div', { class: 'stme-dq-foot' },
                h('button', { type: 'button', class: 'stme-dq-skip', disabled: busy, 'on:click': () => answer('', true) }, 'Skip — decide yourself')));
    }

    return { tree: () => (question() ? toast() : failureToast()), subscribe, stop: () => { for (const unsubscribe of subscriptions.splice(0)) unsubscribe(); } };
}
