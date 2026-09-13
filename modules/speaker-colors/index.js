import { h } from '../../cores/ui/tree.js';
import { signal, computed } from '../../cores/ui/reactive.js';
import { request } from '../../libraries/shared/request.js';
import { computeAutoSpeakerColor } from '../../libraries/shared/color-palette.js';
import {
    Button, TextInput, Select, Field, Row, Section, List, EmptyState, ColorPicker, Badge,
} from '../../libraries/shared/widgets.js';

export const MODULE_ID = 'module.speakerColors';

/**
 * Модуль «Speaker Colors» — покраска РЕПЛИК по говорящему прямо в ленте
 * чата, без единого байта, ушедшего в контекст модели. Пользователь
 * подключает/отключает его как обычный Модуль (критерий ARCHITECTURE.md:
 * движок прекрасно работает и без него) — вся тяжёлая часть (кто говорит,
 * реестр, персистентность) живёт в переиспользуемом
 * [Ядре определения говорящего](../../cores/speaker/index.js); этот файл —
 * только политика ПОКРАСКИ (какой цвет новому говорящему, когда перекрашивать)
 * и проводка к виджетам.
 *
 * **Никакой правки `message.mes`.** Покраска идёт через
 * `stChat.messageTextElement` (реальный `.mes_text` узел, который ST УЖЕ
 * отрисовала) + `dom.paintTextRuns` (services/dom.js) — тот же класс
 * гарантии, что уже даёт cores/ui/message-footer.js: **движок не имеет
 * контракта на правку текста сообщения через этот путь вообще**, поэтому
 * подсветка физически не может просочиться в промпт следующего хода.
 * Раскраска детектируется НАД УЖЕ ОТРИСОВАННЫМ текстом (`dom.textContent`
 * узла), а не над сырым `mes` — иначе смещения от
 * [speaker-detection.js](../../libraries/core/speaker-detection.js) не
 * совпали бы с реальными текстовыми узлами там, где ST сама раскрасила
 * markdown (жирный/курсив превращаются в теги, а не остаются звёздочками).
 *
 * **Перекраска — не кооперативная**, тем же уроком, что уже оплачен Ядром
 * подвала сообщения: подписка на события ST, которые ЛЕГИТИМНО меняют
 * отрисованный текст (реролл, правка, стриминг, смена чата), плюс
 * `generation.completed` как финальный подчищающий проход — без единого
 * собственного таймера или счётчика ходов.
 *
 * **Автоцвет — из акцентного цвета темы ST** (`--SmartThemeQuoteColor`,
 * прочитан один раз при загрузке через `dom.readCssVariable`), по кругу
 * HSL ([color-palette.js](../../libraries/shared/color-palette.js)) —
 * решено с владельцем проекта явно (не жёсткая палитра, не только ручной
 * выбор). Ручная правка через `ColorPicker` (новый виджет библиотеки)
 * всегда побеждает и переживает автоцвет — `speaker.setColor` не различает
 * источник, оба пишут в тот же реестр.
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

    const entities = signal([]);
    const presets = signal([]);
    const newPresetName = signal('');
    const selectedPresetId = signal('');
    const colorSignals = new Map(); // speakerId -> signal(hex) — stable per id, see UI.md's "signal never created inside renderItem"
    const nameSignals = new Map(); // speakerId -> signal(name) — same discipline, for the rename field

    /** ST's theme accent — read ONCE at load(), not on every repaint: the theme does not change mid-session, and a per-message round trip would be pure waste. */
    let baseAccentColor = '#3f51b5';

    /** Overwrites on every call — a color can change from OUTSIDE this row (preset apply, another repaint's auto-assignment) and the picker must catch up. */
    function colorSignalFor(id, initial) {
        if (!colorSignals.has(id)) colorSignals.set(id, signal(initial));
        else colorSignals.get(id).set(initial);
        return colorSignals.get(id);
    }

    /** Created ONCE per id and never overwritten from a later registry refresh — unlike colorSignalFor, so an in-progress keystroke in the rename field is never clobbered by the very refresh that keystroke itself triggered. */
    function nameSignalFor(id, initial) {
        if (!nameSignals.has(id)) nameSignals.set(id, signal(initial));
        return nameSignals.get(id);
    }

    async function refreshRegistry() {
        const result = await call('speaker.registry.get', {});
        if (result.ok) entities.set(result.value);
    }

    async function refreshPresets() {
        const result = await call('speaker.presets.get', {});
        if (result.ok) presets.set(result.value);
    }

    /** Assigns and PERSISTS an auto color for a freshly-discovered speaker — rotation index is how many speakers already carry a color, so re-resolving the same chat never reassigns an already-colored speaker a different hue. */
    async function assignAutoColor(id, coloredCountSoFar) {
        const color = computeAutoSpeakerColor(baseAccentColor, coloredCountSoFar);
        await call('speaker.setColor', { id, color });
        return color;
    }

    /**
     * Repaints ONE message: resolves speakers over its OWN rendered text
     * (never raw `mes`) and paints the result — see file doc-comment for why
     * offsets must come from the same string that gets painted.
     *
     * `defaultSpeakerName` — that message's own ST card owner (`name` field
     * off `stChat.messages`), forwarded to `speaker.resolve` as the fallback
     * for a message that never names its speaker in its OWN text at all
     * (the common case for a single-character reply: "She looks at you...",
     * never "Lisawoo looks at you..." — the name was established many
     * messages earlier). See libraries/core/speaker-detection.js's doc
     * comment on `detectSpeakers()` for exactly how it's used.
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

        const registryResult = await call('speaker.registry.get', {});
        const colorById = new Map((registryResult.ok ? registryResult.value : []).map(entity => [entity.id, entity.color]));
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
        await refreshRegistry();
    }

    async function repaintAll() {
        const rendered = await callService('stChat.rendered', {});
        if (!rendered.ok) return;
        const namesResult = await callService('stChat.messages', { limit: Math.max(rendered.value.length, 50), includeSystem: true });
        const nameByMesid = new Map((namesResult.ok ? namesResult.value : []).map(message => [message.mesid, message.name]));
        for (const message of rendered.value) await repaintMessage(message.mesid, nameByMesid.get(message.mesid));
    }

    async function handleColorChange(id, color) {
        colorSignalFor(id, color);
        await call('speaker.setColor', { id, color });
        await refreshRegistry();
        await repaintAll(); // the color just changed — every existing painted span for this speaker must catch up immediately
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
        await refreshRegistry();
        await repaintAll();
    }

    async function handleDeletePreset() {
        if (!selectedPresetId()) return;
        await call('speaker.presets.delete', { id: selectedPresetId() });
        selectedPresetId.set('');
        await refreshPresets();
    }

    function speakerRow(entity) {
        return h('div', { key: entity.id, class: 'stme-speaker-row' },
            Row(
                TextInput(nameSignalFor(entity.id, entity.name), {
                    onInput: name => { void call('speaker.rename', { id: entity.id, name }); },
                }),
                Badge(entity.gender === 'unknown' ? '?' : entity.gender, { tone: 'muted' }),
                ColorPicker(colorSignalFor(entity.id, entity.color ?? '#888888'), { onChange: color => { void handleColorChange(entity.id, color); } }),
            ),
        );
    }

    function tree() {
        return Section('Speaker Colors', {},
            computed(() => (entities().length ? entities().map(speakerRow) : [EmptyState('No speakers discovered yet — they appear as messages are painted.')])),
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
        await refreshRegistry();
        await refreshPresets();
        await repaintAll();
    }

    return {
        id: MODULE_ID,
        title: 'Speaker Colors',
        description: 'Colors each character\'s dialogue by speaker, detected locally — never touches the message text sent to the model.',
        load,
        tree,
        stop: () => { for (const unsubscribe of subscriptions) unsubscribe(); },
    };
}
