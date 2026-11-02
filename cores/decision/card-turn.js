import { createDecisionCycle } from './cycle.js';
import { buildWriterContext } from '../../libraries/core/decision-context.js';

/**
 * Один изолированный ход «директор → прозаик» для проверки карточки.
 *
 * Тест карточки раньше собирал запрос через Prompt Manager
 * (`promptManager.assembleForCard`). PM удалён, поэтому тестовый ход идёт тем
 * же путём, что игра: директор получает карточку как заметки о персонаже и
 * тестовую историю, заполняет форму, а прозаик получает Push и пишет ответ.
 *
 * Состояние теста — своё, в памяти: ни лог, ни блоки, ни банк, ни часы
 * настоящего чата не трогаются. Инструменты ограничены чтением состояния и
 * формой; всё, что пишет в чужие Ядра (`forced_memory`) или ходит в сеть,
 * отсюда недоступно.
 */

export const CARD_TEST_TOOLS = Object.freeze([
    'update_roster', 'assess', 'submit_turn', 'await', 'set_plan',
    'character_note', 'current_state',
]);

const MAX_CARD_NOTES = 4;

/** Карточка → заметки о персонаже: то, что прозаик получает в игре вместо блоков. */
export function cardNotes(card = {}) {
    const name = String(card.name ?? 'Character').trim() || 'Character';
    const fields = [
        ['Description', card.description],
        ['Personality', card.personality],
        ['Scenario', card.scenario],
        ['Example dialogue', card.mes_example],
    ].filter(([, value]) => String(value ?? '').trim());
    const list = fields.slice(0, MAX_CARD_NOTES).map(([title, value], index) => ({
        id: `card_${index}`, character: name, title, text: String(value).trim(), updatedAt: 0,
    }));
    return list.length ? { [name.toLowerCase()]: list } : {};
}

function createVolatileStore({ notes, roster }) {
    let state = {
        blocks: [], runs: {}, cycles: [], archive: [], roster: { active: [...roster] },
        plan: { direction: 'Play the test turn for the character in the card.', stages: [], currentStage: 0, updatedAt: 0 },
        arcs: [], notes, library: {}, plans: [], clock: { minutes: 0, updatedAt: 0 },
        bank: {}, research: [], names: [], draft: null,
    };
    const setter = key => async value => { state = { ...state, [key]: value }; };
    return {
        blocks: () => state.blocks,
        runs: () => state.runs,
        cycles: () => state.cycles,
        archive: () => state.archive,
        roster: () => ({ active: [...state.roster.active] }),
        plan: () => state.plan,
        arcs: () => state.arcs,
        notes: () => state.notes,
        library: () => state.library,
        plans: () => state.plans,
        clock: () => ({ ...state.clock }),
        bank: () => state.bank,
        research: () => state.research,
        names: () => [...state.names],
        draft: () => state.draft,
        appendCycle: async cycle => { state.cycles = [...state.cycles, cycle]; },
        saveRoster: async next => { state.roster = { active: [...(next?.active ?? [])] }; },
        savePlan: setter('plan'),
        saveArcs: setter('arcs'),
        saveNotes: setter('notes'),
        saveLibrary: setter('library'),
        savePlans: setter('plans'),
        saveClock: setter('clock'),
        saveBank: setter('bank'),
        saveResearch: setter('research'),
        addResearch: async task => { state.research = [...state.research, task]; },
        updateResearch: async (id, patch) => { state.research = state.research.map(task => (task.id === id ? { ...task, ...patch } : task)); },
        saveNames: setter('names'),
        addName: async key => { if (!state.names.includes(key)) state.names = [...state.names, key]; },
        saveBlocks: setter('blocks'),
        saveDraft: setter('draft'),
        saveLog: setter('cycles'),
        logTokens: () => 0,
        snapshot: () => null,
        deleteSnapshot: async () => false,
        persist: async () => null,
        lastRun: () => null,
        reload: async () => ({}),
    };
}

export function createCardTurn({ call, getSettings, getWorkers, now = () => Date.now() }) {
    let counter = 0;
    return async function cardTurn({ chat = [], card = {} } = {}) {
        const notes = cardNotes(card);
        const name = String(card.name ?? '').trim();
        const store = createVolatileStore({ notes, roster: name ? [name] : [] });
        const cycle = createDecisionCycle({
            call,
            callTool: async () => ({ ok: false, error: 'External tools are not available in the card test.' }),
            getSettings,
            getWorkers,
            store,
            researcher: null,
            publishEvent: () => {},
            usage: () => null,
            now,
        });
        const result = await cycle.run({ chat, runId: `cardtest_${(counter += 1)}`, type: 'normal', toolFilter: CARD_TEST_TOOLS });
        if (!result.ok) throw new Error(`The director did not finish the test turn: ${result.reason ?? 'no form'}.`);
        const writer = buildWriterContext({ blocks: [], notes, summaries: [], chat, decision: result.push });
        return { messages: writer.messages, push: result.push };
    };
}
