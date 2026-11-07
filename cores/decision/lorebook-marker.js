import { runDecisionCycle, normalizeGenerateAnswer } from '../../libraries/core/decision-agent.js';
import { LOREBOOK_MARKER, fillPrompt } from '../../libraries/core/decision-prompts.js';
import { MARK_LOREBOOK_CHARACTERS_TOOL, AWAIT_TOOL } from '../../libraries/core/decision-tool-schemas-world.js';
import { lorebookSections, planLorebookMarking } from '../../libraries/core/decision-banks.js';

/**
 * Разметка книг: директор одним вызовом на книгу решает, какие записи —
 * персонажи. Размечаются только новые и изменённые записи (план по записям),
 * отметки неизменённых сохраняются. Ошибка книги не ломает остальные: она
 * уходит предупреждением, а книга читается разделами.
 */
const text = value => String(value ?? '').trim();
// Ответ — вызов с записью на каждого персонажа (имя, алиасы, важность): на большой книге это тысячи токенов, а
// ризонинг воркера директора тратит тот же лимит. С 1600 вызов обрезался, и разметка молча уходила в запасной путь.

function entryKeys(entry) {
    return [entry?.key, entry?.keys].flatMap(value => (Array.isArray(value) ? value : String(value ?? '').split(','))).map(text).filter(Boolean);
}

function chooseWorker({ getSettings, getWorkers }) {
    const id = text(getSettings()?.decider?.workerId);
    if (!id) throw new Error('No director worker is configured for lorebook marking.');
    const worker = getWorkers().find(item => item.id === id);
    if (!worker) throw new Error(`The director worker "${id}" is not available.`);
    if (worker.format !== 'openai') throw new Error(`Lorebook marking needs an "openai" worker; "${id}" is "${worker.format}".`);
    return worker;
}

export function createLorebookMarker({ call, getSettings, getWorkers, publishEvent }) {
    /** `entries` — записи для разметки (новые и изменённые); `sectionsFrom` — вся книга, чтобы разделы были видны целиком. */
    async function mark({ book, entries, cardHint = '', sectionsFrom = null }) {
        const worker = chooseWorker({ getSettings, getWorkers });
        const list = Array.isArray(entries) ? entries : [];
        const byUid = new Map(list.map(entry => [Number(entry.uid), entry]));
        const lines = [...list].sort((a, b) => (Number(a?.uid) || 0) - (Number(b?.uid) || 0))
            .map(entry => `${entry.uid} | ${text(entry.comment) || '(untitled)'} | ${entryKeys(entry).join(', ') || '—'} | ${text(entry.content).slice(0, 200).replace(/\s+/g, ' ')}`)
            .join('\n');
        const prompt = fillPrompt(LOREBOOK_MARKER, {
            book: text(book) || 'Lorebook',
            card_hint: text(cardHint),
            sections: lorebookSections(Array.isArray(sectionsFrom) ? sectionsFrom : list).join(', ') || 'none',
            entries: lines,
        });
        const marks = [];
        const ignored = [];
        let called = false;
        const outcome = await runDecisionCycle({
            messages: [{ role: 'system', content: prompt }],
            tools: [MARK_LOREBOOK_CHARACTERS_TOOL, AWAIT_TOOL],
            generate: async ({ messages, tools, toolChoice, returnMessage }) => normalizeGenerateAnswer(await call('model.generate', {
                workerId: worker.id, messages, tools, toolChoice, stream: false, returnMessage, maxTokens: 8000, temperature: 0,
            })),
            handlers: {
                mark_lorebook_characters: args => {
                    called = true;
                    const seen = new Set();
                    for (const item of Array.isArray(args?.characters) ? args.characters : []) {
                        const uid = Number(item?.uid);
                        const name = text(item?.name);
                        const entry = byUid.get(uid);
                        if (!entry || seen.has(uid)) { ignored.push({ uid, reason: !entry ? 'there is no such entry' : 'listed twice' }); continue; }
                        if (!name) { ignored.push({ uid, reason: 'the name is empty' }); continue; }
                        const aliases = (Array.isArray(item.aliases) ? item.aliases : String(item.aliases ?? '').split(','))
                            .map(text).filter(Boolean);
                        seen.add(uid);
                        marks.push({ uid, name, aliases, franchise: text(item.franchise) });
                    }
                    return { ok: true, marked: marks.length, ignored };
                },
                await: () => ({ ok: true }),
            },
            // Отклонённый вызов (нет комментария, плохая форма) модель может исправить; удачная разметка завершает цикл.
            maxSteps: 3,
            stopAfter: ['mark_lorebook_characters'],
            implicitAwait: true,
        });
        if (!called) {
            // Причина видна в окне директора: последняя ошибка вызова или чем кончился цикл.
            const lastError = [...(outcome?.trace ?? [])].reverse().find(step => step?.error)?.error;
            const why = lastError || outcome?.reason || (outcome?.warnings ?? []).join('; ');
            throw new Error(`The director did not mark the lorebook characters${why ? `: ${why}` : ''}.`);
        }
        publishEvent('decision.lorebook.marked', { book, entries: list.length, marked: marks.length, ignored: ignored.length });
        return { marks, ignored };
    }

    /**
     * Все книги чата: разметка по плану записей, сохранение отметок и
     * предупреждения. Возвращает текущие отметки для сбора источников.
     */
    async function markBooks({ entries, cards, marks, saveMarks, now = () => Date.now() }) {
        const warnings = [];
        const byBook = new Map();
        for (const entry of Array.isArray(entries) ? entries : []) {
            const book = text(entry?.book) || 'Lorebook';
            if (!byBook.has(book)) byBook.set(book, []);
            byBook.get(book).push(entry);
        }
        const cardHint = (Array.isArray(cards) ? cards : []).map(card => [card.name, ...(card.tags ?? [])].filter(Boolean).join(' — ')).filter(Boolean).join('; ');
        for (const [book, list] of byBook) {
            const plan = planLorebookMarking(marks[book], list);
            const record = items => ({ sourceHash: plan.sourceHash, entryHashes: plan.entryHashes, marks: items, at: now() });
            if (!plan.toMark.length) {
                // Ничего нового: удалённые записи просто теряют отметки, запрос не нужен.
                if (marks[book]?.sourceHash !== plan.sourceHash || !marks[book]?.entryHashes) await saveMarks({ ...marks, [book]: record(plan.kept) });
                continue;
            }
            try {
                const result = await mark({ book, entries: plan.toMark, sectionsFrom: list, cardHint });
                await saveMarks({ ...marks, [book]: record([...plan.kept, ...result.marks]) });
            } catch (error) {
                const message = `Lorebook "${book}" was not marked (${error?.message ?? error}); using sections.`;
                warnings.push(message);
                publishEvent('decision.bank.warning', { book, message });
            }
        }
        return warnings;
    }

    return { mark, markBooks };
}
