import { h } from '../ui/tree.js';
import { signal, computed } from '../ui/reactive.js';
import { createDragHandlers } from '../../libraries/shared/draggable.js';
import { FloatingPanel, Button, TextInput, TextArea, Field, Row, Select } from '../../libraries/shared/widgets.js';
import { parseGuideReply, parseInline } from '../../libraries/core/guide-markup.js';

/**
 * Окно чата гида: сообщения с блоками разметки (libraries/core/guide-markup.js), поле ввода и экран настройки персонажа. Состояние —
 * сигналы Ядра (cores/guide/index.js); здесь только то, как это выглядит. Список сообщений идёт в обратном порядке внутри
 * `flex-direction: column-reverse` — так прокрутка сама держится у последней реплики без доступа к DOM.
 */
export function createGuideWindow({ defaultAvatar = '', persona, messages, busy, visible, view, ask, chooseOption, runAction, reveal, close, saveSettings, resetChat, checklistState, workersList }) {
    const position = signal({ right: 24, bottom: 96 });
    const size = signal({ width: 420, height: 600 });
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

    function block(data) {
        if (data.kind === 'choice') {
            return h('div', { class: 'stme-guide-block stme-guide-choice' }, data.prompt ? h('small', {}, data.prompt) : null,
                h('div', { class: 'stme-guide-options' }, data.options.map(option => Button(option.label, () => ask(option.send || option.label)))));
        }
        if (data.kind === 'card') {
            return h('div', { class: 'stme-guide-block stme-guide-card' }, data.title ? h('strong', {}, data.title) : null,
                data.text ? paragraphs(data.text) : null, data.anchor ? anchorChip('Show me', data.anchor) : null);
        }
        if (data.kind === 'steps') {
            return h('div', { class: 'stme-guide-block stme-guide-steps' }, data.title ? h('strong', {}, data.title) : null,
                h('ol', {}, data.items.map(item => h('li', {}, inline(item.text), item.anchor ? anchorChip('→', item.anchor) : null))));
        }
        if (data.kind === 'action') return h('div', { class: 'stme-guide-block stme-guide-action' }, Button(`⚡ ${data.label}`, () => runAction(data.action, data.params)));
        return checklistBlock();
    }

    function messageView(message, isLast) {
        if (message.role === 'note') return h('div', { class: `stme-guide-note ${message.ok === false ? 'stme-guide-note-error' : ''}`, key: message.id }, `${message.ok === false ? '⚠' : '✓'} ${message.text}`);
        if (message.role === 'user') return h('div', { class: 'stme-guide-msg stme-guide-user', key: message.id }, h('div', { class: 'stme-guide-bubble' }, message.text));
        const body = parseGuideReply(message.text).map(segment => (segment.type === 'text' ? paragraphs(segment.text) : block(segment.block)));
        const options = isLast && message.options?.length
            ? h('div', { class: 'stme-guide-options' }, message.options.map((option, index) => Button(option.label, () => chooseOption(message.id, index))))
            : null;
        return h('div', { class: 'stme-guide-msg stme-guide-assistant', key: message.id },
            avatar(), h('div', { class: 'stme-guide-bubble' }, body, options));
    }

    function avatar() {
        const { name } = persona.peek();
        const url = persona.peek().avatar || defaultAvatar;
        return url ? h('img', { class: 'stme-guide-avatar', src: url, alt: name }) : h('div', { class: 'stme-guide-avatar stme-guide-avatar-empty' }, (name || 'G').slice(0, 1));
    }

    function send() {
        const text = draft.peek().trim();
        if (!text || busy.peek()) return;
        draft.set('');
        void ask(text);
    }

    function chatView() {
        return h('div', { class: 'stme-guide-chat' },
            h('div', { class: 'stme-guide-list' }, computed(() => {
                const list = messages();
                const lastAssistant = [...list].reverse().find(message => message.role === 'assistant');
                const rendered = list.map(message => messageView(message, message === lastAssistant));
                if (busy()) rendered.push(h('div', { class: 'stme-guide-typing', key: 'typing' }, `${persona().name} is thinking…`));
                return rendered.reverse();
            })),
            h('div', { class: 'stme-guide-input' },
                h('textarea', {
                    class: 'text_pole', rows: 2, placeholder: 'Ask anything about Module Engine…', value: draft,
                    'on:input': event => draft.set(event.target.value),
                    'on:keydown': event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } },
                }),
                Button('Send', send)));
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
            position, size, collapsed, className: 'stme-guide-window', minWidth: 320, minHeight: 360,
            onToggle: value => collapsed.set(value), onClose: () => close(),
            drag: createDragHandlers(position), onResize: next => size.set(next),
        },
        h('div', { class: 'stme-guide-toolbar' }, avatar(), h('strong', {}, persona().name), h('span', { class: 'stme-guide-spacer' }),
            Button(view() === 'settings' ? 'Chat' : '⚙ Settings', () => view.set(view.peek() === 'settings' ? 'chat' : 'settings'))),
        view() === 'settings' ? settingsView() : chatView()) : null)));
    }

    return { tree };
}
