import { parseScaleFile } from '../../libraries/core/creation-files.js';

/**
 * Починка правил Scales, потерянных разборщиком (до 2026-11-08 он не понимал
 * жирную метку «- **Needs:** …», и все поля правил записывались пустыми).
 * Исходный текст файла лежит в журнале — в вызове `create` Бога; правила
 * восстанавливаются из него без нового запуска Бога. Открытия системы
 * сохраняются (writeScale их не трогает).
 */
const FIELDS = ['needs', 'yields', 'weight', 'scaling', 'limit', 'cost', 'links', 'examples'];
const filled = rule => FIELDS.some(field => (Array.isArray(rule?.[field]) ? rule[field].length : String(rule?.[field]?.text ?? rule?.[field] ?? '').trim()));
const keyOf = value => String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export async function repairEmptyRules({ creation, cycles = [] }) {
    const state = creation?.state?.();
    const broken = (state?.scales ?? []).filter(system => (system.rules ?? []).length && !(system.rules ?? []).some(filled));
    if (!broken.length) return [];
    // Последний полный текст каждой системы из вызовов create Бога, по имени из заголовка «# …».
    const written = new Map();
    for (const cycle of Array.isArray(cycles) ? cycles : []) {
        if (!String(cycle?.event ?? '').startsWith('god')) continue;
        for (const call of cycle.toolCalls ?? []) {
            if (call?.name !== 'create' || !/^creation\/scales\//i.test(String(call.args?.path ?? ''))) continue;
            const parsed = parseScaleFile(String(call.args?.text ?? ''));
            if (parsed.system && parsed.rules.some(filled)) written.set(keyOf(parsed.system), parsed);
        }
    }
    const repaired = [];
    for (const system of broken) {
        const parsed = written.get(keyOf(system.name));
        if (!parsed) continue;
        const result = await creation.writeScale({ system: system.name, principle: parsed.principle || system.principle, payment: parsed.payment || system.payment, rules: parsed.rules });
        if (result?.ok) repaired.push(system.name);
    }
    return repaired;
}

/**
 * Час старта, которого не было: до первого хода Бог видел пустые часы движка
 * «Day 1, 00:00» и записал их как момент начала — резолвер играл полночь.
 * Строки с ним в разделах Creation меняются на «первую сцену истории».
 */
const START_HOUR = [
    [/\bon\s+(\*{0,2})Day 1, 00:00\1/g, 'in $1the story\'s opening scene$1'],
    [/\bAt 00:00 on Day 1\b/g, 'At the story\'s opening scene'],
    [/\bat 00:00 on Day 1\b/g, 'at the story\'s opening scene'],
    [/\bDay 1, 00:00\b/g, 'The opening scene'],
];

export async function repairStartHour({ creation }) {
    const state = creation?.state?.();
    const fixed = [];
    for (const section of state?.sections ?? []) {
        const before = String(section?.text ?? '');
        if (!/00:00/.test(before)) continue;
        let after = before;
        for (const [pattern, value] of START_HOUR) after = after.replace(pattern, value);
        if (after === before) continue;
        const result = await creation.writeSections({ sections: [{ title: section.title, text: after }], by: 'engine', comment: 'The start hour came from the empty engine clock before the first turn; the start is the opening scene.' });
        if (result?.ok !== false) fixed.push(section.title);
    }
    return fixed;
}
