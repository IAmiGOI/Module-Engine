import { h } from '../ui/tree.js';
import { signal, computed } from '../ui/reactive.js';
import { createDragHandlers } from '../../libraries/shared/draggable.js';
import { FloatingPanel, Avatar, Button, TextInput, TextArea, Field, Row, Select } from '../../libraries/shared/widgets.js';
import { parseGuideReply, parseInline } from '../../libraries/core/guide-markup.js';

/**
 * Окно чата гида: сообщения с блоками разметки (libraries/core/guide-markup.js), пилюля ввода и экран настройки персонажа. Сообщение устроено как строка
 * обычного чата: слева аватар 3×4 (у серии реплик подряд — только у первой), справа имя и текст без пузыря; ввод — та же пилюля, что внизу окна ST. Состояние —
 * сигналы Ядра (cores/guide/index.js); здесь только то, как это выглядит. Список сообщений идёт в обратном порядке внутри
 * `flex-direction: column-reverse` — так прокрутка сама держится у последней реплики без доступа к DOM.
 */
export function createGuideWindow({ defaultAvatar = '', persona, messages, busy, visible, view, ask, chooseOption, pick, preview, runAction, reveal, close, saveSettings, resetChat, checklistState, workersList }) {
    const position = signal({ right: 24, bottom: 96 });
    const size = signal({ width: 540, height: 680 });
    const collapsed = signal(false);
    const draft = signal('');

    const anchorChip = (label, anchor) => h('button', { type: 'button', class: 'stme-guide-link', title: `Show: ${anchor}`, 'on:click': () => reveal(anchor) }, label);

    function inline(text) {
        return parseInline(text).map(part => {
            if (part.type === 'bold') return h('strong', {}, part.text);
            if (part.type === 'anchor') return anchorChip(part.label, part.anchor);
            if (part.type === 'url') return h('a', { href: part.url, target: '_blank', rel: 'noopener' }, part.label);
            return part.text;
        });
    }
    const paragraphs = text => text.split(/\n{2,}/).map(chunk => h('p', {}, chunk.split('\n').flatMap((line, index) => (index ? [h('br', {}), ...inline(line)] : inline(line)))));

    function checklistBlock() {
        const items = signal(null);
        void checklistState().then(list => items.set(list));
        return h('div', { class: 'stme-guide-block stme-guide-checklist' }, computed(() => {
            const list = items();
            if (!list) return h('small', {}, 'Loading…');
            const done = list.filter(item => item.done).length;
            return [h('strong', {}, `First start — ${done} of ${list.length}`), h('ul', {}, list.map(item => h('li', { class: item.done ? 'stme-guide-done' : '' },
                h('span', { class: 'stme-guide-check' }, item.done ? '✓' : '○'), item.anchor ? anchorChip(item.title, item.anchor) : item.title)))];
        }));
    }

    const proposalStates = new Map();

    /** Карточка «что будет создано» + Apply. Показывает то, что реально запишется (`preview`), а не слова модели; после нажатия — итог, повторно не создаёт. */
    function proposalBlock(data) {
        const shown = preview(data.action, data.params);
        if (!shown.ok) return h('div', { class: 'stme-guide-block stme-guide-proposal' }, h('small', {}, `I can't create that: ${shown.error}`));
        // Список сообщений перерисовывается при каждой реплике — состояние кнопки живёт вне блока, иначе «Applied» сбрасывался бы в «Apply».
        const key = JSON.stringify([data.action, data.params]);
        if (!proposalStates.has(key)) proposalStates.set(key, signal('idle'));   // idle | busy | done | failed
        const state = proposalStates.get(key);
        const apply = async () => {
            if (state.peek() === 'busy' || state.peek() === 'done') return;
            state.set('busy');
            const result = await runAction(data.action, data.params);
            state.set(result.ok ? 'done' : 'failed');
        };
        return h('div', { class: 'stme-guide-block stme-guide-proposal' }, h('strong', {}, shown.title),
            h('ul', {}, shown.lines.map(line => h('li', {}, line))),
            computed(() => Button(({ idle: 'Apply', busy: 'Applying…', done: '✓ Applied', failed: 'Try again' })[state()], apply)));
    }

    function block(data) {
        if (data.kind === 'choice') {
            return h('div', { class: 'stme-guide-block stme-guide-choice' }, data.prompt ? h('small', {}, data.prompt) : null,
                h('div', { class: 'stme-guide-options' }, data.options.map(option => Button(option.label, () => pick(option)))));
        }
        if (data.kind === 'card') {
            return h('div', { class: 'stme-guide-block stme-guide-card' }, data.title ? h('strong', {}, data.title) : null,
                data.text ? paragraphs(data.text) : null, data.anchor ? anchorChip('Show me', data.anchor) : null);
        }
        if (data.kind === 'steps') {
            return h('div', { class: 'stme-guide-block stme-guide-steps' }, data.title ? h('strong', {}, data.title) : null,
                h('ol', {}, data.items.map(item => h('li', {}, inline(item.text), item.anchor ? anchorChip('→', item.anchor) : null))));
        }
        if (data.kind === 'proposal') return proposalBlock(data);
        if (data.kind === 'action') return h('div', { class: 'stme-guide-block stme-guide-action' }, Button(`⚡ ${data.label}`, () => runAction(data.action, data.params)));
        return checklistBlock();
    }

    const AVATAR = Object.freeze({ width: 96, height: 128 });

    function avatar(size = AVATAR) {
        const { name } = persona.peek();
        return Avatar(persona.peek().avatar || defaultAvatar, { ...size, name });
    }

    /** Строка сообщения как в обычном чате: колонка аватара + колонка «имя / текст». `showAvatar=false` — продолжение серии: колонка остаётся пустой, текст не «прыгает». */
    function row({ key, kind, who, body, showAvatar }) {
        const rail = kind === 'assistant'
            ? h('div', { class: 'stme-guide-rail', style: { width: `${AVATAR.width}px` } }, showAvatar ? avatar() : null)
            : null;
        return h('div', { class: `stme-guide-row stme-guide-row-${kind}`, key },
            rail,
            h('div', { class: 'stme-guide-col' }, showAvatar ? h('div', { class: 'stme-guide-name' }, who) : null, body));
    }

    function messageView(message, isLast, showAvatar) {
        if (message.role === 'note') return h('div', { class: `stme-guide-note ${message.ok === false ? 'stme-guide-note-error' : ''}`, key: message.id }, `${message.ok === false ? '⚠' : '✓'} ${message.text}`);
        if (message.role === 'user') return row({ key: message.id, kind: 'user', who: 'You', showAvatar, body: h('div', { class: 'stme-guide-text stme-guide-user-text' }, message.text) });
        const parsed = parseGuideReply(message.text).map(segment => (segment.type === 'text' ? paragraphs(segment.text) : block(segment.block)));
        const options = isLast && message.options?.length
            ? h('div', { class: 'stme-guide-options' }, message.options.map((option, index) => Button(option.label, () => chooseOption(message.id, index))))
            : null;
        return row({ key: message.id, kind: 'assistant', who: persona.peek().name, showAvatar, body: h('div', { class: 'stme-guide-text' }, parsed, options) });
    }

    function send() {
        const text = draft.peek().trim();
        if (!text || busy.peek()) return;
        draft.set('');
        void ask(text);
    }

    /** Пилюля ввода — тот же вид, что у нижней панели набора: поле и концевой сегмент «отправить» (стоит на месте при росте поля). */
    function composer() {
        const autosize = element => { element.style.height = 'auto'; element.style.height = `${Math.min(element.scrollHeight, 160)}px`; };
        const field = h('textarea', {
            class: 'stme-input-field stme-guide-field', rows: 1, placeholder: 'Ask anything about Module Engine…', 'aria-label': 'Message', value: draft,
            'on:input': event => { draft.set(event.target.value); autosize(event.target); },
            'on:keydown': event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } },
        });
        return h('div', { class: 'stme-guide-composer' }, field,
            h('button', { type: 'button', class: computed(() => `stme-input-circle stme-input-send${busy() ? ' stme-guide-send-busy' : ''}`), title: 'Send', 'aria-label': 'Send', 'on:click': send },
                h('i', { class: 'fa-solid fa-paper-plane', 'aria-hidden': 'true' })));
    }

    function chatView() {
        return h('div', { class: 'stme-guide-chat' },
            h('div', { class: 'stme-guide-list' }, computed(() => {
                const list = messages();
                const lastAssistant = [...list].reverse().find(message => message.role === 'assistant');
                const rendered = list.map((message, index) => messageView(message, message === lastAssistant, list[index - 1]?.role !== message.role));
                if (busy()) rendered.push(row({ key: 'typing', kind: 'assistant', who: persona().name, showAvatar: list.at(-1)?.role !== 'assistant', body: h('div', { class: 'stme-guide-text stme-guide-typing' }, 'is thinking…') }));
                return rendered.reverse();
            })),
            composer());
    }

    function settingsView() {
        const current = persona.peek();
        const fields = Object.fromEntries(Object.keys(current).map(key => [key, signal(current[key] ?? '')]));
        const workers = signal([]);
        void workersList().then(list => workers.set(list));
        const read = () => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.peek()]));
        return h('div', { class: 'stme-guide-settings' },
            Row(Field('Name', TextInput(fields.name)), Field('Model', Select(fields.workerId, () => [{ value: '', label: 'Any connection' }, ...workers().map(worker => ({ value: worker.id, label: worker.name || worker.id }))]))),
            Field('Avatar image URL', TextInput(fields.avatar, { placeholder: 'Empty = the built-in picture' })),
            Field('Personality', TextArea(fields.personality, { rows: 3 })),
            Field('Speech style', TextArea(fields.style, { rows: 2 })),
            Field('Greeting (new chat, model connected)', TextArea(fields.greeting, { rows: 2 })),
            Field('Extra instructions', TextArea(fields.instructions, { rows: 3 })),
            Field('Your own knowledge', TextArea(fields.knowledge, { rows: 5, placeholder: 'Notes she always knows. Separate notes with a line of ---' })),
            Row(Button('Save', async () => { await saveSettings(read()); view.set('chat'); }), Button('Back', () => view.set('chat'))),
            Row(Button('Clear the chat', () => resetChat()), Button('Replay the setup scenario', () => { view.set('chat'); void resetChat({ scenario: true }); })));
    }

    function tree() {
        return h('div', { class: 'stme-guide-root' }, computed(() => (visible() ? FloatingPanel(persona().name, {
            position, size, collapsed, className: 'stme-guide-window', minWidth: 380, minHeight: 420,
            onToggle: value => collapsed.set(value), onClose: () => close(),
            drag: createDragHandlers(position), onResize: next => size.set(next),
        },
        h('div', { class: 'stme-guide-toolbar' }, avatar({ width: 30, height: 40 }), h('strong', {}, persona().name), h('span', { class: 'stme-guide-spacer' }),
            Button(view() === 'settings' ? 'Chat' : '⚙ Settings', () => view.set(view.peek() === 'settings' ? 'chat' : 'settings'))),
        view() === 'settings' ? settingsView() : chatView()) : null)));
    }

    return { tree };
}
