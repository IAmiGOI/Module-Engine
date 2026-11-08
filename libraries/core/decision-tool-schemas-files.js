import { COMMENT } from './decision-tool-comment.js';

/**
 * Файловые инструменты — как текстовый редактор у моделей-кодеров (часть 21).
 * Всё, что модель меняет, — файлы: Characters/<Name>/material.md, spiritual.md,
 * decree.md (позже — Creation/… Бога). Исполнение — `cores/decision/files-layer.js`.
 */
export const VIEW_TOOL = Object.freeze({
    name: 'view',
    displayName: 'View a file',
    description: 'Without "path": list every file you can change. With "path": the full text of that file, exactly as you edit it.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'For example Characters/Emilia/decree.md or Creation/Scales/magic.md.' }, comment: COMMENT }, required: ['comment'] },
});

export const EDIT_TOOL = Object.freeze({
    name: 'edit',
    displayName: 'Edit files',
    description: 'Change files with exact replacements, like a code editor: each edit replaces "old" — text copied from the file — with "new". Several edits, in several files, in one call. An empty "new" removes the text. To add a line, use the line before it as "old" and repeat it in "new" with the addition. Change only what changed; the engine stamps the RP time and keeps the old version.',
    parameters: {
        type: 'object',
        properties: {
            edits: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'The file, for example Characters/Emilia/decree.md or Creation/geography.md.' },
                        old: { type: 'string', description: 'Exact text from the file to replace.' },
                        new: { type: 'string', description: 'The replacement.' },
                    },
                    required: ['path', 'old', 'new'],
                },
            },
            comment: COMMENT,
        },
        required: ['edits', 'comment'],
    },
});

export const CREATE_TOOL = Object.freeze({
    name: 'create',
    displayName: 'Create a file',
    description: 'Write a whole file at once — only for a file that is empty or does not exist yet, such as the first Decree of a character. Keep the layout of the file kind: numbered sections ("## 1. …") for a character file, the system layout for Creation/Scales/<system>.md.',
    parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, text: { type: 'string', description: 'The whole file in Markdown.' }, comment: COMMENT },
        required: ['path', 'text', 'comment'],
    },
});

export const RESOLVE_PROPOSALS_TOOL = Object.freeze({
    name: 'resolve_proposals',
    displayName: 'Accept or reject proposals',
    description: 'Accept or reject the spiritual edits the Resolver proposed for a character.',
    parameters: {
        type: 'object',
        properties: {
            decisions: { type: 'array', items: { type: 'object', properties: { character: { type: 'string' }, index: { type: 'number' }, accept: { type: 'boolean' } }, required: ['character', 'accept'] } },
            comment: COMMENT,
        },
        required: ['decisions', 'comment'],
    },
});
