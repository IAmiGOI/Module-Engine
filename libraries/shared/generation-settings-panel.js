import { computed } from '../../cores/ui/reactive.js';
import { Field, Row, Select, Slider, TextInput, Button, Details } from './widgets.js';

// Те же три значения, что REASONING_MODES/REASONING_EFFORTS в
// cores/models/internal-engine.js — не импортированы оттуда НАМЕРЕННО:
// Библиотека не имеет права знать о конкретном Ядре (Ядра стоят НАД
// Библиотеками, не наоборот, см. LIBRARIES.md), а это ровно тот же случай,
// что уже решён для Select()/Toggle() — готовая вёрстка поверх примитивов,
// без знания о том, ЧТО именно выбирают.
const REASONING_MODE_OPTIONS = Object.freeze([
    { value: 'inherit', label: 'Provider default' },
    { value: 'enabled', label: 'Enabled' },
    { value: 'disabled', label: 'Disabled' },
]);
const REASONING_EFFORT_OPTIONS = Object.freeze([
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
]);

/**
 * Единая карточка «сэмплер + ризонинг + пресет» — сворачиваемая, как и любой
 * продвинутый блок в панели (см. `Details()`).
 *
 * Появилась по факту РАСХОЖДЕНИЯ: Модуль «Трекер» и Модуль «RP Time» рисовали
 * этот блок каждый у себя, и уже после одной самостоятельной правки они
 * разошлись — у одного он сворачивался, у другого стоял прямо в общем блоке.
 * Теперь вёрстка ровно одна, и разойтись ей больше негде.
 *
 * `record` — сигналы `samplerPreset`/`temperature`/`topP`/`topK`/`maxTokens`/
 * `reasoningMode`/`reasoningEffort`/`reasoningBudget`/`newPresetName` (те же
 * имена, что у самого Ядра моделей — см. `resolveGenerateRequest`). Для
 * Модуля «Трекер» это одна запись из списка трекеров; для «RP Time», у
 * которого трекер один, — объект-литерал из его собственных сигналов
 * верхнего уровня. Форма сигналов ОДНА и та же, откуда они взялись — не
 * забота этого файла.
 *
 * `presets` — массив пресетов (готовые из `SAMPLER_PRESETS` + свои) или
 * функция/сигнал на него, тем же приёмом, что `options` у `Select()`. У
 * готовых `custom` не проставлен, у сохранённых пользователем — `custom:
 * true` (см. `buildCustomPreset()` в cores/models/internal-engine.js): только
 * это отличает пресет, который можно удалить, от того, что всегда под рукой.
 *
 * `onSavePreset`/`onDeletePreset` — сама запись пресета в общий список идёт
 * через контракт `model.presets.set`, и вызывающий Модуль обязан пройти
 * через свой Гейт сам; этот файл только собирает имя из поля и зовёт колбэк.
 */
export function GenerationSettingsPanel(record, presets, { onApplyPreset, onSavePreset, onDeletePreset } = {}) {
    const readPresets = typeof presets === 'function' ? presets : () => presets;
    const selected = () => readPresets().find(item => item.id === record.samplerPreset());

    return Details('Generation settings (advanced)',
        Field('Generation preset', Select(record.samplerPreset, () => [
            { value: '', label: 'Custom (pick a preset below to start from one)' },
            ...readPresets().map(item => ({ value: item.id, label: item.name })),
        ], { onChange: id => onApplyPreset?.(id) }), {
            hint: computed(() => selected()?.description ?? ''),
        }),
        Row(
            Slider('Temperature', record.temperature, { min: 0, max: 2, step: 0.05 }),
            Slider('Top P', record.topP, { min: 0, max: 1, step: 0.01 }),
            Slider('Top K', record.topK, { min: 0, max: 200, step: 1 }),
            Slider('Max tokens', record.maxTokens, { min: 1, max: 4096, step: 1 }),
        ),
        Row(
            Field('Reasoning', Select(record.reasoningMode, REASONING_MODE_OPTIONS)),
            Field('Effort', Select(record.reasoningEffort, REASONING_EFFORT_OPTIONS), {
                hint: 'OpenRouter only — Anthropic and Google have no effort levels of their own.',
            }),
            Slider('Reasoning budget (tokens)', record.reasoningBudget, { min: 0, max: 32768, step: 64 }),
        ),
        Row(
            TextInput(record.newPresetName, { placeholder: 'Name this configuration…' }),
            Button('Save as preset', () => onSavePreset?.(record.newPresetName.peek())),
            // Удалить можно только СВОЙ — готовый из коробки всегда должен
            // остаться отправной точкой, к которой можно вернуться.
            computed(() => (selected()?.custom
                ? Button('Delete preset', () => onDeletePreset?.(record.samplerPreset.peek()), { variant: 'danger' })
                : null)),
        ),
    );
}
