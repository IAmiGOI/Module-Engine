import { h } from './tree.js';
import { signal } from './reactive.js';
import { Button, Row, TextInput } from '../../libraries/shared/widgets.js';

/** Тост вопросов bootstrap: очередь, варианты, свой ответ и «Skip». */
export function createQuestionView({ host, call }) {
    const question = signal(null);
    const own = signal('');
    const busy = signal(false);
    const subscriptions = [];

    function show(value) {
        question.set(value && typeof value === 'object' ? value : null);
        own.set('');
    }

    async function answer(value, skipped = false) {
        const current = question.peek();
        if (!current || busy.peek()) return;
        busy.set(true);
        try {
            await call('decision.answerQuestion', { id: current.id, answer: skipped ? '' : String(value ?? ''), skipped });
            show(null);
        } finally {
            busy.set(false);
        }
    }

    function subscribe() {
        subscriptions.push(host.events.subscribe('decision.question.asked', payload => show(payload)));
        subscriptions.push(host.events.subscribe('decision.question.answered', () => show(null)));
        call('decision.question').then(result => { if (result?.ok && result.value) show(result.value); }).catch(() => {});
    }

    function toast() {
        const current = question();
        if (!current) return null;
        return h('div', { class: 'stme-dq-toast' },
            h('div', { class: 'stme-dq-title' }, 'The Director asks'),
            h('div', { class: 'stme-dq-counter' }, `Question ${current.index} of ${current.total}`),
            h('div', { class: 'stme-dq-question' }, current.question),
            current.why ? h('div', { class: 'stme-dq-why' }, current.why) : null,
            ...(current.options ?? []).map(option => Button(option, () => answer(option))),
            h('div', { class: 'stme-dq-own' },
                TextInput(own, { placeholder: 'Your own answer' }),
                Button('Answer', () => answer(own.peek()))),
            Button('Skip — decide yourself', () => answer('', true)));
    }

    return { tree: () => (question() ? toast() : null), subscribe, stop: () => { for (const unsubscribe of subscriptions.splice(0)) unsubscribe(); } };
}
