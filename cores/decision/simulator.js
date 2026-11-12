import { SIMULATOR_SYSTEM, SIMULATOR_TASK, ACCOUNT_FIELDS, RESOLVER_ACCOUNTS, fillPrompt } from '../../libraries/core/decision-prompts.js';
import { isUserCharacter } from '../../libraries/core/decision-great-bank.js';
import { renderDeadlines, withUserLine } from '../../libraries/core/acquaintance.js';
import { promptText } from '../../libraries/core/prompt-overrides.js';

/**
 * Симулятор человека (SIMULATOR-DESIGN.md): перед ходом резолвера — по вызову на каждого присутствующего с банком,
 * параллельно. Отчёт (`account`) говорит, что в человеке и что он делает; резолвер ставит ход из отчётов и людей не решает.
 * Последние отчёты лежат в Great Bank (`moments`): снимок хода и откат несут их сами.
 */
const text = value => String(value ?? '').trim();
const MOMENTS = 7;
const MAX_TOKENS = 6000;
const SPEAKS = /\b(answer|answers|answered|reply|replies|says|said|speak|speaks|tells|told|asks|line|words|voice|retort|retorts|quips|jokes)\b/i;

const sections = (part, nos) => nos.map(no => (part?.[no] ?? []).map(line => `- ${text(line).replace(/^\[[^\]]*\]\s*/, '')}`).join('\n')).filter(Boolean).join('\n');

/** Блок человека: психика, своё самоописание, как он стоит, сроки, тело, знания, знакомство с пользователем, прошлые моменты. */
export function personBlock(character, { now = 0, rpNow = 0, user = 'the user' } = {}) {
    const moments = (Array.isArray(character.moments) ? character.moments : []).slice(-MOMENTS)
        .map((item, at) => `Moment ${at + 1}: took — ${text(item.took)}; inner — ${text(item.inner)}; did — ${text(item.does)}${text(item.says) ? `; said — ${text(item.says)}` : ''}`);
    const deadlines = renderDeadlines([character], { now: rpNow }).split('\n').slice(1).join('\n');
    return [
        `**True Of Them**\n${(character.psyche ?? []).map(line => `- ${line}`).join('\n') || '- (no report yet)'}`,
        `**Their Own Account**\n${[sections(character.decree, [2]), sections(character.spiritual, [1, 4, 5])].filter(Boolean).join('\n')}`,
        `**How They Stand Now**\n${sections(character.decree, [1, 3, 4, 5])}`,
        deadlines ? `**What Hangs Over Them**\n${deadlines}` : '',
        `**Their Body And What They Carry**\n${sections(character.material, [1, 4, 5, 6])}`,
        `**What They Know**\n${(character.knowledge?.items ?? []).map(item => `- ${text(item.fact)}`).join('\n') || '- nothing beyond the above'}\n${withUserLine(character.name, character.withUser, { now, user })}`,
        `**Their Last Moments**\n${moments.join('\n') || '(this is the first moment you model)'}`,
    ].filter(Boolean).join('\n\n');
}

const accountTool = (name, kind) => ({
    name: 'account', description: `What is going on in ${name} now and what ${name} does.`,
    parameters: {
        type: 'object', required: ['took', 'inner', 'does'],
        properties: Object.fromEntries(Object.entries(ACCOUNT_FIELDS).map(([field, description]) => [field, { type: 'string', description: fillPrompt(description, { name, kind }) }])),
    },
});
const WORDS_TOOL = { name: 'words', description: 'Their words.', parameters: { type: 'object', properties: { says: { type: 'string' } }, required: ['says'] } };

const argsOf = answer => {
    const call = (Array.isArray(answer?.toolCalls) ? answer.toolCalls : [])[0];
    if (!call) return {};
    try { return typeof call.arguments === 'string' ? JSON.parse(call.arguments) : (call.arguments ?? {}); } catch { return {}; }
};

/** Отчёты → блок резолверу: поступки и слова; скрытое (wants, holds_back) — одной строкой как мотив, не для страницы. */
export function renderAccounts(accounts) {
    const blocks = (Array.isArray(accounts) ? accounts : []).filter(item => item?.account).map(({ name, account }) => [
        `### ${name}`,
        `- took: ${text(account.took) || '—'}`,
        `- inner: ${text(account.inner) || '—'}`,
        `- wants (not for the page): ${text(account.wants) || '—'}`,
        `- does: ${text(account.does) || 'nothing'}`,
        `- tries: ${text(account.tries) || '—'}`,
        `- says: ${text(account.says) || '— (silent)'}`,
        `- shows: ${text(account.shows) || '—'}`,
    ].join('\n'));
    return blocks.length ? fillPrompt(RESOLVER_ACCOUNTS, { accounts: blocks.join('\n\n') }) : '';
}

/** Принятая страница и сообщение пользователя после неё. */
export function lastExchange(chat) {
    const entries = (Array.isArray(chat) ? chat : []).filter(entry => !entry?.is_system);
    const lastUser = [...entries].reverse().find(entry => entry?.is_user === true);
    const page = [...entries].reverse().find(entry => entry?.is_user !== true && entries.indexOf(entry) < entries.indexOf(lastUser));
    return { page: text(page?.mes ?? page?.content), message: lastUser ? text(lastUser.mes ?? lastUser.content) : '' };
}

export function createSimulator({ call, banks, store, getSettings = () => ({}), publishEvent = () => {} }) {
    const settings = () => { try { return getSettings?.() ?? {}; } catch { return {}; } };
    const workerOf = value => text(value?.simulator?.workerId) || text(value?.decider?.workerId);

    /** Кого моделировать: присутствующие с банком (Указ или psyche), не пользователь; без ростера — Main Cast с Указом. */
    function people(state, event = '') {
        const filled = character => Object.values(character?.decree ?? {}).some(lines => Array.isArray(lines) && lines.some(line => text(line))) || (character?.psyche ?? []).length;
        const roster = (store?.roster?.().active ?? []).map(name => text(name).toLowerCase());
        const all = Object.values(state ?? {}).filter(character => character?.name && !isUserCharacter(character) && filled(character));
        // Без ростера (каст не сработал) — только главные, кого страница называет: важность не ставит человека в сцену.
        const page = text(event).toLowerCase();
        const named = character => [character.name, ...(character.aliases ?? [])].map(name => text(name).toLowerCase()).filter(Boolean)
            .some(name => page.includes(name) || page.includes(name.split(/\s+/)[0]));
        const here = roster.length ? all.filter(character => roster.includes(character.name.toLowerCase())) : all.filter(character => character.importance === 'main' && named(character));
        return here.slice(0, Math.max(1, Number(settings().simulator?.maxPeople) || 3));
    }

    async function one(character, { event, now, rpNow, user, signal }) {
        const name = character.name;
        const kind = text(character.kind) === 'mind' ? 'mind' : 'person';
        const messages = [
            { role: 'system', content: fillPrompt(promptText(SIMULATOR_SYSTEM), { name, kind, language: 'the language of the story' }) },
            { role: 'system', content: personBlock(character, { now, rpNow, user }) },
            { role: 'user', content: fillPrompt(SIMULATOR_TASK, { name, event }) },
        ];
        const workerId = workerOf(settings());
        const base = { purpose: 'simulator', workerId, stream: false, returnMessage: true, maxTokens: MAX_TOKENS, temperature: 0.7, signal };
        const account = argsOf(await call('model.generate', { ...base, messages, tools: [accountTool(name, kind)], toolChoice: { type: 'function', function: { name: 'account' } } }));
        if (!text(account.does) && !text(account.took)) throw new Error(`no account for ${name}`);
        // Флэш пишет «отвечает» в does и оставляет says пустым: один дозапрос самих слов.
        if (!text(account.says) && SPEAKS.test(`${text(account.does)}`)) {
            const words = argsOf(await call('model.generate', {
                ...base, maxTokens: 1500, tools: [WORDS_TOOL], toolChoice: { type: 'function', function: { name: 'words' } },
                messages: [...messages, { role: 'assistant', content: `does: ${text(account.does)}` }, { role: 'user', content: `In what ${name} does, ${name} speaks. Give the words exactly as they leave ${name}'s mouth, and to whom.` }],
            }).catch(() => null));
            if (text(words.says)) account.says = words.says;
        }
        return { name, account };
    }

    /**
     * Отчёты на этот ход. `event` — принятая страница прошлого хода и сообщение пользователя. Сбой одного человека —
     * он «продолжает своё», ход не держит. Отчёты ложатся в `moments` их банков.
     */
    async function accountsFor({ chat = [], signal = null } = {}) {
        const great = banks?.great;
        if (!great?.load) return [];
        const state = await great.load().catch(() => ({}));
        const user = Object.values(state).find(isUserCharacter)?.name || 'the user';
        const { page, message } = lastExchange(chat);
        const event = [page, message ? `Then ${user}: ${message}` : ''].filter(Boolean).join('\n\n');
        const list = people(state, event);
        if (!list.length) return [];
        const now = Number(great.clockMinutes?.()) || 0;
        const rpNow = (await great.rpNow?.().catch(() => null))?.value ?? 0;
        publishEvent('decision.simulator.started', { people: list.map(character => character.name) });
        const accounts = await Promise.all(list.map(character => one(character, { event, now, rpNow, user, signal })
            .catch(error => ({ name: character.name, account: { took: 'Nothing.', inner: '', does: 'Carries on.' }, error: error?.message ?? String(error) }))));
        await great.noteMoments?.(accounts.filter(item => !item.error).map(item => ({ name: item.name, account: item.account }))).catch(() => null);
        publishEvent('decision.simulator.finished', { accounts: accounts.map(item => ({ name: item.name, says: text(item.account?.says), does: text(item.account?.does), error: item.error ?? null })) });
        return accounts;
    }

    return { accountsFor, enabled: () => settings().simulator?.enabled !== false };
}
