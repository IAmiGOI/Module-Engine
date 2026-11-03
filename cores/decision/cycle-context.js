import { buildDeciderContext } from '../../libraries/core/decision-context.js';
import { normalizeGenerateAnswer } from '../../libraries/core/decision-agent.js';
import { buildToolList } from '../../libraries/core/decision-tools.js';
import { staticDirectorLorebook } from '../../libraries/core/decision-lorebook-static.js';
import { deciderRequestParams, DECISION_MEMORY_NAMESPACE } from '../../libraries/core/decision-settings.js';
import { fullTurns } from '../../libraries/core/decision-turn-digest.js';
import { librarySection } from '../../libraries/core/decision-library.js';
import { bankIndex } from '../../libraries/core/decision-bank.js';
import { researchSection } from '../../libraries/core/decision-researcher.js';
import { assembleSectionFor } from './prompt-sections.js';
import { createKnowledge } from './knowledge.js';

/** Чужие инструменты, которые директору не отдаются: Secrets директор не использует (решение владельца — отключить). */
const DIRECTOR_EXCLUDED_TOOLS = new Set(['Secrets']);

/** Контекст и запрос директора — вынесено из цикла, чтобы файл цикла оставался циклом. */

export function fallbackDecision(form) {
    const lines = (Array.isArray(form?.characters) ? form.characters : [])
        .filter(character => String(character?.action ?? '').trim())
        .map(character => `${character.name}: ${character.action}`);
    return [String(form?.resolution ?? '').trim(), ...lines].filter(Boolean).join('\n') || 'The turn is decided.';
}

export function wakeFor({ type, label, detail, ...rest }) {
    return { type, label, ...(detail ? { detail } : {}), ...rest };
}

export function turnWake(type) {
    if (type === 'normal') return wakeFor({ type: 'turn', label: 'A new turn has started' });
    return wakeFor({ type, label: `The director runs again (${type})` });
}

export function createCycleContext({ call, store, banks = null }) {
    const knowledge = createKnowledge({ call, store, banks });
    async function externalTools() {
        try {
            const tools = await call('generation.tools');
            return Array.isArray(tools) ? tools.filter(tool => !DIRECTOR_EXCLUDED_TOOLS.has(String(tool?.name ?? ''))) : [];
        } catch { return []; }
    }

    async function summaries() {
        try { return (await call('summary.list')) ?? []; } catch { return []; }
    }

    /** Пользовательский блок директора — тот же, что раньше брался из `prompts.director`, но собранный из раздела. */
    async function directorBlockFor(settings, chat, worker) {
        const block = await assembleSectionFor({ sectionId: 'director', settings, chat, call, model: worker.model });
        return block.messages;
    }

    /** Лорбук — только директору: стабильный текст книги. Ошибка чтения не ломает ход. */
    /**
     * Лорбук — только директору и статичный: начало контекста — снимок книги, который не меняется от хода к ходу,
     * а новые и изменённые записи (их дописывает граф памяти) — отдельным блоком в изменяемой части. Ошибка чтения не
     * ломает ход.
     */
    const LOREBOOK_SNAPSHOT_KEY = 'lorebookSnapshot';
    async function lorebookTextFor(enabled) {
        if (!enabled) return { head: '', changes: '' };
        try {
            const books = await call('lorebook.books');
            if (!Array.isArray(books) || !books.length) return { head: '', changes: '' };
            const saved = await call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: LOREBOOK_SNAPSHOT_KEY, fallback: null });
            const result = staticDirectorLorebook(saved, (await call('lorebook.entries')) ?? [], { marks: banks?.marksForLorebook() ?? null });
            if (result.refreshed) await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: LOREBOOK_SNAPSHOT_KEY, value: result.snapshot });
            return { head: result.head, changes: result.changes };
        } catch { return { head: '', changes: '' }; }
    }

    function buildContext({ chat = [], settings, summaries: list, task = '', lorebookText = '', lorebookChanges = '', knowledgeText = '', directorBlock = [], banksText = '' }) {
        return buildDeciderContext({
            summaries: list, chat, plan: store.plan(), arcs: store.arcs(), notes: store.notes(),
            libraryText: librarySection(store.library(), store.plans(), store.clock().minutes),
            bankText: bankIndex(store.bank()), researchText: researchSection(store.research()),
            roster: store.roster().active, planMissing: !store.plan(), directorBlock, lorebookText, lorebookChanges, knowledgeText, banksText, task,
            digests: typeof store.digests === 'function' ? store.digests() : [],
            turns: fullTurns(store.cycles()),
        });
    }

    async function runContext({ settings, chat = [], task = '', lorebook = true, worker }) {
        const [list, lorebookParts, directorBlock, knowledgeText] = await Promise.all([
            summaries(), lorebookTextFor(lorebook), directorBlockFor(settings, chat ?? [], worker), knowledge.textFor(null),
        ]);
        const bankText = banks ? banks.contextFor({ names: store.roster().active, all: true }).text : '';
        return buildContext({ chat, settings, task, summaries: list, lorebookText: lorebookParts.head, lorebookChanges: lorebookParts.changes, knowledgeText, directorBlock, banksText: bankText });
    }

    function generateFor({ settings, worker, runId, prefix, startedAt, effort = null, signal = null }) {
        let modelCall = 0;
        return async ({ messages, tools, toolChoice, returnMessage }) => {
            modelCall += 1;
            const answer = await call('model.generate', {
                requestId: `${runId}:${prefix}${modelCall}:${startedAt}`,
                ...deciderRequestParams(settings.decider),
                ...(effort ? { reasoningEffort: effort } : {}),
                workerId: worker.id,
                messages, tools, toolChoice, stream: true, returnMessage,
                ...(signal ? { signal } : {}),
            });
            return normalizeGenerateAnswer(answer);
        };
    }

    async function toolsFor(settings, { background = false, filter = null } = {}) {
        return buildToolList(await externalTools()).filter(tool => {
            if (filter && !filter.includes(tool.name)) return false;
            if (background && tool.name === 'submit_turn') return false;
            if (!settings.turnDraft && tool.name === 'save_draft') return false;
            return true;
        });
    }

    return { summaries, buildContext, runContext, generateFor, toolsFor };
}
