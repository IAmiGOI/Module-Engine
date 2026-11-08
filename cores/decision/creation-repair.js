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
