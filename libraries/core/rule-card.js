/** Карточка правила системы мира — для показа новых правил резолверу: снимок мира мог её не содержать. Чистая функция. */
const text = value => String(value ?? '').trim();
const joined = list => (Array.isArray(list) ? list : [list]).map(text).filter(Boolean).join(' ');

export function ruleCard(system, rule) {
    return [
        `RULE ${text(system?.name)} / ${text(rule?.name)}`,
        ...(text(system?.senses) ? [`Senses: ${text(system.senses)}`] : []),
        `Needs: ${joined(rule?.needs) || '—'}`,
        `Yields: ${joined(rule?.yields) || '—'}`,
        `Weight: ${text(rule?.weight?.text) || text(rule?.weight?.level) || '—'}`,
        `Scaling: ${joined(rule?.scaling) || '—'}`,
        `Limit: ${joined(rule?.limit) || '—'}`,
    ].join('\n');
}
