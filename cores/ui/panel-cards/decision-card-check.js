import { h } from '../tree.js';
import { computed } from '../reactive.js';
import { Details, Field, Row, Select, Slider } from '../../../libraries/shared/widgets.js';

const readField = value => (typeof value === 'function' ? value() : value);

export function createClassifierOptions(classifierConnections) {
    return computed(() => [
        { value: '', label: 'First classifier connection (default)' },
        ...classifierConnections().map(connection => {
            const id = String(readField(connection.id) ?? '');
            const model = String(readField(connection.model) ?? '');
            return { value: id, label: model ? `${id} — ${model}` : id };
        }),
    ]);
}

export function scalesHintSection({ scalesHintConnectionId, classifierOptions }) {
    return Details('Scales hint (classifier)',
        Field('Classifier connection', Select(scalesHintConnectionId, classifierOptions), {
            hint: 'Before each turn the classifier names the world systems (Scales) the user\'s message touches; the rule cards of those systems go to the end of the turn. Empty: no hint. Measured with perplexity/pplx-decider-v1.2.',
        }),
        h('small', { class: 'stme-module-hint' }, 'The hint says what the turn touches, not what to do. Without a connection or a key the turn goes on as before.'),
    );
}

export function writerCheckSection({ classifierConnectionId, classifierThreshold, classifierCheckTokens, classifierRewriteLimit, classifierOptions }) {
    return Details('Writer check (classifier)',
        Field('Classifier connection', Select(classifierConnectionId, classifierOptions), {
            hint: 'Checks the writer reply with the classifier from the Classifiers core. With no connection, replies are delivered unchecked.',
        }),
        Row(
            Slider('Violation threshold', classifierThreshold, { min: 0, max: 1, step: 0.01 }),
            Slider('Check every (tokens)', classifierCheckTokens, { min: 20, max: 4000, step: 10 }),
            Slider('Rewrites before delivery', classifierRewriteLimit, { min: 0, max: 10, step: 1 }),
        ),
        h('small', { class: 'stme-module-hint' }, 'Works only when the writer uses an ME connection. The user sees the checked reply, never the discarded attempts.'),
    );
}
