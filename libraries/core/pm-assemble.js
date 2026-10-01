import { blockById } from './pm-preset-format.js';
import { evaluateCondition } from './pm-conditions.js';
import { mergeWrapped } from './pm-wrap-join.js';
import { applyDividers, computeBrokenPairs } from './pm-dividers.js';

/**
 * Чистая сборка промпта из пресета PM (PROMPT_MANAGER_PLAN.md, этап 2). Без ввода-вывода:
 * всё, что даёт ST и наши Ядра, приходит готовым в `context`.
 *
 * context:
 *   markers — { charDescription, charPersonality, scenario, personaDescription,
 *               worldInfoBefore, worldInfoAfter, dialogueExamples (строка или массив сообщений) }
 *   history — сообщения чата по возрастанию времени: { role, content, … } (вставки модулей уже внутри)
 *   substitute(text) — подстановка макросов (по умолчанию как есть)
 *   injections — готовые вставки на глубину [{ depth, order, role, content, block }] (например, записи лорбука позиции «на глубину»)
 *   contributions — вклады модулей { id: { role, content } } для узлов `inject` (контракт chat-inject)
 *   facts — данные для условий узлов (pm-conditions.js); setVariable(name, value) — для узлов `choice`
 *
 * Возвращает { messages, report }. report — по строке на каждый блок: что вошло и почему нет
 * (для превью «что уходит модели»). Правила сверены с реальным запросом ST 1.18 (раздел 11):
 * каждый блок — отдельное сообщение, пустое содержимое не отправляется, вставка на глубину
 * `depth` встаёт перед последними `depth` сообщениями истории (0 — после последнего), вставки
 * одной глубины идут по возрастанию `order`, пустая группа-обёртка не отправляет свои теги.
 * Группа с обёрткой — одно сообщение `<tag>\n…\n</tag>` (pm-wrap-join.js): группа на глубине склеивается здесь,
 * обычная — после обрезки (теги помечены `_open`/`_close`).
 */
const MARKER_TEXT = {
    charDescription: ctx => ctx.markers.charDescription,
    charPersonality: (ctx, t) => wrapWith(t.personality, '{{personality}}', ctx.markers.charPersonality),
    scenario: (ctx, t) => wrapWith(t.scenario, '{{scenario}}', ctx.markers.scenario),
    personaDescription: ctx => ctx.markers.personaDescription,
    worldInfoBefore: (ctx, t) => wrapWith(t.wi, '{0}', ctx.markers.worldInfoBefore),
    worldInfoAfter: (ctx, t) => wrapWith(t.wi, '{0}', ctx.markers.worldInfoAfter),
};

function wrapWith(template, placeholder, value) {
    if (!value || !String(value).trim()) return '';
    if (!template) return String(value);
    return template.split(placeholder).join(String(value));
}

const isBlank = text => typeof text !== 'string' || text.trim() === '';

function pushMessage(target, message, blockId, report, name) {
    target.push({ ...message, _block: blockId });
    report.push({ blockId, name, included: true, role: message.role, chars: message.content.length });
}

function markerMessages(block, ctx, templates, substitute) {
    if (block.id === 'dialogueExamples') {
        const examples = ctx.markers.dialogueExamples;
        if (Array.isArray(examples)) return examples.filter(m => !isBlank(m.content)).map(m => ({ ...m, content: substitute(m.content) }));
        if (isBlank(examples)) return [];
        const lead = isBlank(templates.newExampleChat) ? [] : [{ role: 'system', content: substitute(templates.newExampleChat) }];
        return [...lead, { role: 'system', content: substitute(examples) }];
    }
    const text = MARKER_TEXT[block.id]?.(ctx, templates);
    return isBlank(text) ? [] : [{ role: 'system', content: substitute(text) }];
}

/**
 * Порядок вставок одной глубины — как у ST 1.18 (openai.js `populationInjectionPrompts`): меньший `order` раньше, при равном
 * `order` роли идут assistant → user → system (system ближе всего к концу — «most important go lower»); дальше порядок пресета.
 */
const ROLE_RANK = { assistant: 0, user: 1, system: 2 };
const byInjectionOrder = (a, b) => (a.order - b.order) || ((ROLE_RANK[a.message.role] ?? 2) - (ROLE_RANK[b.message.role] ?? 2));

/** Вставки на глубину распределяются по истории; возвращает новый массив сообщений. */
function spliceDepth(history, injections) {
    const byDepth = new Map();
    for (const item of injections) {
        const list = byDepth.get(item.depth) ?? [];
        list.push(item);
        byDepth.set(item.depth, list);
    }
    const out = [];
    for (let i = 0; i <= history.length; i++) {
        const depth = history.length - i; // сколько сообщений истории останется после этой точки
        const here = (byDepth.get(depth) ?? []).sort(byInjectionOrder);
        for (const item of here) out.push(item.message);
        if (i < history.length) out.push(history[i]);
    }
    // Глубина больше длины истории — в самое начало истории.
    const start = [...byDepth.entries()].filter(([depth]) => depth > history.length).sort((a, b) => b[0] - a[0]);
    const lead = start.flatMap(([, list]) => list.sort(byInjectionOrder).map(item => item.message));
    return [...lead, ...out];
}

/**
 * Карточка персонажа подменяет текст встроенных блоков `main` (её `system_prompt`) и `jailbreak` (её `post_history_instructions`) — ровно как родной
 * менеджер ST (`openai.js`, «Apply character-specific main prompt / jailbreak»): блок остаётся на своём месте и со своей ролью, меняется только текст, а
 * `{{original}}` в тексте карточки подставляет прежнее содержимое блока. Блок с `forbidOverrides` карточка не трогает. Без этого пресеты, у которых эти
 * блоки пусты ради карточки, теряли её поведенческие правила целиком.
 */
export function applyCardOverride(block, cardOverrides) {
    const original = block.content ?? '';
    const override = cardOverrides?.[block.id];
    if (isBlank(override) || block.forbidOverrides === true) return original;
    return String(override).split(/\{\{original\}\}/i).join(original);
}

export function assemblePrompt(preset, context) {
    const ctx = { markers: {}, history: [], ...context };
    const substitute = ctx.substitute ?? (text => text);
    const report = [];
    const historyLead = []; // вклады «в начале истории»: стоят сразу после строки нового чата, как вставки модулей в реальном запросе
    const injections = (ctx.injections ?? []).filter(item => !isBlank(item.content))
        .map(item => ({ depth: item.depth ?? 4, order: item.order ?? 100, message: { role: item.role ?? 'system', content: substitute(item.content), _block: item.block ?? 'injection' } }));
    let captureDepth = null; // внутри группы на глубине: её вставки собираются в группу
    const toDepth = (depth, order, message) => (captureDepth ? captureDepth.push(message) : injections.push({ depth, order, message }));

    const emit = (list, sink) => {
        // Разделители (pm-dividers.js) снимаются здесь, на каждом уровне списка: блоки закрытой области не доходят до остального разбора.
        for (const broken of computeBrokenPairs(list)) report.push({ blockId: broken.pair, name: broken.name || 'Divider pair', included: false, reason: 'divider pair is not closed' });
        const divided = applyDividers(list, { passes: begin => evaluateCondition(begin.condition, ctx.facts ?? {}) });
        for (const gone of divided.skipped) report.push({ blockId: gone.pair, name: gone.name || 'Divider region', included: false, reason: gone.reason, blocks: gone.blocks });
        const nodes = divided.nodes;
        for (const node of nodes) {
            if (node.condition && node.enabled !== false && !evaluateCondition(node.condition, ctx.facts ?? {})) {
                report.push({ blockId: node.id ?? node.block ?? node.contribution, name: node.name, included: false, reason: 'condition' });
                continue;
            }
            if (node.type === 'note') continue; // заметка для человека, в промпт не идёт
            if (node.type === 'choice') {
                const option = node.options?.find(o => o.id === node.selected) ?? node.options?.[0];
                if (!node.enabled || !option) { report.push({ blockId: node.id, name: node.name, included: false, reason: 'disabled' }); continue; }
                if (node.variable) ctx.setVariable?.(node.variable, option.value ?? option.label ?? option.id);
                emit(option.children ?? [], sink);
                continue;
            }
            if (node.type === 'inject') {
                const contribution = ctx.contributions?.[node.contribution];
                const text = contribution && substitute(contribution.content ?? '');
                if (!node.enabled || isBlank(text)) { report.push({ blockId: node.contribution, name: node.name, included: false, reason: node.enabled ? 'empty' : 'disabled' }); continue; }
                const message = { role: contribution.role ?? 'system', content: text };
                if (node.placement?.mode === 'depth') {
                    toDepth(node.placement.depth ?? 0, node.placement.order ?? 100, { ...message, _block: `inject:${node.contribution}` });
                    report.push({ blockId: node.contribution, name: node.name, included: true, role: message.role, chars: text.length, depth: node.placement.depth ?? 0 });
                } else pushMessage(node.atHistoryStart ? historyLead : sink, message, `inject:${node.contribution}`, report, node.name ?? node.contribution);
                continue;
            }
            if (node.type === 'group') {
                if (!node.enabled) { report.push({ blockId: node.id, name: node.name, included: false, reason: 'disabled' }); continue; }
                const atDepth = node.placement?.mode === 'depth';
                const inner = [];
                const outerCapture = captureDepth;
                if (atDepth) captureDepth = inner; // вставки на глубину внутри группы на глубине — её содержимое, а не отдельные вставки
                emit(node.children, inner);
                captureDepth = outerCapture;
                if (!inner.length && node.skipWhenEmpty) { report.push({ blockId: node.id, name: node.name, included: false, reason: 'empty group' }); continue; }
                const open = node.wrap && blockById(preset, node.wrap.open), close = node.wrap && blockById(preset, node.wrap.close);
                const tag = block => block && { role: block.role ?? 'system', content: substitute(block.content ?? ''), _block: block.id };
                if (atDepth) {
                    const merged = mergeWrapped(tag(open), inner, tag(close), node.id);
                    for (const message of merged) toDepth(node.placement.depth ?? 0, node.placement.order ?? 100, message);
                    report.push({ blockId: node.id, name: node.name, included: true, role: merged[0]?.role, depth: node.placement.depth ?? 0 });
                    continue;
                }
                // Обычная группа: теги помечены, склейка в одно сообщение — после обрезки (pm-wrap-join.js).
                if (open) pushMessage(sink, { ...tag(open), _open: node.id }, open.id, report, open.name);
                sink.push(...inner);
                if (close) pushMessage(sink, { ...tag(close), _close: node.id }, close.id, report, close.name);
                continue;
            }
            const block = blockById(preset, node.block);
            if (!block) { report.push({ blockId: node.block, included: false, reason: 'unknown block' }); continue; }
            if (!node.enabled) { report.push({ blockId: block.id, name: block.name, included: false, reason: 'disabled' }); continue; }
            if (block.id === 'chatHistory') { sink.push({ _historySlot: true }); continue; }
            if (block.marker) {
                const messages = markerMessages(block, ctx, preset.templates, substitute);
                if (!messages.length) report.push({ blockId: block.id, name: block.name, included: false, reason: 'empty' });
                for (const message of messages) pushMessage(sink, message, block.id, report, block.name);
                continue;
            }
            const content = substitute(applyCardOverride(block, ctx.cardOverrides));
            if (isBlank(content)) { report.push({ blockId: block.id, name: block.name, included: false, reason: 'empty' }); continue; }
            const message = { role: block.role ?? 'system', content };
            if (block.position === 'depth') {
                toDepth(block.depth ?? 4, block.order ?? 100, { ...message, _block: block.id });
                report.push({ blockId: block.id, name: block.name, included: true, role: message.role, chars: content.length, depth: block.depth ?? 4 });
            } else pushMessage(sink, message, block.id, report, block.name);
        }
    };

    const flat = [];
    emit(preset.tree, flat);
    const history = ctx.history.map(m => ({ ...m }));
    const newChat = !isBlank(preset.templates.newChat) && history.length
        ? [{ role: 'system', content: substitute(preset.templates.newChat), _block: 'newChat' }] : [];
    const withInjections = spliceDepth([...historyLead, ...history], injections);
    const slotIndex = flat.findIndex(m => m._historySlot);
    const messages = slotIndex < 0
        ? [...flat, ...withInjections]
        : [...flat.slice(0, slotIndex), ...newChat, ...withInjections, ...flat.slice(slotIndex + 1)];
    return { messages: messages.map(({ _block, ...rest }) => (_block ? { ...rest, _block } : rest)), report, hasHistorySlot: slotIndex >= 0 };
}
