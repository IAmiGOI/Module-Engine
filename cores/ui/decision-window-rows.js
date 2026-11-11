import { h } from './tree.js';
import { computed } from './reactive.js';
import { writerCheckNode, formCheckNode } from './decision-check-nodes.js';
import { toolLabel, toolFields, entrySummary } from '../../libraries/core/court-lanes.js';
import { fileCallNode, writingNode, isFileCall } from './court-file-calls.js';
import { previewNode } from './court-files-editor.js';

/**
 * Строки ленты окна директора — вынесено из `decision-window.js`, чтобы файл
 * держался в пределах 300 строк. Каждый вид строки строится здесь один раз.
 */

const DEFAULT_SIZE = { width: 760, height: 660 };
const PAGE = 30;
export const text = value => String(value ?? '').trim();
export const safeJson = value => { try { return JSON.stringify(value ?? null, null, 2); } catch { return String(value ?? ''); } };
export const firstLine = value => text(value).split('\n')[0].slice(0, 160);
export function clockLabel(minutes) {
    if (!Number.isFinite(Number(minutes))) return '';
    const total = Math.max(0, Math.round(Number(minutes)));
    return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
function cycleMeta(entry) {
    const parts = [];
    if (clockLabel(entry.clockMinutes)) parts.push(`RP ${clockLabel(entry.clockMinutes)}`);
    if (Number.isFinite(entry.turn) && entry.turn !== null) parts.push(`turn ${entry.turn}`);
    if (entry.at) parts.push(new Date(Number(entry.at)).toLocaleTimeString());
    if (entry.running) parts.push('live');
    if (entry.rejected) parts.push('rejected');
    return parts.join(' · ');
}

function usageLine(row) {
    const tokens = row.total || row.prompt + row.completion;
    const seconds = row.durationMs ? ` · ${(row.durationMs / 1000).toFixed(1)} s` : '';
    return `${tokens} tokens (${row.prompt} in / ${row.completion} out, ${row.cached} cached)${seconds}`;
}

function keyed(node, key) {
    if (node && typeof node === 'object') node.props = { ...node.props, key };
    return node;
}

function fieldsNode(pairs) {
    if (!pairs.length) return null;
    return h('dl', { class: 'stme-dw-fields' }, ...pairs.flatMap(([label, value]) => [h('dt', {}, label), h('dd', {}, String(value))]));
}

function callNode(row, ctx = {}) {
    // Файлы — как в редакторе: дифф, превью, путь кнопкой; поля «old → new» для них не нужны.
    const fileView = isFileCall(row.name) ? fileCallNode(row, ctx) : null;
    const fields = fileView ? [] : toolFields(row.name, row.args);
    return h('div', { class: `stme-dw-call${row.error ? ' stme-dw-error' : ''}` },
        h('div', { class: 'stme-dw-call-head' },
            h('span', { class: 'stme-dw-call-title' }, toolLabel(row.name, row.args)),
            h('span', { class: 'stme-dw-call-detail' }, row.pending ? 'running…' : (row.error ? 'rejected' : (row.durationMs ? `${(row.durationMs / 1000).toFixed(1)} s` : '')))),
        row.comment ? h('div', { class: 'stme-dw-comment' }, row.comment) : null,
        row.name === 'ask_user' && row.args?.question
            ? h('div', { class: 'stme-dw-ask' }, h('b', {}, String(row.args.question)),
                Array.isArray(row.args.options) && row.args.options.length ? h('div', { class: 'stme-dw-ask-options' }, row.args.options.map(String).join(' · ')) : null)
            : null,
        // Ответ пользователю и Молитва — Markdown, как их пишет Советник: списки, номера, жирный.
        fileView ?? ((row.name === 'reply' || row.name === 'prayer') && row.args?.text ? h('div', { class: 'stme-dw-md' }, previewNode(String(row.args.text))) : fieldsNode(fields)),
        row.error ? h('div', { class: 'stme-dw-error-text' }, row.error) : null,
        row.pending ? null : h('details', { class: 'stme-dw-fold stme-dw-raw' },
            h('summary', {}, 'Raw'),
            h('pre', {}, `${row.name}\n${safeJson(row.args)}${row.error ? '' : `\n\n→ ${safeJson(row.result)}`}`)));
}
function assessNode(row) {
    const odds = Number.isFinite(row.probability) ? `${Math.round(row.probability * 100)}%` : '—';
    const roll = Number.isFinite(row.roll) ? `roll ${row.roll}` : '';
    return h('div', { class: `stme-dw-assess${row.error ? ' stme-dw-error' : ''}` },
        h('div', { class: 'stme-dw-assess-line' },
            h('strong', {}, row.character || 'someone'), ` · ${row.action || '—'}`,
            h('span', { class: 'stme-dw-assess-odds' }, ` ${odds}${roll ? ` · ${roll}` : ''}${row.degree ? ` · ${row.degree}` : ''}${row.words ? ` — ${row.words}` : ''}`)),
        h('small', { class: 'stme-dw-muted' }, `${row.effective && row.effective !== row.difficulty ? `${row.difficulty || '—'} → ${row.effective}` : (row.difficulty || '—')} / ${row.experience || '—'}${row.comment ? ` · ${row.comment}` : ''}`));
}
function formNode(row) {
    return h('div', { class: 'stme-dw-form' },
        h('div', { class: 'stme-dw-block-title' }, 'The form'),
        h('table', { class: 'stme-dw-table' },
            h('thead', {}, h('tr', {}, ['Character', 'Decision', 'Action', 'Outcome'].map(title => h('th', {}, title)))),
            h('tbody', {}, ...row.characters.map(character => h('tr', {},
                h('td', {}, character.name), h('td', {}, character.decision),
                h('td', {}, character.action), h('td', {}, character.outcome))))),
        h('div', { class: 'stme-dw-scene' },
            [row.place ? `place: ${row.place}` : '', row.timeBefore || row.timeAfter ? `time: ${row.timeBefore || '?'} → ${row.timeAfter || '?'}` : '',
                Number.isFinite(Number(row.minutes)) ? `${row.minutes} min` : ''].filter(Boolean).join(' · ')),
        h('div', {}, h('strong', {}, 'Resolution: '), row.resolution),
        h('div', {}, h('strong', {}, "User's result: "), row.userResult));
}
export function rowNode(row, ctx = {}) {
    if (row.kind === 'writing') return writingNode(row, ctx);
    if (row.kind === 'thinking') return h('details', { class: 'stme-dw-thinking' }, h('summary', {}, `Thinking — ${row.text.split(/\s+/).length} words`), h('div', { class: 'stme-dw-thinking-text' }, row.text));
    if (row.kind === 'writer_check') return writerCheckNode(row);
    if (row.kind === 'form_check') return formCheckNode(row);
    if (row.kind === 'assess') return assessNode(row);
    if (row.kind === 'call') return callNode(row, ctx);
    if (row.kind === 'form') return formNode(row);
    if (row.kind === 'ledger') return h('details', { class: 'stme-dw-ledger' }, h('summary', {}, 'Ledger — what each character wanted and how it ended'), h('pre', {}, row.text));
    if (row.kind === 'petition') return h('details', { class: 'stme-dw-petition' },
        h('summary', {}, `Petition (${row.status || 'queued'}) — ${row.character || 'someone'}${row.promote ? ` · promote → ${row.promote.level}` : ''}`),
        h('div', {}, row.problem),
        row.promote ? h('div', { class: 'stme-dw-muted' }, `Promote to ${row.promote.level}: ${row.promote.reason}`) : null,
        row.excerpt ? h('pre', {}, row.excerpt) : null);
    if (row.kind === 'nothing') return h('div', { class: 'stme-dw-nothing' }, h('strong', {}, 'Nothing yet: '), row.reason || '(no reason given)');
    if (row.kind === 'counsellor_reply') return h('div', { class: 'stme-dw-answer stme-dw-md' }, h('strong', {}, 'Counsellor:'), previewNode(row.text));
    if (row.kind === 'queues') return h('details', { class: 'stme-dw-queues' },
        h('summary', {}, `Queues — ${row.petitions.length} petition(s), ${row.prayers.length} prayer(s)`),
        row.petitions.length ? h('pre', {}, row.petitions.map(item => `- ${item.character} (${item.status})${item.day ? ' [prepare the new day]' : ''}`).join('\n')) : null,
        row.prayers.length ? h('pre', {}, row.prayers.map(item => `- (${item.status}) ${item.text}`).join('\n')) : null);
    if (row.kind === 'creation') return h('details', { class: 'stme-dw-creation' },
        h('summary', {}, `Creation — ${row.titles.length ? row.titles.join(', ') : 'section'}${row.complete ? ' · complete' : ''}`),
        row.titles.length ? h('pre', {}, row.titles.map(title => `- ${title}`).join('\n')) : null,
        row.missing?.length ? h('div', { class: 'stme-dw-muted' }, `Still missing: ${row.missing.join('; ')}`) : null);
    if (row.kind === 'scale') return h('details', { class: 'stme-dw-scale' },
        h('summary', {}, `Scales — ${row.system}${row.replaced ? ' (rewritten)' : ''} · ${row.rules.length} rule(s)`),
        row.principle ? h('div', {}, h('strong', {}, 'Principle: '), row.principle) : null,
        row.payment ? h('div', { class: 'stme-dw-muted' }, `Payment: ${row.payment}`) : null,
        row.rules.length ? h('pre', {}, row.rules.map(name => `- ${name}`).join('\n')) : null);
    if (row.kind === 'discovery') return h('div', { class: 'stme-dw-discovery' }, h('strong', {}, `Discovery — ${row.system || 'the world'}${row.rule ? ` / ${row.rule}` : ''}: `), row.text);
    if (row.kind === 'god_questions') return h('details', { class: 'stme-dw-god-questions' },
        h('summary', {}, `God asks ${row.questions.length} question(s)${row.kept ? ` (${row.kept} held back)` : ''}`),
        h('pre', {}, row.questions.map((item, index) => `${index + 1}. ${item.question}${item.why ? ` — ${item.why}` : ''}`).join('\n')));
    if (row.kind === 'god_answer') return h('div', { class: 'stme-dw-answer' }, h('strong', {}, 'Counsellor answers God: '), row.answer, row.closed ? ' · all questions closed' : '');
    if (row.kind === 'prayer') return h('div', { class: 'stme-dw-prayer' }, h('strong', {}, `Prayer${row.status ? ` (${row.status})` : ''}: `), row.text);
    if (row.kind === 'telegram') return h('div', { class: 'stme-dw-telegram' }, h('strong', {}, `Telegram${row.blocked ? ' (the next turn waits for a Decree)' : ''}: `), row.text);
    if (row.kind === 'push') return h('details', { class: 'stme-dw-push' }, h('summary', {}, 'Inscription — what the writer received'), h('pre', {}, row.text));
    if (row.kind === 'report') return h('details', { class: 'stme-dw-report' }, h('summary', {}, `Researcher: ${firstLine(row.task) || 'report'}`), h('pre', {}, row.text));
    if (row.kind === 'warning') return h('div', { class: 'stme-dw-warning' }, `⚠ ${row.text}`);
    if (row.kind === 'usage') return h('div', { class: 'stme-dw-usage' }, usageLine(row));
    if (row.kind === 'message') return h('div', { class: 'stme-dw-message' }, h('strong', {}, 'You: '), row.text);
    if (row.kind === 'settings') return h('div', { class: 'stme-dw-settings' }, h('strong', {}, 'Game settings: '), row.text);
    if (row.kind === 'answer') return h('div', { class: 'stme-dw-answer' }, row.text);
    return null;
}
export function cycleNode(entry, now, { open = false, openFile = null } = {}) {
    const classes = ['stme-dw-cycle', entry.running ? 'stme-dw-live' : '', entry.rejected ? 'stme-dw-rejected' : ''].filter(Boolean).join(' ');
    // Таймер — свой маленький computed: раз в секунду меняется только эта строка, а не вся лента.
    const waiting = entry.waiting && entry.waitingSince
        ? computed(() => `thinking… ${Math.max(0, Math.round(((typeof now === 'function' ? now() : now) - entry.waitingSince) / 1000))} s`)
        : '';
    const summary = entrySummary(entry);
    // Карточка: заголовок и резюме видны всегда, подробности — по раскрытию (живая и последняя раскрыты).
    // Ключи карточки и строк: живая карточка обновляется на месте, а не строится заново на каждое событие.
    return h('details', { class: classes, key: String(entry.id ?? entry.runId ?? ''), ...(open || entry.running ? { open: true } : {}) },
        h('summary', { class: 'stme-dw-head' },
            h('span', { class: 'stme-dw-head-line' }, h('strong', {}, entry.title), h('span', { class: 'stme-dw-meta' }, cycleMeta(entry))),
            summary ? h('span', { class: 'stme-dw-summary' }, summary) : null),
        entry.detail ? h('div', { class: 'stme-dw-detail' }, entry.detail) : null,
        ...entry.rows.map((row, index) => keyed(rowNode(row, { openFile }), `${row.kind}_${row.id ?? index}`)),
        // Таймер — внизу, там, где роль сейчас работает.
        waiting ? h('div', { class: 'stme-dw-waiting' }, waiting) : null);
}
