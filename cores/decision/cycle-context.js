import { buildDeciderContext } from '../../libraries/core/decision-context.js';
import { normalizeGenerateAnswer } from '../../libraries/core/decision-agent.js';
import { buildToolList } from '../../libraries/core/decision-tools.js';
import { buildLorebookContext } from '../../libraries/core/decision-lorebook.js';
import { thinkingMessages } from '../../libraries/core/decision-log.js';
import { deciderRequestParams } from '../../libraries/core/decision-settings.js';
import { librarySection } from '../../libraries/core/decision-library.js';
import { bankIndex } from '../../libraries/core/decision-bank.js';
import { researchSection } from '../../libraries/core/decision-researcher.js';
import { assembleSectionFor } from './prompt-sections.js';

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
    async function externalTools() {
        try {
            const tools = await call('generation.tools');
            return Array.isArray(tools) ? tools : [];
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
    async function lorebookTextFor(enabled) {
        if (!enabled) return '';
        try {
            const books = await call('lorebook.books');
            if (!Array.isArray(books) || !books.length) return '';
            return buildLorebookContext((await call('lorebook.entries')) ?? []).text;
        } catch { return ''; }
    }

    function buildContext({ chat = [], settings, summaries: list, task = '', lorebookText = '', directorBlock = [], banksText = '' }) {
        return buildDeciderContext({
            summaries: list, chat, runs: store.runs(),
            thoughtMessages: thinkingMessages(store.cycles()), plan: store.plan(), arcs: store.arcs(), notes: store.notes(),
            libraryText: [librarySection(store.library(), store.plans(), store.clock().minutes), bankIndex(store.bank()), researchSection(store.research())].filter(Boolean).join('\n\n'),
            roster: store.roster().active, planMissing: !store.plan(), directorBlock, lorebookText, banksText, task,
        });
    }

    async function runContext({ settings, chat = [], task = '', lorebook = true, worker }) {
        const [list, lorebookText, directorBlock] = await Promise.all([
            summaries(), lorebookTextFor(lorebook), directorBlockFor(settings, chat ?? [], worker),
        ]);
        const bankText = banks ? banks.contextFor({ names: store.roster().active, all: true }).text : '';
        return buildContext({ chat, settings, task, summaries: list, lorebookText, directorBlock, banksText: bankText });
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
