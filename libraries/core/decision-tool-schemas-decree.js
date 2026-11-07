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
