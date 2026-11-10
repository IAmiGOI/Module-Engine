import { DIFFICULTY_LEVELS } from './decision-probability.js';

/**
 * Системы весов (Scales) — чистые правила формата из `DIRECTOR-SPEC.md`,
 * раздел «Формат системы весов». Система — набор правил, который слабая
 * модель применяет как таблицу, без додумывания: принцип одной строкой, чем
 * платят, и по правилу на операцию.
 *
 * `weight` — уровень шкалы бросков резолвера (`trivial … nearly impossible`)
 * и словами, от чего он растёт и падает. Движок понимает и готовую строку, и
 * объект `{ level, rises, falls }`. Ничего не выдумывается: нет уровня в
 * словах — уровня нет, и это честно видно в таблице.
 *
 * Discoveries — прецеденты из Молитв: что сделали, по какому правилу, что
 * вышло. Их дописывает только God; дальше это закон мира.
 */

const text = value => String(value ?? '').trim();
const slug = value => text(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

export const SCALE_RULE_FIELDS = Object.freeze([
    'name', 'needs', 'yields', 'weight', 'scaling', 'limit', 'cost', 'links', 'examples',
]);

const FIELD_LABEL = Object.freeze({
    needs: 'Needs', yields: 'Yields', weight: 'Weight', scaling: 'Scaling',
    limit: 'Limit', cost: 'Cost', links: 'Links', examples: 'Examples',
});

/** Строка или массив → строки: `- ` снимается, пустое отбрасывается. */
export function scaleLines(value) {
    const list = Array.isArray(value) ? value : (text(value) ? String(value).split(/\n+/) : []);
    return list.map(item => text(item).replace(/^\s*[-*•]\s*/, '')).filter(Boolean);
}

/** Уровень шкалы бросков внутри слов: сначала более длинные названия («very hard» раньше «hard»). */
export function levelInWords(value) {
    const lower = ` ${text(value).toLowerCase()} `;
    // Длинные названия проверяются первыми: иначе «very hard» прочиталось бы как «hard».
    const ordered = [...DIFFICULTY_LEVELS].sort((a, b) => b.length - a.length);
    for (const level of ordered) {
        if (new RegExp(`(^|[^a-z])${level}([^a-z]|$)`, 'i').test(lower)) return level;
    }
    return '';
}

/** «от чего растёт и падает» — куски текста после слов роста и падения, до следующей такой оговорки. */
export function weightParts(value) {
    const source = text(value);
    const rise = /(?:rises?|grows?|gains?|increases?|harder|higher|↑)\s*(?:with|when|by|for)?\s*[:\-–]?\s*([^;.\n]+)/i.exec(source);
    const fall = /(?:falls?|drops?|lowers?|decreases?|easier|↓)\s*(?:with|when|by|for)?\s*[:\-–]?\s*([^;.\n]+)/i.exec(source);
    const cut = (part, other) => {
        const body = text(part);
        if (!body || !other) return body;
        // Хвост одной оговорки не должен втягивать в себя другую.
        const at = body.toLowerCase().search(other);
        return at > 0 ? text(body.slice(0, at)) : body;
    };
    return {
        rises: cut(rise?.[1], /\b(?:falls?|drops?|lowers?|decreases?|easier|↓)/i),
        falls: cut(fall?.[1], /\b(?:rises?|grows?|gains?|increases?|harder|higher|↑)/i),
    };
}

/**
 * `weight` → `{ level, rises, falls, text }`. Строка целиком сохраняется: она
 * нужна промпту как есть, а уровень и рост/падение — таблице.
 */
export function normalizeWeight(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const parts = weightParts(value.text ?? '');
        const level = DIFFICULTY_LEVELS.includes(text(value.level).toLowerCase())
            ? text(value.level).toLowerCase() : levelInWords(value.text ?? value.level);
        return { level, rises: text(value.rises) || parts.rises, falls: text(value.falls) || parts.falls, text: text(value.text) || text(value.level) };
    }
    const body = text(value);
    const parts = weightParts(body);
    return { level: levelInWords(body), rises: parts.rises, falls: parts.falls, text: body };
}

/** Одно правило: все поля строкой или списком, `examples` остаются списком. */
export function normalizeScaleRule(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const rule = { name: text(source.name) };
    if (!rule.name) return null;
    rule.needs = scaleLines(source.needs);
    rule.yields = scaleLines(source.yields);
    rule.weight = normalizeWeight(source.weight);
    rule.scaling = scaleLines(source.scaling);
    rule.limit = scaleLines(source.limit);
    rule.cost = scaleLines(source.cost);
    rule.links = scaleLines(source.links);
    rule.examples = scaleLines(source.examples);
    return rule;
}

/** Система весов: имя, принцип, чем платят, правила, прецеденты. */
export function normalizeScaleSystem(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const name = text(source.system ?? source.name ?? source.title);
    if (!name) return null;
    const rules = (Array.isArray(source.rules) ? source.rules : []).map(normalizeScaleRule).filter(Boolean);
    return {
        id: text(source.id) || `scale:${slug(name)}`,
        name,
        principle: text(source.principle),
        payment: text(source.payment),
        senses: text(source.senses),
        rules,
        discoveries: (Array.isArray(source.discoveries) ? source.discoveries : [])
            .filter(item => item && typeof item === 'object' && text(item.text))
            .map(item => ({ at: text(item.at), rule: text(item.rule), text: text(item.text), seq: Number(item.seq) || 0 })),
    };
}

export function normalizeScaleSystems(value) {
    return (Array.isArray(value) ? value : []).map(normalizeScaleSystem).filter(Boolean);
}

/** Система по имени — точное совпадение, затем похожее (без регистра и знаков). */
export function findScaleSystem(systems, name) {
    const wanted = slug(name);
    if (!wanted) return null;
    const list = Array.isArray(systems) ? systems : [];
    const exact = list.find(system => slug(system.name) === wanted || system.id === wanted);
    if (exact) return exact;
    return list.find(system => slug(system.name).includes(wanted) || wanted.includes(slug(system.name))) ?? null;
}

const oneLine = value => scaleLines(value).join('; ');

/** Система → таблица-текст. Широкая, зато без додумывания: каждое поле на месте. */
export function renderScaleSystem(system, { discoveries = true } = {}) {
    if (!system) return '';
    const lines = [`### ${system.name}`];
    if (system.principle) lines.push(`**Principle:** ${system.principle}`);
    if (system.payment) lines.push(`**Payment:** ${system.payment}`);
    if (system.senses) lines.push(`**Senses:** ${system.senses}`);
    if (system.rules.length) {
        lines.push(`| Rule | ${SCALE_RULE_FIELDS.slice(1).map(field => FIELD_LABEL[field]).join(' | ')} |`);
        lines.push(`|---|${SCALE_RULE_FIELDS.slice(1).map(() => '---').join('|')}|`);
        for (const rule of system.rules) {
            const cells = SCALE_RULE_FIELDS.slice(1).map(field => {
                if (field === 'weight') {
                    // Уровень уже стоит первым; рост и падение — отдельными пометками. В теле их не повторяем.
                    const strip = value => text(value)
                        .replace(/\b(?:rises?|grows?|gains?|increases?|harder|higher)\s*(?:with|when|by|for)?\s*[:\-–]?\s*[^;.\n]+/gi, '')
                        .replace(/\b(?:falls?|drops?|lowers?|decreases?|easier)\s*(?:with|when|by|for)?\s*[:\-–]?\s*[^;.\n]+/gi, '')
                        .replace(/\s*[;,—–-]\s*$/g, '').replace(/\s*[;,—–-]\s*(?=[;,—–-])/g, '; ')
                        .replace(/\s{2,}/g, ' ').trim();
                    const body = strip(rule.weight.level
                        ? rule.weight.text.replace(new RegExp(`^\\s*${rule.weight.level.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:;,—–-]?\\s*`, 'i'), '')
                        : rule.weight.text);
                    const parts = [rule.weight.level ? `${rule.weight.level}${body ? ` — ${body}` : ''}` : body].filter(Boolean);
                    if (rule.weight.rises) parts.push(`rises with ${rule.weight.rises}`);
                    if (rule.weight.falls) parts.push(`falls with ${rule.weight.falls}`);
                    return parts.join('; ').replace(/\|/g, '/');
                }
                return oneLine(rule[field]).replace(/\|/g, '/') || '—';
            });
            lines.push(`| **${rule.name}** | ${cells.join(' | ')} |`);
        }
    } else {
        lines.push('No rule is written yet.');
    }
    if (discoveries && system.discoveries.length) {
        lines.push('DISCOVERIES (precedents from Prayers; only God writes them, and from here on they are the law of the world):');
        lines.push(...system.discoveries.map(item => `- ${item.at ? `${item.at} ` : ''}${item.rule ? `[${item.rule}] ` : ''}${item.text}`));
    }
    return lines.join('\n');
}

/** Все системы → раздел Scales. */
export function renderScales(systems) {
    const list = normalizeScaleSystems(systems);
    if (!list.length) return '';
    return list.map(system => renderScaleSystem(system)).join('\n\n');
}

/** Новый прецедент: дописывается в свою систему; системы нет — создаётся честная. */
export function appendDiscovery(systems, { system, rule = '', text: body = '', at = '', seq = 0 } = {}) {
    const list = normalizeScaleSystems(systems);
    const entry = { at: text(at), rule: text(rule), text: text(body), seq: Number(seq) || 0 };
    if (!text(body)) return { systems: list, system: null, added: false };
    const found = findScaleSystem(list, system);
    if (!found) {
        const created = normalizeScaleSystem({ system: text(system) || 'Unnamed system', discoveries: [entry] });
        return { systems: [...list, created], system: created.name, added: true };
    }
    const next = list.map(item => (item.id === found.id ? { ...item, discoveries: [...item.discoveries, entry] } : item));
    return { systems: next, system: found.name, added: true };
}

/** Каждое открытие с именем системы — для короткого блока у задания резолвера. */
export function discoveriesAfter(systems, seq = 0) {
    const list = normalizeScaleSystems(systems);
    return list.flatMap(system => system.discoveries
        .filter(item => Number(item.seq) > Number(seq))
        .map(item => ({ system: system.name, ...item })));
}

export function renderDiscoveries(entries) {
    const list = Array.isArray(entries) ? entries.filter(item => text(item?.text)) : [];
    if (!list.length) return '';
    return [
        'NEW DISCOVERIES (found since the world was last read; from here on they are the law of the world):',
        ...list.map(item => `- ${item.at ? `${item.at} ` : ''}**${item.system}**${item.rule ? ` — ${item.rule}` : ''}: ${item.text}`),
    ].join('\n');
}
