import { h } from '../../cores/ui/tree.js';
import { signal, computed } from '../../cores/ui/reactive.js';
import { Button, TextInput, TextArea, Select, Field, Row, Section, Toggle, Slider, EmptyState, IconButton } from '../../libraries/shared/widgets.js';

const FORMAT_OPTIONS = [
    { value: 'pollinations', label: 'Pollinations (free, no key)' },
    { value: 'openai', label: 'OpenAI-compatible (DALL·E, gpt-image)' },
    { value: 'a1111', label: 'Automatic1111 / Forge / SD.Next' },
];
const BACKEND_TEMPLATES = {
    pollinations: { name: 'Pollinations', format: 'pollinations', endpoint: '', apiKey: '', model: 'flux' },
    openai: { name: 'OpenAI', format: 'openai', endpoint: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-image-1' },
    a1111: { name: 'Local Stable Diffusion', format: 'a1111', endpoint: 'http://127.0.0.1:7860', apiKey: '', model: '' },
};
const BUSY_TEXT = { writing: 'Writing the scene prompt…', painting: 'Painting…' };

let backendCounter = 0;

/**
 * Интерфейс Scene Painter: форма настроек (дерево модуля в панели) и виджет подвала сообщения. Состояние — сигналы модуля; здесь только
 * черновики формы и то, как это выглядит.
 */
export function createScenePainterView({ settings, images, busy, errors, textWorkers, imageWorkers, paint, removeImage, showInWindow, saveSettings, saveImageWorkers }) {
    // --- Черновик формы: правится свободно, в настройки уходит по «Save» ---
    const draft = Object.fromEntries(Object.keys(settings.peek()).map(key => [key, signal(settings.peek()[key])]));
    const syncDraft = () => { for (const [key, value] of Object.entries(settings.peek())) draft[key].set(value); };
    const readDraft = () => Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, value.peek()]));
    const backends = signal([]);
    const syncBackends = () => backends.set(imageWorkers.peek().map(worker => ({ ...worker })));

    function backendRow(backend) {
        const field = (key, placeholder, type) => {
            const value = signal(backend[key] ?? '');
            return TextInput(value, { placeholder, type, onInput: text => { backend[key] = text; } });
        };
        const format = signal(backend.format);
        return h('div', { class: 'stme-scene-painter-backend', key: backend.id },
            Row(field('name', 'Name'), Select(format, FORMAT_OPTIONS, { onChange: value => { backend.format = value; } }),
                IconButton('✕', () => backends.set(backends.peek().filter(item => item !== backend)), { title: 'Remove backend' })),
            Row(field('endpoint', 'Endpoint (empty = default)'), field('model', 'Model (optional)'), field('apiKey', 'API key / user:pass', 'password')),
        );
    }

    function addBackend(kind) {
        backendCounter += 1;
        backends.set([...backends.peek(), { id: `image-${Date.now().toString(36)}-${backendCounter}`, ...BACKEND_TEMPLATES[kind] }]);
    }

    function workerOptions(list, anyLabel) {
        return () => [{ value: '', label: anyLabel }, ...list().map(worker => ({ value: worker.id, label: worker.name || worker.id }))];
    }

    function tree() {
        syncDraft();
        syncBackends();
        return h('div', { class: 'stme-module-body' },
            Row(
                h('small', { class: 'stme-module-hint' }, 'Paints the current scene into the Picture window. A text model reads the last messages and writes the image prompt; an image backend draws it. The message text is never changed.'),
                Button('Save settings', () => saveSettings(readDraft())),
            ),
            Toggle('Paint automatically after every reply', draft.autoPaint, { hint: 'Otherwise use the 🎨 button under a reply.' }),
            Toggle('Open the Picture window when a picture is ready', draft.openWindow, { hint: 'Off: the picture waits under its reply — 🖼 shows it.' }),
            Row(
                Field('Prompt writer (text model)', Select(draft.promptWorkerId, workerOptions(textWorkers, 'Any model worker'))),
                Field('Image backend', Select(draft.imageWorkerId, workerOptions(imageWorkers, 'Any image backend'))),
            ),
            Row(
                Slider('Scene depth (last messages)', draft.contextMessages, { min: 1, max: 20, step: 1 }),
                Slider('Width', draft.width, { min: 256, max: 2048, step: 64 }),
                Slider('Height', draft.height, { min: 256, max: 2048, step: 64 }),
            ),
            Field('Style (appended to every prompt)', TextInput(draft.style, { placeholder: 'e.g. anime illustration, soft light' })),
            Field('Negative prompt', TextInput(draft.negativePrompt, { placeholder: 'what the picture must not have' }), { hint: 'Used by Stable Diffusion and Pollinations; OpenAI ignores it.' }),
            Field('Instruction for the prompt writer', TextArea(draft.instruction, { rows: 4 })),
            Section('Image backends', { subtitle: computed(() => `${imageWorkers().length} configured`) },
                h('div', { class: 'stme-scene-painter-backends' },
                    computed(() => (backends().length ? backends().map(backendRow) : [EmptyState('No image backends yet — add one below. Pollinations works without a key.')]))),
                Row(
                    Button('+ Pollinations (free)', () => addBackend('pollinations')),
                    Button('+ OpenAI-compatible', () => addBackend('openai')),
                    Button('+ Automatic1111 / Forge', () => addBackend('a1111')),
                ),
                Button('Save backends', () => saveImageWorkers(backends.peek())),
            ),
        );
    }

    /**
     * Подвал сообщения: только под ответами модели и только кнопки — сама картинка выводится в окно «Картинка». Всегда ОДНА пилюля одного
     * размера: до генерации — «Paint», после — те же рамка и высота, разделённые на сегменты. Круглые кнопки здесь нельзя: в Chat Viewport
     * подвал стоит в одной строке с кнопками самого сообщения (правка, удаление, свайпы) и путался с ними.
     */
    function segment(label, onClick, title) {
        return h('button', { type: 'button', class: 'stme-scene-painter-seg', title, 'aria-label': title, 'on:click': onClick }, label);
    }

    function footerWidget(message) {
        if (message.isUser || message.isSystem) return null;
        const mesid = String(message.mesid);
        return h('div', { class: 'stme-scene-painter' }, computed(() => {
            const state = busy()[mesid];
            if (state) return h('div', { class: 'stme-scene-painter-pill' }, h('span', { class: 'stme-scene-painter-status' }, `🎨 ${BUSY_TEXT[state]}`));
            const entry = images()[mesid];
            if (entry) {
                return h('div', { class: 'stme-scene-painter-pill', role: 'group', 'aria-label': 'Scene picture' },
                    segment('🖼 Show', () => showInWindow(mesid), `Show in the Picture window — ${entry.prompt}`),
                    segment('↻', () => paint(mesid), 'Paint again with a new prompt'),
                    segment('⟳', () => paint(mesid, { prompt: entry.prompt }), 'Paint again with the same prompt'),
                    segment('✕', () => removeImage(mesid), 'Remove the picture'));
            }
            const error = errors()[mesid];
            return h('div', { class: 'stme-scene-painter-pill' }, segment(error ? '🎨 Retry' : '🎨 Paint', () => paint(mesid), error ?? 'Paint this scene'));
        }));
    }

    return { tree, footerWidget, syncDraft };
}
