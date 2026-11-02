/**
 * Сборка пользовательского блока раздела: включённые промпты по порядку, с
 * условиями, макросами и группами-обёртками. Чистая функция — модель раздела
 * и готовые факты приходят снаружи; ввод-вывода здесь нет.
 *
 * Возвращает `messages` — то, что вставляется ОДНОЙ точкой на глубину
 * раздела (2 цикла / @5). Роли промптов сохраняются: каждый блок — отдельное
 * сообщение со своей ролью. `text` — тот же блок одной строкой для
 * предпросмотра. Пустой блок или всё выключено — пустые `messages`.
 */
import { createMacroEngine } from './decision-prompt-macros.js';
import { evaluateCondition } from './decision-prompt-conditions.js';

const blank = text => typeof text !== 'string' || text.trim() === '';

export function assemblePromptSection(section, facts = {}) {
    const engine = facts.engine ?? createMacroEngine({
        values: facts.values ?? {}, macros: facts.macros ?? {}, globals: facts.globals,
        random: facts.random, seed: facts.seed,
    });
    const context = { ...facts, vars: engine.vars };
    const messages = [];
    const report = [];
    const skip = (node, reason) => report.push({ blockId: node.id ?? node.block, name: node.name, included: false, reason });

    function emit(nodes, sink) {
        for (const node of nodes ?? []) {
            if (node.type === 'group') {
                if (node.enabled === false) { skip(node, 'disabled'); continue; }
                if (node.condition && !evaluateCondition(node.condition, context)) { skip(node, 'condition'); continue; }
                const inner = [];
                emit(node.children ?? [], inner);
                if (!inner.length && node.skipWhenEmpty !== false) { skip(node, 'empty group'); continue; }
                const role = node.role ?? 'system';
                const tag = String(node.tag ?? node.name ?? '').trim();
                if (!tag) { sink.push(...inner); report.push({ blockId: node.id, name: node.name, included: true, role }); continue; }
                const open = `<${tag}>`;
                const close = `</${tag}>`;
                if (inner.every(message => message.role === role)) {
                    sink.push({ role, content: [open, ...inner.map(message => message.content), close].join('\n') });
                } else {
                    sink.push({ role, content: open }, ...inner, { role, content: close });
                }
                report.push({ blockId: node.id, name: node.name, included: true, role, chars: inner.reduce((sum, message) => sum + message.content.length, 0) });
                continue;
            }
            const block = (section.blocks ?? []).find(item => item.id === node.block);
            if (!block) { skip(node, 'unknown block'); continue; }
            if (node.enabled === false) { report.push({ blockId: block.id, name: block.name, included: false, reason: 'disabled' }); continue; }
            if (node.condition && !evaluateCondition(node.condition, context)) { report.push({ blockId: block.id, name: block.name, included: false, reason: 'condition' }); continue; }
            const content = engine.substitute(block.content ?? '');
            if (blank(content)) { report.push({ blockId: block.id, name: block.name, included: false, reason: 'empty' }); continue; }
            sink.push({ role: block.role ?? 'system', content: content.trim() });
            report.push({ blockId: block.id, name: block.name, included: true, role: block.role ?? 'system', chars: content.trim().length });
        }
    }

    emit(section?.tree ?? [], messages);
    return {
        messages,
        text: messages.map(message => message.content).join('\n\n'),
        report,
        unresolved: [...new Set(engine.state.unresolved)],
        usedRandom: engine.state.usedRandom,
    };
}
