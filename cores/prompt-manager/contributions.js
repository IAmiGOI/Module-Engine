/**
 * Контракт вкладов модулей в промпт (chat-inject нового образца, PROMPT_MANAGER_PLAN.md раздел 0):
 * модуль не делает `chat.unshift`, а объявляет вклад `{ id, name, role, content, defaultPlacement, stable }`.
 * Где вклад стоит, решает пользователь (узел `inject` в дереве пресета); `defaultPlacement` — лишь начальное
 * положение, к которому можно вернуться кнопкой. Здесь — реестр вкладов и вставка узлов в дерево.
 *
 * 'before-history' — начало истории (сразу после «[Start a new Chat]», как модули и вставляли раньше).
 * defaultPlacement: 'before-history' | 'after-history' | 'top' | 'bottom' | { mode: 'depth', depth, order }
 */
export function createContributionRegistry() {
    const items = new Map();
    return {
        set(contribution) {
            const id = String(contribution?.id ?? '').trim();
            if (!id) throw new Error('promptManager.contribute: "id" is required.');
            items.set(id, { id, name: contribution.name ?? id, role: contribution.role ?? 'system', content: String(contribution.content ?? ''), defaultPlacement: contribution.defaultPlacement ?? 'before-history', stable: Boolean(contribution.stable) });
            return id;
        },
        remove: id => items.delete(id),
        clear: () => items.clear(),
        /** Только то, что нужно сборке: { id: { role, content } }. */
        asContext: () => Object.fromEntries([...items.values()].map(item => [item.id, { role: item.role, content: item.content }])),
        list: () => [...items.values()],
    };
}

export function hasInjectNode(nodes, id) {
    return nodes.some(node => (node.type === 'inject' && node.contribution === id)
        || (node.type === 'group' && hasInjectNode(node.children, id))
        || (node.type === 'choice' && node.options.some(option => hasInjectNode(option.children ?? [], id))));
}

function indexOfHistory(tree) {
    return tree.findIndex(node => node.type === 'item' && node.block === 'chatHistory');
}

/** Узел `inject` по начальному положению вклада. */
export function injectNodeFor(contribution) {
    const placement = contribution.defaultPlacement;
    const node = { type: 'inject', contribution: contribution.id, name: contribution.name, enabled: true, defaultPlacement: placement };
    if (placement === 'before-history') node.atHistoryStart = true;
    if (placement?.mode === 'depth') node.placement = { mode: 'depth', depth: placement.depth ?? 0, order: placement.order ?? 100 };
    return node;
}

/** Ставит узел вклада в верхний уровень дерева по `defaultPlacement`. Возвращает true, если дерево изменилось. */
export function placeContribution(tree, contribution) {
    if (hasInjectNode(tree, contribution.id)) return false;
    const node = injectNodeFor(contribution);
    const history = indexOfHistory(tree);
    const placement = contribution.defaultPlacement;
    if (placement === 'top') tree.unshift(node);
    else if (placement === 'bottom') tree.push(node);
    else if (placement === 'after-history' && history >= 0) tree.splice(history + 1, 0, node);
    else if (placement?.mode !== 'depth' && history >= 0) tree.splice(history, 0, node); // before-history — и запасной вариант
    else tree.push(node);
    return true;
}

/** «Вернуть в начальное положение»: убрать узел вклада и поставить заново по `defaultPlacement`. */
export function resetContribution(tree, contribution) {
    const strip = nodes => {
        for (let i = nodes.length - 1; i >= 0; i--) {
            const node = nodes[i];
            if (node.type === 'inject' && node.contribution === contribution.id) nodes.splice(i, 1);
            else if (node.type === 'group') strip(node.children);
            else if (node.type === 'choice') for (const option of node.options) strip(option.children ?? []);
        }
    };
    strip(tree);
    return placeContribution(tree, contribution);
}
