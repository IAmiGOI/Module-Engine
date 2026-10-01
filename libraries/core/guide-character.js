import { normalizeCardFields, TEXT_FIELD_LIMITS } from './character-card.js';

/**
 * Карточки персонажей для гида: предложение `character.create` / `character.update` приходит блоком ```proposal``` и здесь приводится к тому, что реально
 * запишет Ядро `characterCard` (та же нормализация) — карточка-предложение показывает записываемое, а не слова модели. Вторая половина —
 * `buildCharacterView`: текст карточки для модели, где явно помечено всё, что не поместилось целиком.
 */

export const CHARACTER_ACTIONS = Object.freeze(['character.create', 'character.update', 'character.restore', 'character.avatar']);

const PREVIEW_CHARS = 320;
const FIELD_VIEW_CAP_CHARS = 12000;
const FIELD_LABELS = Object.freeze({
    name: 'Name', description: 'Description', personality: 'Personality', scenario: 'Scenario', first_mes: 'First message', mes_example: 'Example dialogues',
    creator_notes: 'Creator notes', system_prompt: 'System prompt', post_history_instructions: 'Post-history instructions', creator: 'Creator', character_version: 'Version', world: 'Lorebook',
});
const SHORT_VALUE_FIELDS = Object.freeze(['name', 'creator', 'character_version', 'world']);

const cutPreview = value => `${value.slice(0, PREVIEW_CHARS).replace(/\n{2,}/g, '\n')}${value.length > PREVIEW_CHARS ? '…' : ''}`;
const describeSize = value => `${value.length.toLocaleString('en-US')} chars, ~${Math.ceil(value.length / 4).toLocaleString('en-US')} tokens`;

function describeBookChange(book) {
    const added = (book.entries ?? []).filter(entry => entry.id === undefined).length;
    const changed = (book.entries ?? []).length - added;
    const removed = book.removeEntries?.length ?? 0;
    const meta = ['name', 'description', 'scan_depth', 'token_budget', 'recursive_scanning'].filter(key => book[key] !== undefined).map(key => `${key} ${book[key]}`);
    const summary = [added ? `${added} new entr${added === 1 ? 'y' : 'ies'}` : '', changed ? `${changed} changed` : '', removed ? `${removed} removed` : '', ...meta].filter(Boolean).join(', ') || 'no change';
    const entryLines = (book.entries ?? []).slice(0, 12).map(entry => `  • ${entry.name || entry.keys?.[0] || `#${entry.id}`}${entry.keys?.length ? ` [${entry.keys.slice(0, 4).join(', ')}]` : ''}${entry.constant ? ' (always on)' : ''}${entry.content ? ` — ${cutPreview(entry.content).slice(0, 120)}` : ''}`);
    return [`Card lorebook: ${summary}`, ...entryLines];
}

/** Строки карточки-предложения по нормализованным полям: длинные тексты — превью и размер, остальное как есть. */
export function describeCardFields(fields) {
    const lines = [];
    for (const key of Object.keys(TEXT_FIELD_LIMITS)) {
        const value = fields[key];
        if (value === undefined) continue;
        if (value === '') lines.push(`${FIELD_LABELS[key]}: (cleared)`);
        else if (SHORT_VALUE_FIELDS.includes(key)) lines.push(`${FIELD_LABELS[key]}: ${value}`);
        else lines.push(`${FIELD_LABELS[key]} (${describeSize(value)}):\n${cutPreview(value)}`);
    }
    if (fields.alternate_greetings) {
        lines.push(fields.alternate_greetings.length
            ? `Alternate greetings: ${fields.alternate_greetings.length}\n${fields.alternate_greetings.slice(0, 3).map(greeting => `  • ${cutPreview(greeting).slice(0, 140)}`).join('\n')}`
            : 'Alternate greetings: (cleared)');
    }
    if (fields.tags) lines.push(`Tags: ${fields.tags.join(', ') || '(cleared)'}`);
    if (fields.talkativeness !== undefined) lines.push(`Talkativeness (group chats): ${fields.talkativeness}`);
    if (fields.fav !== undefined) lines.push(fields.fav ? 'Marked as favourite' : 'Not a favourite');
    if (fields.depth_prompt) {
        const { depth, role, prompt } = fields.depth_prompt;
        lines.push(`Depth prompt: ${[depth !== undefined ? `depth ${depth}` : '', role ?? '', prompt !== undefined ? (prompt ? `“${cutPreview(prompt).slice(0, 200)}”` : '(cleared)') : ''].filter(Boolean).join(', ')}`);
    }
    if (fields.character_book) lines.push(...describeBookChange(fields.character_book));
    if (fields.extensions) lines.push(`Other extensions: ${Object.keys(fields.extensions).join(', ') || '(none)'}`);
    return lines;
}

/** Карточка-предложение: `{ ok, title, lines, danger }` либо `{ ok: false, error }`. */
export function describeCharacter(action, params = {}) {
    if (action === 'character.avatar') {
        if (!params.avatar) return { ok: false, error: 'Which character? Its avatar file is needed.' };
        if (params.undo === true) return { ok: true, title: `Put the previous picture of “${String(params.avatar).replace(/\.png$/i, '')}” back`, lines: ['The last replaced picture of this session returns.'] };
        if (!params.url) return { ok: false, error: 'Which picture? An image address is needed.' };
        return { ok: true, title: `New picture for “${String(params.avatar).replace(/\.png$/i, '')}”`, lines: [`From: ${params.url}`, `Kept part of the frame: ${params.focus || 'center'} (cropped to a 2:3 portrait)`] };
    }
    if (action === 'character.restore') {
        if (!params.avatar) return { ok: false, error: 'Which character? Its avatar file is needed.' };
        if (!params.key) return { ok: false, error: 'Which version? Its key from the list is needed.' };
        return { ok: true, danger: true, title: `Restore “${String(params.avatar).replace(/\.png$/i, '')}” to an earlier version`, lines: ['The card goes back to that version. The state right now is saved first, so this can be undone too.'] };
    }
    const isNewCard = action === 'character.create';
    const made = normalizeCardFields(params, { isNewCard });
    if (!made.ok) return made;
    const fields = made.value;
    const lines = describeCardFields(fields);
    if (isNewCard) return { ok: true, title: `New character “${fields.name}”`, lines: [...lines, 'Created with the default picture; you can change it in SillyTavern.'] };
    // `name` здесь — НОВОЕ имя; адресуется карточка только файлом аватара.
    const target = String(params.avatar ?? '').replace(/\.png$/i, '');
    if (!target) return { ok: false, error: 'Which character? Its avatar file is needed.' };
    return { ok: true, danger: Boolean(fields.character_book?.removeEntries?.length), title: `Change character “${target}”`, lines: [...lines, 'Only the fields above change; the rest of the card stays. The previous version is saved and can be restored.'] };
}

function buildFieldView(label, value) {
    if (!value) return `${label}: (empty)`;
    if (value.length <= FIELD_VIEW_CAP_CHARS) return `${label}${value.length > 1500 ? ` (${value.length} chars)` : ''}:\n${value}`;
    // Без явной пометки модель перепишет обрезанное поле целиком и сотрёт невидимый ей хвост.
    return `${label} (TRUNCATED — you see ${FIELD_VIEW_CAP_CHARS} of ${value.length} chars; do NOT replace this field as a whole, you would erase the rest):\n${value.slice(0, FIELD_VIEW_CAP_CHARS)}…`;
}

/** Карточка целиком для промпта гида: все правимые поля с текущими значениями и id записей книги. */
export function buildCharacterView({ avatar, fields }) {
    const lines = [`Character “${fields.name}” — file ${avatar}`];
    for (const key of ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions']) lines.push(buildFieldView(key, fields[key]));
    const greetingLines = fields.alternate_greetings.map((greeting, index) => `\n  [${index + 1}] ${greeting.slice(0, FIELD_VIEW_CAP_CHARS)}`).join('');
    lines.push(`alternate_greetings: ${fields.alternate_greetings.length || '(none)'}${greetingLines}`);
    lines.push(`tags: ${fields.tags.join(', ') || '(none)'} | creator: ${fields.creator || '(empty)'} | character_version: ${fields.character_version || '(empty)'} | talkativeness: ${fields.talkativeness} | fav: ${fields.fav} | world: ${fields.world || '(none)'}`);
    lines.push(`depth_prompt: depth ${fields.depth_prompt.depth}, role ${fields.depth_prompt.role}, ${fields.depth_prompt.prompt ? `text:\n${fields.depth_prompt.prompt}` : 'empty'}`);
    const entries = fields.character_book?.entries ?? [];
    lines.push(entries.length
        ? `character_book “${fields.character_book.name ?? ''}” — ${entries.length} entries (id, name, keys, always-on, text):\n${entries.map(entry => `  #${entry.id} “${entry.name ?? entry.comment ?? ''}” [${(entry.keys ?? []).join(', ')}]${entry.constant ? ' always-on' : ''}${entry.enabled === false ? ' DISABLED' : ''}: ${String(entry.content ?? '').slice(0, 1500)}`).join('\n')}`
        : 'character_book: (none)');
    const otherExtensions = Object.keys(fields.extensions ?? {});
    if (otherExtensions.length) lines.push(`other extensions (leave alone unless asked): ${otherExtensions.join(', ')}`);
    return lines.join('\n');
}
