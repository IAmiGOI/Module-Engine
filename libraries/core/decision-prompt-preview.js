/**
 * Скелет предпросмотра раздела. Чистые данные: окно рисует строки, Ядро
 * отдаёт уже посчитанные плашки. Большие тексты данных сюда не попадают —
 * только подпись и размер.
 */
export function hasVolatileConditions(nodes) {
    const inCondition = condition => {
        if (!condition) return false;
        if (condition.type === 'chance' || condition.type === 'cooldown') return true;
        if (condition.type === 'not') return inCondition(condition.item);
        return (condition.items ?? []).some(inCondition);
    };
    return (nodes ?? []).some(node => inCondition(node.condition) || hasVolatileConditions(node.children));
}

/**
 * @param {{ sectionId: string, systems: Array<{name, role, text}>, before?: Array<{label, detail}>,
 *           after?: Array<{label, detail}>, block: { messages, text, unresolved, usedRandom },
 *           tail?: { label, detail }, tree: Array }} input
 */
export function previewRows({ sectionId, systems = [], before = [], after = [], block = { messages: [], text: '' }, tail = null, tree = [] }) {
    const rows = systems.map(line => ({ kind: 'system', label: line.name, detail: line.role, text: line.text, locked: true }));
    for (const part of before) rows.push({ kind: 'data', label: part.label, detail: part.detail });
    if (block.messages?.length) {
        rows.push({ kind: 'block', label: 'Your prompts', detail: `${block.messages.length} message${block.messages.length === 1 ? '' : 's'}`, text: block.text });
    } else {
        rows.push({ kind: 'block-empty', label: 'Your prompts', detail: 'nothing will be sent' });
    }
    for (const part of after) rows.push({ kind: 'data', label: part.label, detail: part.detail });
    if (tail) rows.push({ kind: 'data', label: tail.label, detail: tail.detail });

    const warnings = [];
    if (block.unresolved?.length) warnings.push(`Unknown macros left as text: ${block.unresolved.join(', ')}`);
    if (block.usedRandom) warnings.push('This section uses random macros: the text changes between turns, so the provider prefix cache breaks.');
    if (hasVolatileConditions(tree)) warnings.push('A chance or cooldown condition changes this text between turns: the provider prefix cache breaks when it flips.');
    if (!block.messages?.length) warnings.push(`Nothing from the ${sectionId} section will be inserted.`);
    return { rows, warnings };
}
