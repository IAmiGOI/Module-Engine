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

/**
 * Форма проверки Creation: Бог сам, по тем файлам, что видит, отмечает, чего не хватает. Пока в форме что-то открыто,
 * await не принимается. Модель дешёвая — лишний проход проверки дешевле мира с дырой (DeepSeek сослался на Scales/magic.md
 * и так и не написал его).
 */
/** Форма по одному файлу: каждый пункт его списка — сделано или чего не хватает. */
export const GOD_REVIEW_FILE_TOOL = Object.freeze({
    name: 'review_file',
    displayName: 'Review one file',
    description: 'The review form for one Creation file, filled right after you create or edit it. The result of that create or edit carries the file\'s form, built from the file itself: items for the file as a whole and one for each subsection — after an edit, only for what changed and what was still open. Answer every item of the form, in order, from the file as it is now — view it if you are not sure. An item that is not done names what is missing; fix it with edit and fill the form that edit returns.',
    parameters: {
        type: 'object',
        properties: {
            file: { type: 'string', description: 'The file\'s path.' },
            items: {
                type: 'array',
                description: 'Every item of the file\'s form, in order.',
                items: {
                    type: 'object',
                    properties: {
                        item: { type: 'string', description: 'The item, as the form gives it.' },
                        done: { type: 'boolean', description: 'True only if the file holds it in full.' },
                        missing: { type: 'string', description: 'What is missing when it is not done; empty otherwise.' },
                    },
                    required: ['item', 'done'],
                },
            },
            comment: COMMENT,
        },
        required: ['file', 'items', 'comment'],
    },
});

export const GOD_REVIEW_TOOL = Object.freeze({
    name: 'review_creation',
    displayName: 'Review the Creation',
    description: 'The last review before you rest — what only the whole Creation shows: every file one file points to, and what of the material is still uncovered. View the list of files first. While anything is open, await is not accepted; fix it and review again.',
    parameters: {
        type: 'object',
        properties: {
            references: {
                type: 'array',
                description: 'Every file that scales.md or any other file points to.',
                items: {
                    type: 'object',
                    properties: {
                        file: { type: 'string' },
                        exists: { type: 'boolean', description: 'True only if view lists it.' },
                    },
                    required: ['file', 'exists'],
                },
            },
            material: { type: 'string', description: 'Places, powers, peoples, factions and faiths the material names that the Creation does not cover yet. Empty when it covers all of them.' },
            comment: COMMENT,
        },
        required: ['references', 'material', 'comment'],
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
