import { COMMENT } from './decision-tool-comment.js';

/**
 * `decree` — мега-инструмент Director (часть 19). Несколько Указов одним
 * вызовом; тем же вызовом применяются повышения из Petition и решения по
 * предложениям резолвера. Схема — только данные, исполнение в
 * `cores/decision/handlers-decree.js`.
 */

export const DECREE_TOOL = Object.freeze({
    name: 'decree',
    displayName: 'Issue a Decree',
    description: 'Issue or renew the Decree of one or several characters in one call. A Decree is how a character is played until the next one: what matters most for understanding them, how they see themselves, their long goal and their goal for today, their mood for the day, and their rules of resolving right now. The engine writes it into the Great Bank with the turn\'s RP time and keeps the old one in history. In the same call: "importance" applies promotions from Petitions, and "pending" accepts or rejects the resolver\'s spiritual proposals. Change the spiritual part of a bank with bank_edit. Write abstractly: no explicit scenes.',
    parameters: {
        type: 'object',
        properties: {
            decrees: {
                type: 'array',
                description: 'One entry per character whose Decree this call issues.',
                items: {
                    type: 'object',
                    properties: {
                        character: { type: 'string', description: 'The name exactly as the bank writes it.' },
                        valuesAndFacts: { type: 'string', description: 'The values and facts that matter most for understanding them. Short lines, one per fact.' },
                        selfView: { type: 'string', description: 'How they see themselves — not necessarily how others see them.' },
                        goals: {
                            type: 'object',
                            description: 'The long goal and the goal for today.',
                            properties: {
                                long: { type: 'string', description: 'The goal for days and weeks.' },
                                today: { type: 'string', description: 'The goal for this day.' },
                            },
                            required: ['long', 'today'],
                        },
                        mood: { type: 'string', description: 'The mood for the day by three axes: calm ↔ agitated, warm ↔ cold, lively ↔ tired. Each is "slightly", "strongly" or "neutral"; name which pole it leans to. Example: "calm ↔ agitated: slightly toward agitated; warm ↔ cold: neutral; lively ↔ tired: strongly toward tired".' },
                        resolving: { type: 'string', description: 'How they choose in concrete situations of this character — not general formulas. Short lines, one per situation.' },
                    },
                    required: ['character', 'valuesAndFacts', 'selfView', 'goals', 'mood', 'resolving'],
                },
            },
            importance: {
                type: 'array',
                description: 'Apply the promotions the Counsellor sent in Petitions.',
                items: {
                    type: 'object',
                    properties: {
                        character: { type: 'string' },
                        importance: { type: 'string', enum: ['main', 'side', 'temporary', 'mass'], description: 'main (Main Cast), side (Side Character), temporary (Temporary Character) or mass (NPC/Mass).' },
                    },
                    required: ['character', 'importance'],
                },
            },
            pending: {
                type: 'array',
                description: 'Accept or reject the resolver\'s spiritual edits that wait in the Great Bank.',
                items: {
                    type: 'object',
                    properties: {
                        character: { type: 'string' },
                        index: { type: 'number', description: 'Which proposal, from 0. Default: the first.' },
                        accept: { type: 'boolean', description: 'true writes the proposal into the bank; false drops it.' },
                    },
                    required: ['character', 'accept'],
                },
            },
            comment: COMMENT,
        },
        required: ['decrees', 'comment'],
    },
});

/** Форма Директора перед действием — проверяет движок (libraries/core/director-checklist.js). */
export const CHECK_REPORTS_TOOL = Object.freeze({
    name: 'check_reports',
    displayName: 'Check the reports',
    description: 'Your first call in every run, before any other: the checklist of what this report asks of you. One entry per character the reports touch — and on a new day, everyone with a Decree. For each: which report names them, whether their bank must be written, what happens to their Decree, and whether their standing changes. Characters the reports do not name are not in the form: their files stay as they are. Afterwards the engine holds you to the form — you can only touch what it lists, and await waits until what it promises is done. To change the plan, fill the form again.',
    parameters: {
        type: 'object',
        properties: {
            new_day: { type: 'boolean', description: 'True only when the reports say a new day begins.' },
            characters: {
                type: 'array',
                description: 'Every character the reports touch, one entry each — including those for whom nothing changes.',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Exactly as the bank writes it.' },
                        named_by: { type: 'string', description: 'Which report names them: the Petition, the Telegram, the Ledger row, "Main Cast without a Decree" or "new day".' },
                        write_bank: { type: 'boolean', description: 'True only when their material.md and spiritual.md are still empty and they need them now.' },
                        decree: { type: 'string', enum: ['none', 'edit', 'create'], description: 'none — every line of their decree.md still holds; edit — the report breaks a line of it; create — they need a Decree and have none.' },
                        line: { type: 'string', description: 'The proof, copied from their decree.md. For edit: the line the report breaks. For none: the line that already covers what the report shows. Empty only for create, or when the report says nothing about who they are or what they do.' },
                        evidence: { type: 'string', description: 'The fact from the report — what happened to them, in the report\'s own terms — that breaks that line, or that the line already covers.' },
                        importance: { type: 'string', description: 'The new standing (main / side / temporary / mass) only when it changes now; empty otherwise.' },
                    },
                    required: ['name', 'named_by', 'write_bank', 'decree', 'line', 'evidence'],
                },
            },
            comment: COMMENT,
        },
        required: ['characters', 'comment'],
    },
});
