/**
 * Подсказки по кешу префикса для разных провайдеров (PROMPT_MANAGER_PLAN.md, раздел 0 «Кеш префикса»; порядок внимания владельца:
 * OpenRouter → DeepSeek → Gemini → Z.AI → Claude → OpenAI). Числа — общеизвестные документированные минимумы на момент написания;
 * это подсказки, не гарантия: провайдеры меняют правила, поэтому тексты честно говорят «как правило».
 * Чистые функции.
 */
const PROVIDERS = {
    openrouter: { name: 'OpenRouter', minPrefixTokens: 1024, explicit: false, note: 'Caching depends on the model behind it. Automatic for OpenAI, DeepSeek, Gemini 2.5 and Grok families; Claude models need explicit cache markers, which this preset cannot add yet.' },
    deepseek: { name: 'DeepSeek', minPrefixTokens: 64, explicit: false, note: 'Automatic, works on the shared start of the request in 64-token steps. Any change early in the prompt loses everything after it.' },
    makersuite: { name: 'Gemini', minPrefixTokens: 1024, explicit: false, note: 'Implicit caching for Gemini 2.5 models; the shared start must be at least about 1024 tokens (2048 for Pro).' },
    zai: { name: 'Z.AI', minPrefixTokens: 1024, explicit: false, note: 'Automatic prefix caching; keep the start of the prompt stable.' },
    claude: { name: 'Claude', minPrefixTokens: 1024, explicit: true, note: 'Needs explicit cache markers on the stable part (at least 1024 tokens; 2048 for some models). Without markers there is no cache at all.' },
    openai: { name: 'OpenAI', minPrefixTokens: 1024, explicit: false, note: 'Automatic for prompts from 1024 tokens; the shared start is matched in 128-token steps.' },
};

const ALIASES = { google: 'makersuite', gemini: 'makersuite', vertexai: 'makersuite', anthropic: 'claude', 'z.ai': 'zai', 'custom': 'openai' };

export function providerInfo(source) {
    const key = String(source ?? '').toLowerCase();
    return PROVIDERS[ALIASES[key] ?? key] ?? null;
}

/**
 * Совет по последнему сравнению запросов (`compareRequests`): хватает ли общего начала для кеша выбранного провайдера и что мешает.
 * Возвращает { provider, verdict: 'good'|'short'|'broken'|'unknown', text }.
 */
export function cacheVerdict(source, comparison) {
    const provider = providerInfo(source);
    if (!comparison) return { provider, verdict: 'unknown', text: 'Send two requests in a row to see how much of the prompt can come from the cache.' };
    const shared = comparison.sharedTokens;
    const min = provider?.minPrefixTokens ?? 1024;
    const where = comparison.culprit ? ` The first change is in "${comparison.culprit.block}" (${comparison.culprit.reason}).` : '';
    if (provider?.explicit) return { provider, verdict: shared >= min ? 'short' : 'broken', text: `${provider.name} caches only marked parts, so the automatic ${shared} shared tokens do not count. ${provider.note}${where}` };
    if (shared < min) return { provider, verdict: 'broken', text: `Only ${shared} tokens are shared with the previous request, below the ${min} that ${provider?.name ?? 'most providers'} needs to cache.${where}` };
    const ratio = Math.round(comparison.ratio * 100);
    return { provider, verdict: ratio >= 80 ? 'good' : 'short', text: `${shared} tokens (${ratio}%) are shared with the previous request and can come from the ${provider?.name ?? 'provider'} cache.${ratio < 80 ? where : ''}` };
}

/** Сколько токенов провайдер взял из кеша — из блока `usage` ответа (разные формы у разных API). */
export function extractCachedTokens(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const candidates = [usage.prompt_tokens_details?.cached_tokens, usage.cached_tokens, usage.prompt_cache_hit_tokens, usage.cache_read_input_tokens, usage.cachedContentTokenCount];
    const found = candidates.find(value => Number.isFinite(value));
    return found ?? null;
}
