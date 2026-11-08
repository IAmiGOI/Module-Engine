import { Row, Slider, Field, Select } from '../../../libraries/shared/widgets.js';
import { signal, computed } from '../reactive.js';

/**
 * Настройки God в карточке Director / Writer: своё подключение, шаги и
 * число вопросов за построение Creation (фаза 5). Вынесено из карточки,
 * чтобы файл карточки не рос.
 */
export function createGodSettings(workerOptions) {
    const workerId = signal('');
    const maxSteps = signal(20);
    const maxQuestions = signal(5);
    const options = computed(() => [
        { value: '', label: 'Director connection (default)' },
        ...workerOptions().slice(1),
    ]);

    function apply(value = {}) {
        workerId.set(String(value.workerId ?? ''));
        maxSteps.set(Number(value.maxSteps ?? 20));
        maxQuestions.set(Number(value.maxQuestions ?? 5));
    }

    function collect() {
        return { workerId: workerId.peek(), maxSteps: maxSteps.peek(), maxQuestions: maxQuestions.peek() };
    }

    /** Поля подключения — рядом с Director в карточке. */
    function fields() {
        return Row(
            Field('God connection', Select(workerId, options), {
                hint: 'Builds the Creation and answers Prayers. Empty: the Director connection — one strong model, two keys.',
            }),
            Slider('Questions per build', maxQuestions, { min: 1, max: 20, step: 1 }),
        );
    }

    function steps() {
        return Slider('God steps per wake', maxSteps, { min: 1, max: 200, step: 1 });
    }

    return { apply, collect, fields, steps };
}
