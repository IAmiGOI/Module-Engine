/**
 * «Что сейчас открыто» — снимок раскрытых блоков панели для гида (cores/guide): по каждому раскрытому блоку — его путь, поля с подписью, подсказкой и
 * ТЕКУЩИМ значением, переключатели, ползунки и кнопки. Читается из живого DOM по разметке общих виджетов (`Field`, `Slider`, `Toggle`, `Card`/`Section`
 * с `data-stme-anchor`), поэтому правки в Модулях не нужны — как и у адресов блоков (cores/ui/anchors.js). Функции работают с любым деревом, у которого
 * есть `children`, `tagName`, `className`, `textContent` и обычные свойства элементов форм (в тестах — с рукописным деревом, без DOM).
 *
 * Секреты не отдаются НИКОГДА: поля-пароли и поля, в названии которых есть key / token / secret / password, приходят как «set» или «empty», без значения.
 * Размер ограничен (блоков, полей, символов) — снимок уходит модели в каждом запросе.
 */

const LIMITS = Object.freeze({ blocks: 10, fieldsPerBlock: 24, buttonsPerBlock: 10, valueChars: 90, hintChars: 160, chars: 2600 });
const SECRET_NAME = /\b(api[ _-]?key|key|token|secret|password|passphrase|credential)/i;

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const hasClass = (element, name) => (element.classList?.contains ? element.classList.contains(name) : ` ${element.className ?? ''} `.includes(` ${name} `));
const tag = element => String(element.tagName ?? '').toUpperCase();
const kids = element => [...(element.children ?? [])];

function textNodesOf(element) {
    return [...(element.childNodes ?? [])].filter(node => node.nodeType === 3).map(node => node.textContent).join('');
}

function findControl(element) {
    for (const child of kids(element)) {
        if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag(child))) return child;
        const inner = findControl(child);
        if (inner) return inner;
    }
    return null;
}

/** Значение элемента формы для человека; секреты — только «set» / «empty». */
export function readControl(control, name = '') {
    if (!control) return '';
    const type = String(control.type ?? '').toLowerCase();
    const secret = type === 'password' || SECRET_NAME.test(name);
    if (secret) return clean(control.value) ? 'set' : 'empty';
    if (type === 'checkbox') return control.checked ? 'on' : 'off';
    if (tag(control) === 'SELECT') return clean(control.options?.[control.selectedIndex]?.textContent ?? control.value).slice(0, LIMITS.valueChars);
    const value = clean(control.value);
    return (value || '(empty)').slice(0, LIMITS.valueChars);
}

function readField(element) {
    if (hasClass(element, 'stme-field')) {
        const label = kids(element).find(child => hasClass(child, 'stme-field-label'));
        if (!label) return null;
        const name = clean(textNodesOf(label)) || clean(label.textContent);
        const hint = clean(kids(label).find(child => tag(child) === 'SMALL')?.textContent);
        return { label: name, hint, value: readControl(findControl(element), name) };
    }
    if (hasClass(element, 'stme-slider')) {
        const head = kids(element).find(child => hasClass(child, 'stme-slider-head'));
        return { label: clean(kids(head ?? element)[0]?.textContent), hint: '', value: clean(kids(head ?? element).find(child => tag(child) === 'OUTPUT')?.textContent) };
    }
    if (hasClass(element, 'stme-switch')) {
        const label = kids(element).find(child => hasClass(child, 'stme-switch-label'));
        return { label: clean(textNodesOf(label ?? element)) || clean(label?.textContent), hint: clean(kids(label ?? element).find(child => tag(child) === 'SMALL')?.textContent), value: readControl(findControl(element)) };
    }
    return null;
}

function findByClass(element, name) {
    for (const child of kids(element)) {
        if (hasClass(child, name)) return child;
        const inner = findByClass(child, name);
        if (inner) return inner;
    }
    return null;
}

const titleOf = block => {
    const summary = kids(block).find(child => tag(child) === 'SUMMARY');
    const strong = summary ? kids(findByClass(summary, 'stme-card-title') ?? summary).find(child => tag(child) === 'STRONG') : null;
    return clean(strong?.textContent) || clean(block.dataset?.stmeAnchor);
};

function buttonLabel(button) {
    return clean(button.getAttribute?.('title')) || clean(button.getAttribute?.('aria-label')) || clean(button.textContent);
}

/**
 * Дерево корня → `[{ anchor, path, fields: [{ label, hint, value }], buttons: [text] }]` для РАСКРЫТЫХ блоков (у каждого — только его собственные поля, вложенные
 * блоки идут отдельными записями). Свёрнутые не читаются. `label` — название экрана («Panel», «Settings») в начале пути.
 */
export function snapshotOpenBlocks(root, { label = '' } = {}) {
    const out = [];
    const walk = (element, chain) => {
        for (const child of kids(element)) {
            if (child.hidden) continue;
            if (child.dataset?.stmeAnchor && tag(child) === 'DETAILS') {
                if (child.open !== true) continue;
                const block = { anchor: child.dataset.stmeAnchor, path: [label, ...chain.map(item => item.title), titleOf(child)].filter(Boolean).join(' › '), title: titleOf(child), fields: [], buttons: [] };
                if (out.length < LIMITS.blocks) out.push(block);
                walk(child, [...chain, block]);
                continue;
            }
            if (tag(child) === 'SUMMARY') continue;
            const owner = chain.at(-1);
            const field = owner ? readField(child) : null;
            if (field) { if (owner.fields.length < LIMITS.fieldsPerBlock && field.label) owner.fields.push(field); continue; }
            if (owner && tag(child) === 'BUTTON') {
                const text = buttonLabel(child);
                if (text && owner.buttons.length < LIMITS.buttonsPerBlock && !owner.buttons.includes(text)) owner.buttons.push(text);
                continue;
            }
            walk(child, chain);
        }
    };
    walk(root, []);
    return out;
}

/** Снимок → текст для системного промпта (с ограничением по символам). Пусто, если ничего не раскрыто. */
export function formatOpenBlocks(blocks) {
    if (!blocks.length) return '';
    const lines = ['Blocks the user has open right now (fields show their current values; "set"/"empty" means a secret you must not ask about):'];
    for (const block of blocks) {
        lines.push(`- ${block.path} [${block.anchor}]`);
        for (const field of block.fields) lines.push(`  · ${field.label}: ${field.value}${field.hint ? ` — ${field.hint.slice(0, LIMITS.hintChars)}` : ''}`);
        if (block.buttons.length) lines.push(`  buttons: ${block.buttons.join(', ')}`);
    }
    let text = '';
    for (const line of lines) {
        if ((text + line).length > LIMITS.chars) return `${text}\n  …(more is open)`;
        text += `${text ? '\n' : ''}${line}`;
    }
    return text;
}
