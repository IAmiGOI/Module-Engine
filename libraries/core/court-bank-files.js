import { sectionsOf } from './decision-bank-sections.js';

/**
 * Персонаж Great Bank как файл для вкладки «Files» (часть 21): часть банка
 * (Material, Spiritual, Decree) → Markdown с разделом на заголовок и строкой на
 * пункт; правка файла → правки `bank_edit` по строкам (время ставит движок).
 */
const heading = section => `## ${section.no}. ${section.name}`;

export function renderPart(character, part) {
    const store = character?.[part] ?? {};
    return sectionsOf(part).map(section => {
        const lines = (Array.isArray(store[section.no]) ? store[section.no] : []).map(line => `- ${line}`);
        return [heading(section), ...lines].join('\n');
    }).join('\n\n');
}

/** psyche.md — строки без разделов: механизмы и темп психики. */
export function renderPsyche(character) {
    return (Array.isArray(character?.psyche) ? character.psyche : []).map(line => `- ${line}`).join('\n');
}

export function parsePart(text, part) {
    const out = Object.fromEntries(sectionsOf(part).map(section => [section.no, []]));
    let current = null;
    for (const raw of String(text ?? '').split('\n')) {
        const head = /^##\s*(\d+)\./.exec(raw);
        if (head) { current = Number(head[1]); if (!out[current]) out[current] = []; continue; }
        const line = raw.replace(/^\s*[-*]\s+/, '').trim();
        if (current !== null && line) out[current].push(line);
    }
    return out;
}

/** Разница двух версий части → правки: убранные строки — пустым `new`, новые — дописываются. */
export function editsForPart(name, part, before, after) {
    const was = parsePart(before, part);
    const now = parsePart(after, part);
    const edits = [];
    for (const no of new Set([...Object.keys(was), ...Object.keys(now)])) {
        const left = [...(was[no] ?? [])];
        const right = [...(now[no] ?? [])];
        const removed = left.filter(line => !right.includes(line));
        const added = right.filter(line => !left.includes(line));
        const section = `${part} ${no}`;
        // Строка поменялась на месте — одна правка `old → new`, а не «удалить и дописать».
        while (removed.length && added.length) edits.push({ character: name, section, old: removed.shift(), new: added.shift() });
        for (const line of removed) edits.push({ character: name, section, old: line, new: '' });
        for (const line of added) edits.push({ character: name, section, old: '', new: line });
    }
    return edits;
}
