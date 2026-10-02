import { h } from '../../cores/ui/tree.js';
import { signal, computed } from '../../cores/ui/reactive.js';
import { Button, TextInput, TextArea, Select, Slider, Toggle, Field, Row, EmptyState } from '../../libraries/shared/widgets.js';

/**
 * Карточка Модуля Music в панели движка: настройки, добавление треков (файлы, прямая ссылка), кнопка разметки моделью и список треков с описаниями. Дерево `h()`;
 * состояние и действия приходят из Модуля (`index.js`) — здесь своего поведения нет.
 */
export function createMusicCard({ tracks, autoSwitch, contextMessages, minSimilarity, switchMargin, autoTag, smart, server, actions }) {
    const { saveSettings, savePlayer, importFiles, importLinkText, tagTracks, updateDescription, removeTrack, chooseSection } = actions;

    function trackRow(track) {
        const draft = signal(track.description);
        const input = TextArea(draft, { rows: 2, placeholder: 'Describe the mood, e.g. "tense urban fight at night"' });
        // TextArea пишeт в сигнал сама (см. widgets.js); правка визитки
        // коммитится по `change` (он всплывает от textarea до этой обёртки)
        // через props `on:change` — у vnode нет addEventListener, слушатели
        // ставит Сервис DOM при рендере.
        const committed = h('div', { 'on:change': () => { if (draft.peek() !== track.description) updateDescription(track.id, draft.peek()); } }, input);
        return h('div', { class: 'stme-music-track' },
            Row(
                h('strong', {}, track.name),
                h('small', { class: 'stme-music-plays', title: 'How this track was described' }, `${track.tagged === 'model' ? 'AI · ' : track.tagged === 'manual' ? 'Edited · ' : 'Title only · '}${track.source?.kind === 'url' ? 'Stream · ' : ''}${track.playCount ?? 0} plays`),
                Button('×', () => { removeTrack(track.id); }, { variant: 'danger' }),
            ),
            Field('Mood description', committed, { hint: track.vector ? 'Vector computed.' : 'Vector will be computed when embedding is available.' }),
        );
    }

    return (function tree() {
        // Внимание: `h()` даёт АБСТРАКТНОЕ дерево, у узла нет ни addEventListener,
        // ни click() (в отличие от Alpha, где виджеты — настоящие DOM-узлы).
        // Слушатели ставит Сервис DOM по props `on:*` при рендере — значит, и
        // file-input обязан быть видимым элементом со своим `on:change`, а не
        // скрытым, кликаемым из кнопки: кнопку «нажать» за vnode нечем.
        const fileInput = h('input', {
            type: 'file', accept: 'audio/*', multiple: true, class: 'stme-music-file',
            'on:change': event => {
                const input = event.target;
                importFiles([...(input.files ?? [])].map(file => ({ name: file.name, blob: file })));
                input.value = '';
            },
        });
        const linkDraft = signal('');
        // Библиотека сервера: виден только выбор раздела — ни треков, ни тегов пользователь не видит. Нет сервера или разделов — блока нет.
        const sectionOptions = computed(() => [{ value: '', label: 'Off — only my own tracks' }, ...server.sections().map(item => ({ value: item.id, label: item.name }))]);
        const sectionPicker = computed(() => (server.configured() && server.sections().length
            ? Field('Music library', Select(server.selected, sectionOptions, { onChange: id => { void chooseSection(id); } }), { hint: 'Ready-made music from the server. Pick a section — tracks start on their own to match the scene.' })
            : null));
        // Умное определение сцены: только вкл/выкл. Когда и о чём спрашивать Jev, решает сервер.
        const smartToggle = computed(() => (server.configured() && server.sections().length
            ? Toggle('Smart scene detection (Jev)', smart, { onChange: savePlayer, hint: 'When the music is about to change, your Jev connection (Models → Classifiers) rates the scene so the track fits it better. Without a Jev connection it is simply skipped.' })
            : null));
        return h('div', { class: 'stme-module-body' },
            sectionPicker,
            smartToggle,
            Row(
                h('small', { class: 'stme-module-hint' }, 'Picks background music that matches the scene — locally, by meaning, with no model calls. Describe each track in words; the closer its description to what is happening in the chat, the more likely it plays.'),
                Button('Save settings', saveSettings),
            ),
            Row(
                Toggle('Auto-switch with the scene', autoSwitch, { onChange: savePlayer }),
                Slider('Scene depth (last messages)', contextMessages, { min: 1, max: 12, step: 1 }),
                Slider('Min similarity', minSimilarity, { min: 0, max: 1, step: 0.05 }),
                Slider('Switch margin', switchMargin, { min: 0, max: 0.5, step: 0.01 }),
            ),
            Row(
                Toggle('Describe new tracks with the model', autoTag, { onChange: savePlayer, hint: 'A text model writes the mood and the fitting scene for every track from its title and artist, so tracks are picked by meaning with no manual notes. A track you edit yourself is never overwritten.' }),
                Button('Describe with the model', () => { void tagTracks(tracks.peek().map(track => track.id), { force: true }); }),
            ),
            Field('Add a direct audio link', Row(
                TextInput(linkDraft, { placeholder: 'https://example.com/music/track.mp3' }),
                Button('Add', async () => { if (await importLinkText(linkDraft.peek())) linkDraft.set(''); }),
            ), { hint: 'A link to an audio file or stream (.mp3, .ogg, .m4a, .flac …). Only the address is stored, never the audio.' }),
            Field('Import audio files', fileInput, { hint: 'Stored locally in this browser — metadata is portable, bytes are not.' }),
            h('div', { class: 'stme-music-list' },
                computed(() => (tracks().length ? tracks().map(trackRow) : [EmptyState('No tracks yet — import audio files above.')])),
            ),
        );
    })();
}
