/**
 * Подготовка к игре — чистые правила явной машины шагов. Состояние и запуск
 * ролей живут в `cores/decision/preparation.js`; здесь только форма шага,
 * порядок и правило «какой шаг сейчас по фактам». Ни моделей, ни хранения.
 *
 * Шаги по порядку: сортировка банков → God изучает материал и спрашивает →
 * Советник ждёт ответов → God строит Creation → Director пишет банки и Указы
 * Main Cast → игра открыта. Факты говорят, где мы на самом деле: потерянное
 * событие не останавливает цепочку — `advance()` просто продолжает с факта.
 */

const text = value => String(value ?? '').trim();

export const PREPARATION_STEPS = Object.freeze(['sort', 'study', 'answers', 'build', 'cast', 'ready']);

/** Что делает роль на шаге — для плашки в окне The Court. */
export const PREPARATION_STEP_TEXT = Object.freeze({
    sort: {
        role: 'Banks',
        label: 'Sorting the character banks',
        detail: 'Who is Main Cast, who is a Side Character, who is Temporary.',
    },
    study: {
        role: 'God',
        label: 'God studies the material and asks',
        detail: 'The world is not written until the questions about the timeline and the user are answered.',
    },
    answers: {
        role: 'Counsellor',
        label: 'Waiting for your answers to God',
        detail: 'The Counsellor brings the questions; the world waits for them.',
    },
    build: {
        role: 'God',
        label: 'God is shaping Creation',
        detail: 'The world, its Scales and the place of the user in it.',
    },
    cast: {
        role: 'Director',
        label: 'The Director is writing the Main Cast',
        detail: 'Their banks, their material and spiritual parts, and their Decrees.',
    },
    ready: {
        role: '',
        label: 'The game is ready',
        detail: '',
    },
});

const STEP_INDEX = new Map(PREPARATION_STEPS.map((step, index) => [step, index]));

export function isPreparationStep(value) {
    return PREPARATION_STEPS.includes(text(value));
}

/** Шаг по порядку: сравнение для «не откатываться назад» и для плашки. */
export function preparationStepIndex(value) {
    return STEP_INDEX.get(text(value)) ?? 0;
}

/** Состояние из памяти чата — безопасная форма. */
export function normalizePreparation(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
        step: isPreparationStep(source.step) ? text(source.step) : 'sort',
        startedAt: Number(source.startedAt) || 0,
        updatedAt: Number(source.updatedAt) || 0,
        error: text(source.error),
    };
}

/**
 * Текущий шаг по фактам. `played` — в чате уже есть ход: игра началась раньше,
 * чем появилась эта машина, и подготовка ему не нужна. `mainWithoutDecree` —
 * сколько персонажей Main Cast ещё без Указа.
 */
export function stepFromFacts(facts = {}) {
    const value = facts && typeof facts === 'object' ? facts : {};
    if (value.played) return 'ready';
    if (!value.sorted) return 'sort';
    // Роли без подключения — их шаг пропускается: иначе подготовка ждала бы вечно, а игра не открылась бы.
    const godReady = value.godConfigured !== false;
    const directorReady = value.directorConfigured !== false;
    if (!godReady) return directorReady && Number(value.mainWithoutDecree) > 0 ? 'cast' : 'ready';
    // Вопрос без ответа держит игру: мир не должен начаться поверх вопросов God.
    if (value.openQuestions) return 'answers';
    if (!value.creationComplete) {
        if (value.declarationReady) return 'build';
        // Изучение — только до первого написанного раздела: начатый мир достраивается.
        if (!value.studied && !value.creationStarted) return 'study';
        return 'build';
    }
    // Декларация меняет мир и после готового Creation — God обрабатывает её до Указов.
    if (value.declarationReady) return 'build';
    if (directorReady && Number(value.mainWithoutDecree) > 0) return 'cast';
    return 'ready';
}

/** Подпись шага для уведомления (то же, что видит плашка). */
export function preparationStepText(step) {
    return PREPARATION_STEP_TEXT[text(step)] ?? PREPARATION_STEP_TEXT.sort;
}

/** Готова ли игра к первому ходу. */
export function preparationReady(value) {
    return normalizePreparation(value).step === 'ready';
}
