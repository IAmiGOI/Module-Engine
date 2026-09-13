import { h } from '../../cores/ui/tree.js';
import { signal, computed } from '../../cores/ui/reactive.js';
import { request } from '../../libraries/shared/request.js';
import { computeAutoSpeakerColor } from '../../libraries/shared/color-palette.js';
import {
    Button, TextInput, Select, Field, Row, Section, EmptyState, ColorPicker,
} from '../../libraries/shared/widgets.js';

export const MODULE_ID = 'module.speakerColors';

/** Fixed choices — gender is a property the USER states about a character, never inferred from pronouns in prose (see file doc comment). */
const GENDER_OPTIONS = [
    { value: 'unknown', label: 'Unknown' },
    { value: 'F', label: 'Female' },
    { value: 'M', label: 'Male' },
    { value: 'they', label: 'They' },
];

/**
 * Модуль «Speaker Colors» — покраска РЕПЛИК по говорящему прямо в ленте
 * чата, без единого байта, ушедшего в контекст модели. Вся тяжёлая часть
 * (состав, резолвинг, персистентность) живёт в переиспользуемом
 * [Ядре определения говорящего](../../cores/speaker/index.js); этот файл —
 * только UI ввода состава, политика ПОКРАСКИ и проводка к виджетам.
 *
 * **Состав вводит ПОЛЬЗОВАТЕЛЬ, а не детектор.** Прямая формулировка
 * владельца после того, как первая версия заводила отдельного "говорящего"
 * на каждое капитализированное слово прозы: "Идёт персонаж. У него имя. И у
 * него/неё пол. По этому ты определяешь, кто говорит. Просто пусть
 * ПОЛЬЗОВАТЕЛЬ вводит персонажей." — секция ниже начинается с формы
 * «Add character» (имя + пол), а `speaker.resolve` только СОПОСТАВЛЯЕТ
 * текст с уже введённым составом (см. [speaker-detection.js](../../libraries/core/speaker-detection.js)'s
 * doc comment за полной историей и ROADMAP.md 5.40).
 *
 * **Никакой правки `message.mes`.** Покраска идёт через
 * `stChat.messageTextElement` (реальный `.mes_text` узел, который ST УЖЕ
 * отрисовала) + `dom.paintTextRuns` (services/dom.js) — движок физически не
 * имеет контракта на правку текста сообщения через этот путь, поэтому
 * подсветка не может просочиться в промпт следующего хода. Детекция идёт
 * над УЖЕ ОТРИСОВАННЫМ текстом (`dom.textContent` узла), а не над сырым
 * `mes` — иначе смещения не совпали бы там, где ST раскрасила markdown.
 *
 * **Перекраска — не кооперативная**: подписка на события ST, которые
 * ЛЕГИТИМНО меняют отрисованный текст (свайп/правка/рендер/смена чата) плюс
 * `generation.completed` финальным подчищающим проходом — без своих таймеров.
 *
 * **Цвет — единственное, что этот Модуль ещё выбирает автоматически**
 * (не имя, не пол — только косметика): новый персонаж БЕЗ явно заданного
 * цвета получает следующий по кругу HSL от акцентного цвета темы ST
 * ([color-palette.js](../../libraries/shared/color-palette.js)). Ручная
 * правка через `ColorPicker` всегда побеждает.
 */

const REDRAW_EVENTS = Object.freeze([
    'st.messageSwiped', 'st.messageEdited', 'st.messageUpdated', 'st.messageDeleted',
    'st.characterMessageRendered', 'st.userMessageRendered', 'st.chatChanged', 'generation.completed',
]);

const ACCENT_CSS_VARIABLE = '--SmartThemeQuoteColor';

export function createSpeakerColorsModule(host) {
    /** `speaker.*` — the Ядро определения говорящего contracts, on the Шина ядер. */
    async function call(contract, params) {
        return request(host.cores, contract, { params });
    }

    /** `stChat.*`/`dom.*` — real Сервис contracts (services/st-chat.js, services/dom.js), on the Шина сервисов — a DIFFERENT bus/Гейт than `call()` above. */
    async function callService(contract, params) {
        return request(host.services, contract, { params });
    }

    const cast = signal([]);
    const presets = signal([]);
    const newCharacterName = signal('');
    const newCharacterGender = signal('unknown');
    const newPresetName = signal('');
    const selectedPresetId = signal('');
    const colorSignals = new Map(); // speakerId -> signal(hex) — stable per id, see UI.md's "signal never created inside renderItem"

    /** ST's theme accent — read ONCE at load(), not on every repaint: the theme does not change mid-session, and a per-message round trip would be pure waste. */
    let baseAccentColor = '#3f51b5';

    /** Overwrites on every call — a color can change from OUTSIDE this row (preset apply, another repaint's auto-assignment) and the picker must catch up. */
    function colorSignalFor(id, initial) {
        if (!colorSignals.has(id)) colorSignals.set(id, signal(initial));
        else colorSignals.get(id).set(initial);
        return colorSignals.get(id);
    }

    async function refreshCast() {
        const result = await call('speaker.cast.list', {});
        if (result.ok) cast.set(result.value);
    }

    /**
     * Refreshes the preset list AND keeps `selectedPresetId` pointed at a
     * REAL entry — found live: a native `<select>` with no `<option selected>`
     * (i.e. `selectedPresetId` still `''`, before the user ever clicks the
     * dropdown) falls back to showing its FIRST option highlighted, purely a
     * browser default. That left the signal at `''` while the dropdown
     * visually showed a preset "selected" — clicking Apply/Delete then
     * silently no-op'd (`if (!selectedPresetId()) return;`), which is
     * exactly the bug reported ("если выбран пресет — его нельзя
     * редактировать и персонажи не отображаются"): nothing was ever ACTUALLY
     * selected, only drawn that way. Snapping the signal to match the first
     * real preset (or back to `''` when the list is empty) the moment the
     * list loads keeps the signal truthful to what's visually shown.
     */
    async function refreshPresets() {
        const result = await call('speaker.presets.get', {});
        if (!result.ok) return;
        presets.set(result.value);
        if (!result.value.some(preset => preset.id === selectedPresetId())) {
            selectedPresetId.set(result.value[0]?.id ?? '');
        }
    }

    /** Assigns and PERSISTS an auto color for a character added without one — rotation index is how many cast members already carry a color, so re-painting never reassigns an already-colored character a different hue. */
    async function assignAutoColor(id, coloredCountSoFar) {
        const color = computeAutoSpeakerColor(baseAccentColor, coloredCountSoFar);
        await call('speaker.cast.update', { id, color });
        return color;
    }

    /**
     * Repaints ONE message: resolves speakers over its OWN rendered text
     * (never raw `mes`) against the user-entered cast, and paints the
     * result — see file doc-comment for why offsets must come from the same
     * string that gets painted.
     *
     * `defaultSpeakerName` — that message's own ST card owner (`name` field
     * off `stChat.messages`) — only ever used as a fallback if it ALREADY
     * matches a cast member the user added; never creates one.
     */
    async function repaintMessage(mesid, defaultSpeakerName) {
        const nodeResult = await callService('stChat.messageTextElement', { mesid });
        if (!nodeResult.ok || !nodeResult.value) return;
        const node = nodeResult.value;

        const textResult = await callService('dom.textContent', { node });
        const text = textResult.ok ? textResult.value : '';
        if (!text.trim()) { await callService('dom.clearPaintedRuns', { container: node }); return; }

        const resolved = await call('speaker.resolve', { text, mesid, defaultSpeakerName });
        if (!resolved.ok) return;

        const castResult = await call('speaker.cast.list', {});
        const colorById = new Map((castResult.ok ? castResult.value : []).map(entity => [entity.id, entity.color]));
        let coloredCount = [...colorById.values()].filter(Boolean).length;

        const runs = [];
        for (const segment of resolved.value.segments) {
            if (segment.type !== 'dialogue' || !segment.speaker || segment.confidence <= 0) continue;
            let color = colorById.get(segment.speaker.id);
            if (!color) {
                color = await assignAutoColor(segment.speaker.id, coloredCount);
                coloredCount += 1;
                colorById.set(segment.speaker.id, color);
            }
            runs.push({ start: segment.start, end: segment.end, color });
        }

        await callService('dom.paintTextRuns', { container: node, runs });
        await refreshCast();
    }

    async function repaintAll() {
        const rendered = await callService('stChat.rendered', {});
        if (!rendered.ok) return;
        const namesResult = await callService('stChat.messages', { limit: Math.max(rendered.value.length, 50), includeSystem: true });
        const nameByMesid = new Map((namesResult.ok ? namesResult.value : []).map(message => [message.mesid, message.name]));
        for (const message of rendered.value) await repaintMessage(message.mesid, nameByMesid.get(message.mesid));
    }

    async function handleAddCharacter() {
        const name = newCharacterName().trim();
        if (!name) return;
        const result = await call('speaker.cast.add', { name, gender: newCharacterGender() });
        if (!result.ok) return; // duplicate name — Ядро already rejected it, nothing else to do here
        newCharacterName.set('');
        newCharacterGender.set('unknown');
        await refreshCast();
        await repaintAll();
    }

    async function handleRemoveCharacter(id) {
        await call('speaker.cast.remove', { id });
        await refreshCast();
        await repaintAll();
    }

    async function handleGenderChange(id, gender) {
        await call('speaker.cast.update', { id, gender });
        await refreshCast();
        await repaintAll(); // gender affects PRONOUN resolution — a change can reassign existing painted quotes
    }

    async function handleColorChange(id, color) {
        colorSignalFor(id, color);
        await call('speaker.cast.update', { id, color });
        await refreshCast();
        await repaintAll(); // the color just changed — every existing painted span for this character must catch up immediately
    }

    async function handleSavePreset() {
        const name = newPresetName().trim();
        if (!name) return;
        await call('speaker.presets.save', { name });
        newPresetName.set('');
        await refreshPresets();
    }

    async function handleApplyPreset() {
        if (!selectedPresetId()) return;
        await call('speaker.presets.apply', { id: selectedPresetId() });
        await refreshCast();
        await repaintAll();
    }

    async function handleDeletePreset() {
        if (!selectedPresetId()) return;
        await call('speaker.presets.delete', { id: selectedPresetId() });
        selectedPresetId.set('');
        await refreshPresets();
    }

    function characterRow(entity) {
        return h('div', { key: entity.id, class: 'stme-speaker-row' },
            Row(
                h('span', { class: 'stme-speaker-name' }, entity.name),
                Select(signal(entity.gender), GENDER_OPTIONS, { onChange: gender => { void handleGenderChange(entity.id, gender); } }),
                ColorPicker(colorSignalFor(entity.id, entity.color ?? '#888888'), { onChange: color => { void handleColorChange(entity.id, color); } }),
                Button('Remove', () => { void handleRemoveCharacter(entity.id); }, { variant: 'danger' }),
            ),
        );
    }

    function tree() {
        return Section('Speaker Colors', {},
            Field('Add character',
                Row(
                    TextInput(newCharacterName, { placeholder: 'Character name' }),
                    Select(newCharacterGender, GENDER_OPTIONS),
                    Button('Add', () => { void handleAddCharacter(); }),
                ),
            ),
            computed(() => (cast().length ? cast().map(characterRow) : [EmptyState('No characters yet — add one above.')])),
            Field('Save current cast as preset',
                Row(
                    TextInput(newPresetName, { placeholder: 'Preset name' }),
                    Button('Save as preset', () => { void handleSavePreset(); }),
                ),
            ),
            Field('Apply a saved preset',
                Row(
                    Select(selectedPresetId, computed(() => presets().map(preset => ({ value: preset.id, label: preset.name })))),
                    Button('Apply', () => { void handleApplyPreset(); }),
                    Button('Delete', () => { void handleDeletePreset(); }, { variant: 'danger' }),
                ),
            ),
        );
    }

    const subscriptions = REDRAW_EVENTS.map(event => host.events.subscribe(event, () => { void repaintAll(); }));

    async function load() {
        const accent = await callService('dom.readCssVariable', { name: ACCENT_CSS_VARIABLE });
        if (accent.ok && accent.value) baseAccentColor = accent.value;
        await refreshCast();
        await refreshPresets();
        await repaintAll();
    }

    return {
        id: MODULE_ID,
        title: 'Speaker Colors',
        description: 'Colors each character\'s dialogue by speaker — you enter the cast (name + gender), it never guesses new characters from prose.',
        load,
        tree,
        stop: () => { for (const unsubscribe of subscriptions) unsubscribe(); },
    };
}
