/**
 * Вопросы к Jev из условий Prompt Manager: чистые функции. Условие `{ type: 'jev', question, minChance, user, assistant }` — «утверждение истинно с вероятностью не ниже
 * minChance %» (Jev отвечает на утверждение вероятностью, режим Noul). Здесь — найти такие условия в дереве пресета, собрать для каждого срез чата
 * (`state`), объединить вопросы с одинаковым срезом в один вызов и дать стабильный ключ для кэша ответов.
 *
 * `connection` — имя подключения к классификатору (категория моделей «Classifiers»); пусто — первое по списку.
 *
 * Срез чата: сколько последних сообщений читать — ваших (`user`) и ответов (`assistant`), от 0 до 50. В `state` попадают `latest_turn` (самый свежий ответ),
 * `player_message` (ваше самое свежее сообщение) и `history` (остальные выбранные, по порядку, старые первыми); на эти имена вопрос ссылается в обратных кавычках.
 */
import { walkTree } from './pm-preset-format.js';

export const JEV_LEAF_TYPE = 'jev';
export const JEV_MAX_MESSAGES = 50;
export const JEV_DEFAULT_MIN_CHANCE = 70;

const clampCount = value => Math.min(JEV_MAX_MESSAGES, Math.max(0, Math.round(Number(value) || 0)));

/** Нормализованные параметры условия (пустое число сообщений = по одному каждого вида, как по умолчанию в окне). */
export function resolveJevLeaf(leaf) {
    const user = leaf?.user === undefined ? 1 : clampCount(leaf.user);
    const assistant = leaf?.assistant === undefined ? 1 : clampCount(leaf.assistant);
    const minChance = Number.isFinite(Number(leaf?.minChance)) ? Math.min(100, Math.max(0, Number(leaf.minChance))) : JEV_DEFAULT_MIN_CHANCE;
    return { question: String(leaf?.question ?? '').trim(), minChance, user, assistant, connection: String(leaf?.connection ?? '').trim() };
}

/** Простой устойчивый хеш строки (djb2): ключ кэша, не защита. */
export function hashText(text) {
    let hash = 5381;
    for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
    return (hash >>> 0).toString(36);
}

/** Ключ вопроса: утверждение плюс срез чата — два условия с одним и тем же ключом получают один ответ. */
export function computeJevQuestionKey(leaf) {
    const { question, user, assistant, connection } = resolveJevLeaf(leaf);
    return `q${hashText(`${connection}|${question}`)}.${user}.${assistant}`;
}

function* conditionLeaves(condition) {
    if (!condition) return;
    if (condition.type === 'all' || condition.type === 'any') for (const item of condition.items ?? []) yield* conditionLeaves(item);
    else if (condition.type === 'not') yield* conditionLeaves(condition.item);
    else if (condition.type === JEV_LEAF_TYPE) yield condition;
}

/** Все условия Jev у включённых узлов дерева (включая верхние полосы разделителей и ветки «одного из»), без повторов по ключу. */
export function collectJevLeaves(tree) {
    const found = new Map();
    const visit = nodes => {
        for (const node of walkTree(nodes ?? [])) {
            if (node.enabled === false) continue;
            for (const leaf of conditionLeaves(node.condition)) {
                const resolved = resolveJevLeaf(leaf);
                if (resolved.question) found.set(computeJevQuestionKey(leaf), resolved);
            }
            if (node.type === 'choice') node.options?.forEach(option => visit(option.children ?? []));
        }
    };
    visit(tree);
    return [...found].map(([key, leaf]) => ({ key, ...leaf }));
}

const textOfEntry = entry => String(entry?.mes ?? entry?.content ?? '').trim();

/** Срез чата для вопроса (см. doc-comment файла). Пустой срез — `{}`: такому вопросу отвечать не на чем. */
export function computeJevState(chat, { user, assistant }) {
    const messages = (Array.isArray(chat) ? chat : []).filter(entry => !entry?.is_system && textOfEntry(entry));
    const takeNewest = (isUser, count) => (count <= 0 ? [] : messages.map((entry, index) => ({ entry, index })).filter(item => Boolean(item.entry.is_user) === isUser).slice(-count));
    const users = takeNewest(true, user);
    const replies = takeNewest(false, assistant);
    const state = {};
    const newestReply = replies.at(-1);
    const newestUser = users.at(-1);
    if (newestReply) state.latest_turn = textOfEntry(newestReply.entry);
    if (newestUser) state.player_message = textOfEntry(newestUser.entry);
    const rest = [...users.slice(0, -1), ...replies.slice(0, -1)].sort((a, b) => a.index - b.index);
    if (rest.length) state.history = rest.map(item => `${item.entry.is_user ? 'player' : 'narrator'}: ${textOfEntry(item.entry)}`).join('\n');
    return state;
}

/** Вопросы, сгруппированные по срезу чата и подключению: `[{ state, questions: { <ключ>: <утверждение> }, connectionId }]` — один вызов на срез и подключение. Вопросы с пустым срезом отбрасываются. */
export function groupJevCalls(leaves, chat) {
    const groups = new Map();
    for (const leaf of leaves) {
        if (!leaf.question || (leaf.user === 0 && leaf.assistant === 0)) continue;
        const signature = `${leaf.connection}|${leaf.user}.${leaf.assistant}`;
        if (!groups.has(signature)) groups.set(signature, { state: computeJevState(chat, leaf), questions: {}, ...(leaf.connection ? { connectionId: leaf.connection } : {}) });
        groups.get(signature).questions[leaf.key] = leaf.question;
    }
    return [...groups.values()].filter(call => Object.keys(call.state).length);
}
