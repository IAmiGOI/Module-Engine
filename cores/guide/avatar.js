import { signal } from '../ui/reactive.js';
import { request } from '../../libraries/shared/request.js';
import { nextHealthStatus, tierFromHours, resolveAvatar, avatarFileFor, TIER_NAMES } from '../../libraries/core/guide-avatar.js';

/**
 * Живая обвязка над `libraries/core/guide-avatar.js` — держит то, что чистым функциям нужно как вход: накопленное время открытой
 * страницы (в настройках, переживает перезагрузку), здоровье воркеров ME (`model.workers.status.changed`, НЕ `activity-light` — тот
 * про текущий прогон генерации, а тут про сайдкары), последний СЫРОЙ ответ (для чиби по ключевым словам) и разблокировку neko
 * (чек-лист 4/4). Пересчитывает `url` — сигнал, который читает окно/виджет вместо статичного `DEFAULT_AVATAR_URL`.
 *
 * `chibiPoses` — задаёт владелец сам (`guide/chibi-poses.json`, пусто по умолчанию — чиби никогда не включится без его настройки).
 * `tierHours` — `[N, M]` часов на тир, дефолт ниже — трогать без опаски, это просто константа.
 *
 * Если файла для выбранного пути нет на диске (например, `neko-tier-3-topless.png` ещё не нарисован — «поставлю заглушку»), `<img>`
 * сам покажет битую картинку: откат на не-neko тир того же уровня — забота окна (`on:error`), не этого файла (он не трогает сеть).
 *
 * `onTierUp(tier)` — она САМА, первой, шлёт сообщение в чат в момент, когда накопленное время впервые пересекает порог нового тира
 * (2 = шорты, 3 = топлесс; текст — забота вызывающего, `guide/tier-messages.json`). Однократно: какой тир уже объявлен, хранится
 * рядом с накопленным временем и переживает перезагрузку — иначе она здоровалась бы заново на каждом тике.
 */

const NAMESPACE = 'core.guide';
export const BASE_URL = new URL('../../assets/guide-avatars/', import.meta.url).href;
/** Тир 2 после 10 часов накопленного открытого времени, тир 3 — после 25. Поменять — просто эти два числа. */
export const DEFAULT_TIER_HOURS = Object.freeze([10, 25]);
const TICK_MS = 30 * 1000;
const SAVE_DEBOUNCE_MS = 5000;
const STATE_KEY = 'avatarState';

export function createGuideAvatar(host, {
    now = () => Date.now(), tierHours = DEFAULT_TIER_HOURS, chibiPoses = () => [], getNekoUnlocked = async () => false,
    onTierUp = () => {}, schedule = setInterval, cancel = clearInterval, scheduleTimeout = setTimeout, cancelTimeout = clearTimeout,
} = {}) {
    const call = (contract, params) => request(host.own, contract, { params });
    const url = signal('');
    let usageMs = 0;
    let announcedTier = 1; // самый высокий тир, про который она уже сама написала — 1 никогда не объявляется, это стартовый вид
    let lastTickAt = null;
    let health = { down: false, recoveredAt: null, status: 'white' };
    let lastCoT = '';
    let nekoUnlocked = false;
    let tickTimer = null;
    let saveTimer = null;
    let unsubscribeWorkers = null;

    function fileFor(picked) {
        // neko запрошен, но файла может не быть (owner: "если лень — заглушка") — окно ловит on:error и само подставляет не-neko тир.
        return new URL(avatarFileFor(picked), BASE_URL).href;
    }

    function currentTier() {
        return tierFromHours(usageMs / 3_600_000, tierHours);
    }

    function recompute() {
        const picked = resolveAvatar({ health: health.status, lastCoT, chibiPoses: chibiPoses(), tier: currentTier(), nekoUnlocked });
        url.set(fileFor(picked));
    }

    /** Новый тир впервые достигнут → она сама шлёт сообщение (текст — забота вызывающего), один раз, запомнено на диске. */
    async function checkTierAnnouncement() {
        const tier = currentTier();
        if (tier <= announcedTier) return;
        for (let level = announcedTier + 1; level <= tier; level += 1) await onTierUp(level);
        announcedTier = tier;
        scheduleSave();
    }

    /** Тот же путь без neko-приставки — окно подставляет его, если `neko-tier-N-….png` не нашёлся (404). */
    function normalFallbackFor(currentUrl) {
        const name = decodeURIComponent(currentUrl.split('/').pop() ?? '');
        return name.startsWith('neko-') ? new URL(name.slice('neko-'.length), BASE_URL).href : null;
    }

    function scheduleSave() {
        if (saveTimer !== null) return;
        saveTimer = scheduleTimeout(() => {
            saveTimer = null;
            void call('storage.settings.set', { namespace: NAMESPACE, key: STATE_KEY, value: { usageMs: Math.round(usageMs), announcedTier } });
        }, SAVE_DEBOUNCE_MS);
    }

    async function pollWorkers() {
        const result = await call('model.workers.status');
        return result.ok && Array.isArray(result.value) ? result.value : [];
    }

    async function refreshHealth() {
        health = nextHealthStatus(health, { workers: await pollWorkers(), now: now() });
        recompute();
    }

    /** Раз в TICK_MS: копим открытое время, перечитываем чек-лист (может открыться неко), проверяем новый тир, и на всякий случай здоровье — зелёный сам гаснет по времени, без отдельного события. */
    async function tick() {
        const at = now();
        usageMs += at - (lastTickAt ?? at);
        lastTickAt = at;
        nekoUnlocked = await getNekoUnlocked();
        scheduleSave();
        await checkTierAnnouncement();
        await refreshHealth();
    }

    /** Вызывается ядром гида после каждого настоящего ответа модели — СЫРОЙ текст (думает + отвечает), до вырезания `<think>` (см. doc-comment библиотеки). */
    function noteReply(rawText) {
        lastCoT = String(rawText ?? '');
        recompute();
    }

    async function load() {
        const saved = await call('storage.settings.get', { namespace: NAMESPACE, key: STATE_KEY, fallback: null });
        const state = saved.ok && saved.value && typeof saved.value === 'object' ? saved.value : null;
        usageMs = Number(state?.usageMs) || 0;
        announcedTier = Number(state?.announcedTier) || 1;
        lastTickAt = now();
        nekoUnlocked = await getNekoUnlocked();
        await checkTierAnnouncement(); // на случай, если дебаунс сохранения оборвался ровно на пороге тира в прошлой сессии
        await refreshHealth();
        unsubscribeWorkers = host.events?.subscribe?.('model.workers.status.changed', () => { void refreshHealth(); });
        tickTimer = schedule(() => { void tick(); }, TICK_MS);
        tickTimer?.unref?.(); // тесты/сборка в node не должны виснуть на этом таймере
    }

    return {
        url, noteReply, load, normalFallbackFor,
        /** Для отладки/тестов: сколько накоплено и что сейчас видно по здоровью — не для прод-кода. */
        debugState: () => ({ usageMs, health: health.status, nekoUnlocked }),
        unregister: () => { if (tickTimer !== null) cancel(tickTimer); if (saveTimer !== null) cancelTimeout(saveTimer); unsubscribeWorkers?.(); },
    };
}
