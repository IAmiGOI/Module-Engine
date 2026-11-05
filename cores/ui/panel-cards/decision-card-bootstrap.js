import { h } from '../tree.js';
import { signal } from '../reactive.js';
import { Details, Row, Slider } from '../../../libraries/shared/widgets.js';

/**
 * Настройки bootstrap в карточке: шаги и таймаут первого хода. Число
 * вопросов переехало в Game settings (часть 13) — второй такой же ползунок
 * здесь был бы дублем.
 */
export function createBootstrapSettings() {
    const maxSteps = signal(30);
    const timeoutMs = signal(180000);

    function apply(value = {}) {
        maxSteps.set(Number(value.maxSteps ?? 30));
        timeoutMs.set(Number(value.timeoutMs ?? 180000));
    }

    function collect() {
        return { maxSteps: maxSteps.peek(), timeoutMs: timeoutMs.peek() };
    }

    function section() {
        return Details('Chat bootstrap',
            Row(
                Slider('Steps at most', maxSteps, { min: 1, max: 200, step: 1 }),
                Slider('First-turn wait (ms)', timeoutMs, { min: 1000, max: 3600000, step: 1000 }),
            ),
            h('small', { class: 'stme-module-hint' }, 'A new chat is studied before the first turn. How many questions it may ask is set in Game settings. The turn waits for the brief; after the timeout it goes on without one.'),
        );
    }

    return { apply, collect, section };
}
