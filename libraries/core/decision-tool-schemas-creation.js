import { COMMENT } from './decision-tool-comment.js';
import { CREATION_SECTION_NAMES } from './decision-creation.js';
import { DIFFICULTY_LEVELS } from './decision-probability.js';

/**
 * Инструменты God: `creation_write` (разделы Creation), `scale_write`
 * (система весов структурно), `discovery_write` (прецедент из Молитвы) и
 * `ask` (вопросы Советнику). Только данные — исполнение в
 * `cores/decision/handlers-creation.js`.
 */

const SCALE_RULE = {
    type: 'object',
    properties: {
        name: { type: 'string', description: 'The operation: what this rule lets someone do, in a few words.' },
        needs: { type: 'string', description: 'What it takes: knowledge, a resource, time, contact, conditions.' },
        yields: { type: 'string', description: 'What exactly happens when it works.' },
        weight: {
            type: 'string',
            description: `How hard the operation is on the resolver's roll scale: ${DIFFICULTY_LEVELS.join(' / ')} — and what raises and lowers it ("moderate; rises with distance and with a wound; falls with a prepared circle").`,
        },
        scaling: { type: 'string', description: 'How it changes with strength, experience or the amount of the resource.' },
        limit: { type: 'string', description: 'The hard line: what it can never do.' },
        cost: { type: 'string', description: 'What is paid for it, and what happens when it fails.' },
        links: { type: 'string', description: 'How it meets the other systems of this world.' },
        examples: { type: 'array', items: { type: 'string' }, description: 'Two or three cases, including one unusual use.' },
    },
    required: ['name', 'needs', 'yields', 'weight'],
};

export const CREATION_WRITE_TOOL = Object.freeze({
    name: 'creation_write',
    displayName: 'Write the Creation',
    description: `Write sections of the Creation — the great data bank of this world. Call it once per section, or several sections in one call; the engine collects them. A section written again replaces its old text and the old text is kept in its history with the turn's RP time. The six guaranteed sections, each named exactly: ${CREATION_SECTION_NAMES.join('; ')}. Free sections are allowed for anything the world needs beyond them. Write law, not story.`,
    parameters: {
        type: 'object',
        properties: {
            sections: {
                type: 'array',
                description: 'The sections to write.',
                items: {
                    type: 'object',
                    properties: {
                        title: { type: 'string', description: `One of the six guaranteed titles, or a free title of your own.` },
                        guaranteed: { type: 'boolean', description: 'True when this is one of the six guaranteed sections.' },
                        text: { type: 'string', description: 'The section itself, in Markdown. Short paragraphs, "-" lists, small tables where they help.' },
                    },
                    required: ['title', 'text'],
                },
            },
            comment: COMMENT,
        },
        required: ['sections', 'comment'],
    },
});

export const SCALE_WRITE_TOOL = Object.freeze({
    name: 'scale_write',
    displayName: 'Write a system of weight',
    description: 'Write one system of weight (a Scales entry) structurally: its name, its principle in one line, what it costs, and one rule per operation a story might attempt. A system written again replaces its rules and keeps its Discoveries. Weight is the hard part: put the resolver\'s difficulty level (trivial / easy / moderate / hard / very hard / nearly impossible) and say what raises and lowers it. Write it so a weaker model can apply it as a table without inventing.',
    parameters: {
        type: 'object',
        properties: {
            system: { type: 'string', description: 'The name of the system.' },
            principle: { type: 'string', description: 'What it is, in one line.' },
            payment: { type: 'string', description: 'What everyone pays for using it: mana, focus, time, material, health.' },
            rules: { type: 'array', description: 'One rule per operation. Two to eight rules is usual; more when the system is large.', items: SCALE_RULE },
            comment: COMMENT,
        },
        required: ['system', 'principle', 'payment', 'rules', 'comment'],
    },
});

export const DISCOVERY_WRITE_TOOL = Object.freeze({
    name: 'discovery_write',
    displayName: 'Record a Discovery',
    description: 'Record a precedent from a Prayer: what was done, by which rule, and what came of it. From here on it is the law of the world. Only you write Discoveries; never erase one — a rule that changes is a new Discovery beside it.',
    parameters: {
        type: 'object',
        properties: {
            system: { type: 'string', description: 'The system of weight the Discovery belongs to, exactly as the Creation names it.' },
            rule: { type: 'string', description: 'Which rule of that system was used, in its own words.' },
            text: { type: 'string', description: 'What was done and what the world now holds to — one or two sentences, so a weaker model can apply it.' },
            comment: COMMENT,
        },
        required: ['system', 'text', 'comment'],
    },
});

export const GOD_ASK_TOOL = Object.freeze({
    name: 'ask',
    displayName: 'Ask the Counsellor',
    description: 'Ask the Counsellor about what the material cannot answer — about the world, not about one character. Questions reach the user through the Counsellor; every answer comes back to you together as a Declaration only after all are closed. Ask few, concrete questions; ask nothing you can decide yourself.',
    parameters: {
        type: 'object',
        properties: {
            questions: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        question: { type: 'string', description: 'One concrete question about this world.' },
                        why: { type: 'string', description: 'One phrase: what in the Creation depends on the answer.' },
                    },
                    required: ['question'],
                },
                description: 'One to five questions.',
            },
            comment: COMMENT,
        },
        required: ['questions', 'comment'],
    },
});
