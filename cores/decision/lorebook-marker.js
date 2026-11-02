import { runDecisionCycle, normalizeGenerateAnswer } from '../../libraries/core/decision-agent.js';
import { LOREBOOK_MARKER, fillPrompt } from '../../libraries/core/decision-prompts.js';
import { MARK_LOREBOOK_CHARACTERS_TOOL, AWAIT_TOOL } from '../../libraries/core/decision-tool-schemas-world.js';
import { lorebookSections } from '../../libraries/core/decision-banks.js';

/**
 * Разметка одной книги: директор одним вызовом решает, какие записи —
 * персонажи, и возвращает uid, чистое имя, алиасы, важность и франшизу.
 * Ошибка/пустой ответ — сигнал вызывающему перейти на запасной путь.
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
        await runDecisionCycle({
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
                        const importance = item?.importance === 'key' ? 'key' : 'minor';
                        const aliases = (Array.isArray(item.aliases) ? item.aliases : String(item.aliases ?? '').split(','))
                            .map(text).filter(Boolean);
                        seen.add(uid);
                        marks.push({ uid, name, aliases, importance, franchise: text(item.franchise) });
                    }
                    return { ok: true, marked: marks.length, ignored };
                },
                await: () => ({ ok: true }),
            },
            maxSteps: 1,
            implicitAwait: true,
        });
        if (!called) throw new Error('The director did not mark the lorebook characters.');
        publishEvent('decision.lorebook.marked', { book, entries: list.length, marked: marks.length, ignored: ignored.length });
        return { marks, ignored };
    }

    return { mark };
}
