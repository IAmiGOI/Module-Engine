import { SCALE_RULE_FIELDS } from './decision-scales.js';

/**
 * Creation как файлы (часть 21): раздел — `Creation/<раздел>.md` с его текстом;
 * система весов — `Creation/Scales/<система>.md` в Markdown, который читается и
 * правится как файл и разбирается обратно в правила. Чистые функции.
 */
const text = value => String(value ?? '').trim();
export const slugOf = value => text(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section';
const LABEL = { needs: 'Needs', yields: 'Yields', weight: 'Weight', scaling: 'Scaling', limit: 'Limit', cost: 'Cost', links: 'Links', examples: 'Examples' };
const FIELD_BY_LABEL = Object.fromEntries(Object.entries(LABEL).map(([field, label]) => [label.toLowerCase(), field]));
const lines = value => (Array.isArray(value) ? value : text(value) ? [text(value)] : []).map(text).filter(Boolean);

function weightText(weight) {
    if (!weight || typeof weight !== 'object') return text(weight);
    const parts = [text(weight.level) && text(weight.text) && !text(weight.text).toLowerCase().startsWith(text(weight.level).toLowerCase()) ? `${weight.level} — ${weight.text}` : (text(weight.text) || text(weight.level))];
    if (text(weight.rises)) parts.push(`rises with ${weight.rises}`);
    if (text(weight.falls)) parts.push(`falls with ${weight.falls}`);
    return parts.filter(Boolean).join('; ');
}

export function renderScaleFile(system) {
    const out = [`# ${system.name}`, '', `**Principle:** ${text(system.principle)}`, `**Payment:** ${text(system.payment)}`];
    for (const rule of system.rules ?? []) {
        out.push('', `## ${rule.name}`);
        for (const field of SCALE_RULE_FIELDS.slice(1)) {
            const values = field === 'weight' ? [weightText(rule.weight)].filter(Boolean) : lines(rule[field]);
            if (!values.length) { out.push(`- ${LABEL[field]}: —`); continue; }
            if (values.length === 1) out.push(`- ${LABEL[field]}: ${values[0]}`);
            else out.push(`- ${LABEL[field]}:`, ...values.map(value => `  - ${value}`));
        }
    }
    out.push('', '## Discoveries', ...(system.discoveries ?? []).map(item => `- ${item.rule ? `[${item.rule}] ` : ''}${item.text}`));
    return out.join('\n');
}

/** Файл системы → { system, principle, payment, rules, discoveries: [строки] }. */
export function parseScaleFile(source) {
    const result = { system: '', principle: '', payment: '', rules: [], discoveries: [] };
    let rule = null;
    let field = null;
    let inDiscoveries = false;
    for (const raw of String(source ?? '').split('\n')) {
        const line = raw.replace(/\s+$/, '');
        let match;
        if ((match = /^#\s+(.+)$/.exec(line))) { result.system = text(match[1]); continue; }
        if ((match = /^##\s+(.+)$/.exec(line))) {
            field = null;
            inDiscoveries = /^discoveries$/i.test(text(match[1]));
            rule = inDiscoveries ? null : { name: text(match[1]) };
            if (rule) result.rules.push(rule);
            continue;
        }
        if ((match = /^\*\*(Principle|Payment):\*\*\s*(.*)$/i.exec(line))) { result[match[1].toLowerCase()] = text(match[2]); continue; }
        if (inDiscoveries) { const body = text(line.replace(/^\s*[-*]\s+/, '')); if (body) result.discoveries.push(body); continue; }
        if (!rule) continue;
        if ((match = /^\s*[-*]\s+([A-Za-z]+):\s*(.*)$/.exec(line)) && FIELD_BY_LABEL[match[1].toLowerCase()]) {
            field = FIELD_BY_LABEL[match[1].toLowerCase()];
            const value = text(match[2]);
            rule[field] = value && value !== '—' ? [value] : [];
            continue;
        }
        if (field && (match = /^\s{2,}[-*]\s+(.+)$/.exec(line))) rule[field] = [...(rule[field] ?? []), text(match[1])];
    }
    for (const item of result.rules) if (Array.isArray(item.weight)) item.weight = item.weight.join('; ');
    return result;
}
