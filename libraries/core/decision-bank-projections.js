import { lineIsPast } from './decision-bank-time.js';
import { MATERIAL_SECTIONS, SPIRITUAL_SECTIONS, DECREE_SECTIONS, sectionsOf } from './decision-bank-sections.js';

/**
 * Проекции Great Bank в контексты — чистые функции над записями персонажей.
 *
 * Три проекции, все — из одного банка:
 * - дальняя, компактная (Material 1, 3, 6 + Spiritual 4, 6) — всем, снимается
 *   снимком при переключении окна;
 * - ближняя, полная — активному ростеру, директору, после каждой правки;
 * - писателю — полные банки активного ростера и указы всех персонажей.
 *
 * Строка с меткой RP-времени показывается с меткой; истёкшая — с пометкой
 * «(past)». Банк старого сборщика (свободный текст, не переведён) идёт как
 * есть: разделов у него нет.
 */

const text = value => String(value ?? '').trim();

export const FAR_MATERIAL = Object.freeze([1, 3, 6]);
export const FAR_SPIRITUAL = Object.freeze([4, 6]);

const PARTS = Object.freeze({
    material: MATERIAL_SECTIONS,
    spiritual: SPIRITUAL_SECTIONS,
    decree: DECREE_SECTIONS,
});

const PART_LABEL = Object.freeze({ material: 'Material', spiritual: 'Spiritual', decree: 'Decree' });

function heading(part, no) {
    const section = (PARTS[part] ?? []).find(item => item.no === Number(no));
    return section ? `${PART_LABEL[part] ?? part} ${section.no} · ${section.name}` : `${PART_LABEL[part] ?? part} ${no}`;
}

function renderLine(line, nowValue) {
    const body = text(line);
    if (!body) return '';
    return `- ${body}${Number.isFinite(Number(nowValue)) && lineIsPast(body, nowValue) ? ' (past)' : ''}`;
}

function blocksOf(character, parts, nowValue) {
    const blocks = [];
    for (const { part, nos } of parts) {
        for (const no of nos) {
            const lines = character?.[part]?.[no] ?? [];
            const body = lines.map(line => renderLine(line, nowValue)).filter(Boolean);
            if (body.length) blocks.push(`${heading(part, no)}\n${body.join('\n')}`);
        }
    }
    return blocks;
}

function entryBlock(entry, parts, nowValue) {
    const character = entry?.character;
    if (!character) return '';
    const blocks = character.sectionsReady === false ? [] : blocksOf(character, parts, nowValue);
    if (blocks.length) return `### ${text(character.name)}\n${blocks.join('\n\n')}`;
    const legacy = text(character.fallbackText);
    return legacy ? `### ${text(character.name)}\n${legacy.replace(/^\s*\*{3}[^\n]*\*{3}\s*\n?/, '')}` : '';
}

const FAR_PARTS = Object.freeze([
    { part: 'material', nos: FAR_MATERIAL },
    { part: 'spiritual', nos: FAR_SPIRITUAL },
]);

const ALL_PARTS = Object.freeze([
    { part: 'material', nos: MATERIAL_SECTIONS.map(section => section.no) },
    { part: 'spiritual', nos: sectionsOf('spiritual').map(section => section.no) },
]);

const DECREE_PARTS = Object.freeze([{ part: 'decree', nos: DECREE_SECTIONS.map(section => section.no) }]);

/** Дальняя компактная проекция: Material 1, 3, 6 + Spiritual 4, 6, по всем персонажам. */
export function renderFarBanks(entries, { nowValue = null } = {}) {
    const blocks = (Array.isArray(entries) ? entries : []).map(entry => entryBlock(entry, FAR_PARTS, nowValue)).filter(Boolean);
    if (!blocks.length) return '';
    return `CHARACTER DATA BANKS — COMPACT (appearance, life facts, abilities; needs and goals, resolving; this is the starting picture):\n\n${blocks.join('\n\n')}`;
}

/** Ближняя полная проекция: все разделы, по названным персонажам. */
export function renderNearBanks(entries, { nowValue = null, title = 'CHARACTER DATA BANKS — FULL (the characters in this scene)' } = {}) {
    const blocks = (Array.isArray(entries) ? entries : []).map(entry => entryBlock(entry, ALL_PARTS, nowValue)).filter(Boolean);
    if (!blocks.length) return '';
    return `${title}:\n\n${blocks.join('\n\n')}`;
}

/** Указы всех персонажей — писателю перед последним сообщением; пока Указов нет, блока нет. */
export function renderDecreeSection(entries, { nowValue = null } = {}) {
    const blocks = (Array.isArray(entries) ? entries : []).map(entry => {
        const body = blocksOf(entry?.character, DECREE_PARTS, nowValue);
        return body.length ? `### ${text(entry.character.name)}\n${body.join('\n\n')}` : '';
    }).filter(Boolean);
    if (!blocks.length) return '';
    return `DECREES — how each character is to be played in this story:\n\n${blocks.join('\n\n')}`;
}

/** Указ резолверу: только действующие, на @10. Пока пусто — честная строка вместо блока. */
export const NO_DECREE = 'No Decree yet — play from the bank.';

export function renderDecreeForResolver(entries, { nowValue = null, names = null } = {}) {
    const wanted = Array.isArray(names) ? new Set(names.map(name => text(name).toLowerCase())) : null;
    const blocks = (Array.isArray(entries) ? entries : [])
        .filter(entry => !wanted || wanted.has(text(entry?.character?.name).toLowerCase()))
        .map(entry => {
            const body = blocksOf(entry?.character, DECREE_PARTS, nowValue);
            return body.length ? `### ${text(entry.character.name)}\n${body.join('\n\n')}` : '';
        })
        .filter(Boolean);
    if (!blocks.length) return `DECREES — how each character is to be played in this story:\n\n${NO_DECREE}`;
    return `DECREES — how each character is to be played in this story:\n\n${blocks.join('\n\n')}`;
}
