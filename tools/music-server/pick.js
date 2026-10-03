/**
 * Выбор трека на сервере: ME присылает вектор сцены, сервер сам решает — играть другой трек, оставить текущий или промолчать. Это та же логика, что была у ME
 * (`libraries/core/track-selection.js`: косинус → порог → кластер близких → взвешенный выбор `1/(играно+1)` → гистерезис), только теперь её единственный владелец — сервер.
 * Чистые функции без сети и диска; случайность подаётся снаружи (для тестов).
 */

export const PICK_DEFAULTS = Object.freeze({ minSimilarity: 0.55, switchMargin: 0.05, closeMargin: 0.04 });
/** Мало разных векторов в разделе — вычитать среднее нельзя (вектор схлопнется), считаем по-старому: сырым косинусом. */
export const MIN_FOR_CENTERING = 3;
export const MIN_PLAUSIBLE_COSINE = 0.5;
/** Словарь эталонных сцен: группа участвует, если у неё не меньше `MIN_EXAMPLES` эталонов; оценка = среднее `TOP_EXAMPLES` ближайших; в итоге `PROTO_WEIGHT` веса у словаря, остальное у тега. */
export const MIN_EXAMPLES = 3, TOP_EXAMPLES = 3, PROTO_WEIGHT = 0.6;
/** Единицы относительной шкалы: «планка» = ползунок × 2 стандартных отклонения, «заметно лучше» = ползунок × 10, «близкие» — в пределах 0.35 от лучшего. */
const Z_FLOOR_SCALE = 2, Z_MARGIN_SCALE = 10, Z_CLOSE = 0.35;
const VETOED = -1e12;
/** Допуск отсечения по тегу «не включать»: нежелательное должно быть ближе к сцене, чем обычный тег, не менее чем на столько (косинусы тегов отличаются на сотые). */
export const NEGATIVE_MARGIN = 0;

/** Время (владелец: «как в кино» — музыка не дёргается): раньше `minDwell` секунд трек не меняется; пока до конца дальше `nearEnd` секунд, нужен в `midTrackFactor` раз более явный сдвиг сцены. */
export const TIMING = Object.freeze({ minDwell: 60, nearEnd: 40, midTrackFactor: 2.5 });
/** Jev (умный выбор): запрос идёт только когда смена трека уже назрела; спрашиваем про `SHORTLIST` лучших по вектору категорий. */
export const SHORTLIST = 6;
const JEV_WEIGHT_Z = 0.15, JEV_MIN_CHANCE = 0.3, INTENSITY_PENALTY = 0.15, INTENSITY_SMOOTHING = 0.4;
/** Три утверждения о накале сцены: Jev оценивает каждое, из ответов выводится уровень 1…3 (ось интенсивности). */
export const INTENSITY_STATEMENTS = Object.freeze([
    'The scene is calm, quiet and low-stakes.',
    'The scene has moderate tension or emotion.',
    'The scene is intense, high-stakes or at a climax.',
]);

export function similarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i += 1) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Взвешенный выбор: ни разу не игравший трек вдвое вероятнее сыгранного однажды. */
export function pickWeighted(items, plays, randomFn = Math.random) {
    if (!items.length) return null;
    const weights = items.map(item => 1 / ((plays.get(item.id) ?? 0) + 1));
    let roll = randomFn() * weights.reduce((sum, weight) => sum + weight, 0);
    for (let i = 0; i < items.length; i += 1) {
        roll -= weights[i];
        if (roll <= 0) return items[i];
    }
    return items[items.length - 1];
}

const clamp = (value, min, max, fallback) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback);
export const validVector = (vector, dim) => Array.isArray(vector) && vector.length === dim && vector.every(Number.isFinite);

const subtract = (a, b) => a.map((x, i) => x - b[i]);

/**
 * Оценка каждого трека для сцены. Эмбеддинги E5 дают любым двум английским текстам косинус 0.75–0.90, поэтому «сырая» шкала почти не различает треки.
 * Лекарство без модели:
 *  1. центрирование — из сцены и треков вычитается средний вектор раздела: общая для всех часть уходит, остаются различия;
 *  2. относительная шкала — центрированный косинус переводится в z-оценку среди кандидатов (на сколько отклонений трек лучше среднего).
 * Меньше `MIN_FOR_CENTERING` разных векторов (в групповом разделе считаются группы) — честно считаем сырым косинусом, как раньше.
 * Возвращает `{ relative, rows: [{ item, cosine, value }] }`: `value` — то, по чему принимаются решения.
 */
/**
 * Склонность тега «не включать» у каждой группы своя: у многих он ближе к любой бытовой сцене, чем сам обычный тег (на живых данных разрыв +0.03…+0.1 на несвязанных
 * сценах). Поэтому разрыв на сцене сравнивается с обычным разрывом ЭТОЙ группы на других тегах раздела (они служат пробными «сценами»): отсекаем, только если здесь он
 * заметно больше обычного (`NEGATIVE_Z` стандартных отклонений). Мало пробных тегов или нет разброса — смотрим просто на знак разрыва.
 */
export const NEGATIVE_Z = 0.5;
function gapBaseline(item, items) {
    const probes = new Map();
    for (const other of items) if ((other.group ?? other.id) !== (item.group ?? item.id)) probes.set(other.group ?? other.id, other.vector);
    const gaps = [...probes.values()].map(probe => similarity(probe, item.negVector) - similarity(probe, item.vector));
    if (gaps.length < MIN_FOR_CENTERING) return null;
    const mean = gaps.reduce((sum, x) => sum + x, 0) / gaps.length;
    const deviation = Math.sqrt(gaps.reduce((sum, x) => sum + (x - mean) ** 2, 0) / gaps.length);
    return deviation > 1e-6 ? { mean, deviation } : null;
}

/** Группа → z-оценка близости сцены к её эталонным сценам; `null`, если словарь слишком мал для шкалы (меньше трёх групп с эталонами). */
const topMean = (list, vector) => {
    const top = list.map(example => similarity(vector, example)).sort((a, b) => b - a).slice(0, TOP_EXAMPLES);
    return top.reduce((sum, x) => sum + x, 0) / top.length;
};
/**
 * Большая группа с разнородными эталонами «в среднем» ближе к любой сцене (больше шансов найти похожую) — так 98 эталонов «шуток» перетягивали настороженную сцену.
 * Поправка: близость к группе сравниваем с тем, как к ней обычно близки сцены ДРУГИХ групп (до `PROBES` эталонов из чужих групп); оценка — на сколько эта сцена необычно близка именно к ней.
 */
const PROBES = 80, MIN_PROBES = 6, MIN_PROBE_SPREAD = 0.005;
function groupBaseline(key, usable) {
    const foreign = [];
    for (const [other, list] of usable) if (other !== key) foreign.push(...list);
    if (foreign.length < MIN_PROBES) return null;
    const step = Math.max(1, Math.floor(foreign.length / PROBES));
    const own = usable.get(key);
    const values = [];
    for (let i = 0; i < foreign.length; i += step) values.push(topMean(own, foreign[i]));
    const mean = values.reduce((sum, x) => sum + x, 0) / values.length;
    const spread = Math.sqrt(values.reduce((sum, x) => sum + (x - mean) ** 2, 0) / values.length);
    return { mean, spread: Math.max(spread, MIN_PROBE_SPREAD) };
}
function prototypeZ(prototypes, vector) {
    if (!(prototypes instanceof Map)) return null;
    const usable = new Map([...prototypes].filter(([, list]) => Array.isArray(list) && list.length >= MIN_EXAMPLES));
    const raw = new Map();
    for (const [key, list] of usable) {
        const score = topMean(list, vector);
        const base = groupBaseline(key, usable);
        raw.set(key, base ? (score - base.mean) / base.spread : score);
    }
    if (raw.size < MIN_FOR_CENTERING) return null;
    const values = [...raw.values()];
    const average = values.reduce((sum, x) => sum + x, 0) / values.length;
    const deviation = Math.sqrt(values.reduce((sum, x) => sum + (x - average) ** 2, 0) / values.length);
    return deviation > 1e-9 ? new Map([...raw].map(([key, score]) => [key, (score - average) / deviation])) : null;
}

export function scoreItems({ items, vector, prototypes = null }) {
    const unique = new Map(items.map(item => [item.group ?? item.id, item.vector]));
    const relative = unique.size >= MIN_FOR_CENTERING;
    if (!relative) {
        // Мало вариантов для шкалы: нежелательное «побеждает», только если сцена ближе к нему, чем к самому треку.
        return { relative, rows: items.map(item => {
            const cosine = similarity(vector, item.vector);
            const vetoed = Boolean(item.negVector) && similarity(vector, item.negVector) > cosine;
            return { item, cosine, value: vetoed ? VETOED : cosine, penalty: 0, vetoed };
        }) };
    }

    const unusual = (item, gap) => { const base = gapBaseline(item, items); return base ? (gap - base.mean) / base.deviation >= NEGATIVE_Z : true; };
    const vectors = [...unique.values()];
    const mean = vectors[0].map((_, i) => vectors.reduce((sum, v) => sum + v[i], 0) / vectors.length);
    const scene = subtract(vector, mean);
    const centeredOf = new Map([...unique].map(([key, v]) => [key, similarity(scene, subtract(v, mean))]));
    const scores = [...centeredOf.values()];
    const average = scores.reduce((sum, x) => sum + x, 0) / scores.length;
    const deviation = Math.sqrt(scores.reduce((sum, x) => sum + (x - average) ** 2, 0) / scores.length);
    const zOf = score => (deviation > 1e-9 ? (score - average) / deviation : 0);
    const protoZ = prototypeZ(prototypes, vector);

    return {
        relative,
        rows: items.map(item => {
            const cosine = similarity(vector, item.vector);
            // «Когда НЕ включать»: трек отсекается, если сцена ближе к его нежелательному описанию, чем к обычному тегу ЭТОГО ЖЕ трека. Сравнение внутри одного трека,
            // на сырых косинусах — оба тега одного типа. (Сравнивать z-оценки разных семейств тегов нельзя: на живых данных это почти монетка и отсекало половину раздела.)
            const gap = item.negVector ? similarity(vector, item.negVector) - cosine : null;   // >0: нежелательное ближе обычного тега
            const vetoed = gap !== null && gap > 0 && unusual(item, gap);
            const tagZ = zOf(centeredOf.get(item.group ?? item.id));
            const proto = protoZ?.get(item.group ?? item.id) ?? null;   // у группы без эталонов решает один тег
            const blended = proto === null ? tagZ : (1 - PROTO_WEIGHT) * tagZ + PROTO_WEIGHT * proto;
            return { item, cosine, gap, proto, value: vetoed ? VETOED : blended, penalty: 0, vetoed };
        }),
    };
}

const keyOf = item => item.group ?? item.id;
const isChance = value => Number.isFinite(value) && value >= 0 && value <= 1;

/** Уровень накала сцены 1…3 из ответов Jev на `i0…i2`, сглаженный прошлым значением (музыка не прыгает по накалу). `null` — Jev не ответил. */
export function sceneIntensity(answers, lastIntensity = null) {
    const chances = [0, 1, 2].map(index => answers?.[`i${index}`]);
    if (!chances.every(isChance)) return null;
    const total = chances[0] + chances[1] + chances[2];
    if (total < 0.05) return null;
    const level = (chances[0] + 2 * chances[1] + 3 * chances[2]) / total;
    return Number.isFinite(lastIntensity) ? (1 - INTENSITY_SMOOTHING) * level + INTENSITY_SMOOTHING * lastIntensity : level;
}

/** Лучшие по вектору категории (группа или отдельный трек) без отсечённых: короткий список для Jev. */
function shortlistOf(rows) {
    const byKey = new Map();
    for (const row of rows) {
        if (row.vetoed) continue;
        const entry = byKey.get(keyOf(row.item)) ?? { key: keyOf(row.item), value: -Infinity, rows: [] };
        entry.value = Math.max(entry.value, row.value);
        entry.rows.push(row);
        byKey.set(entry.key, entry);
    }
    return [...byKey.values()].sort((a, b) => b.value - a.value).slice(0, SHORTLIST);
}

/** Вопросы для Jev: утверждение на каждую категорию из списка (`c0…`) и три утверждения о накале (`i0…`). */
export function buildQuestions(shortlist) {
    const questions = {};
    shortlist.forEach((entry, index) => { questions[`c${index}`] = `The scene fits this mood: ${entry.rows[0].item.statement}`; });
    INTENSITY_STATEMENTS.forEach((text, index) => { questions[`i${index}`] = text; });
    return questions;
}

/**
 * `items` — играющие треки раздела `{ id, ext, vector, group?, statement?, intensity? }` (в групповом разделе вектор — группы).
 * Ответ: `{ action: 'play', id, ext, similarity, intensity? }` | `{ action: 'keep' }` | `{ action: 'none' }` (ничего не выделяется, играющее продолжается)
 * | `{ action: 'ask', questions }` — только при `smart`: смена трека назрела, ME должен спросить Jev и повторить запрос с `answers`.
 *  - `ended` — трек доиграл: с вектором сцены выбор свободный (как будто ничего не играет, но тот же трек подряд не повторяется), без вектора — другой трек той же группы;
 *  - `force` — кнопка «следующий»: планка, гистерезис, время и Jev не действуют;
 *  - `elapsed` / `remaining` — сколько секунд играет и сколько осталось: раньше минуты музыка не меняется, а посреди трека меняется только при явном сдвиге сцены;
 *  - `answers` — ответы Jev (`c0…` вероятности категорий, `i0…` накал); `lastIntensity` — прежний накал для сглаживания.
 * `similarity` в ответе — сырой косинус (для показа), решения принимаются по `value` из `scoreItems`.
 */
export function pickTrack({ prototypes = null, minPlausibleCosine = MIN_PLAUSIBLE_COSINE, items, vector, dim, currentId = null, ended = false, force = false, minSimilarity, switchMargin, plays = new Map(), randomFn = Math.random, smart = false, answers = null, elapsed = null, remaining = null, lastIntensity = null }) {
    const current = items.find(item => item.id === currentId) ?? null;
    const asPlay = (item, score = null, extra = {}) => ({ action: 'play', id: item.id, ext: item.ext, similarity: score, ...extra });
    const others = list => (current && list.some(item => item.id !== current.id) ? list.filter(item => item.id !== current.id) : list);

    if (ended && !validVector(vector, dim)) {
        if (!current) return { action: 'none' };
        const siblings = current.group ? items.filter(item => item.group === current.group && item.id !== current.id) : [];
        return asPlay(pickWeighted(siblings, plays, randomFn) ?? current);
    }
    if (!validVector(vector, dim) || !items.length) return { action: 'none', reason: items.length ? 'bad vector' : 'empty' };

    const { relative, rows } = scoreItems({ items, vector, prototypes });
    // Относительная шкала всегда находит «лучшую» группу, даже для мусора; настоящий текст на E5 никогда не бывает так далёк от всех тегов сразу.
    if (Math.max(...rows.map(row => row.cosine)) < minPlausibleCosine) return { action: 'none', reason: 'implausible vector' };
    const free = force || ended;   // нечего удерживать: пользователь попросил или трек закончился
    const slider = clamp(minSimilarity, 0, 1, PICK_DEFAULTS.minSimilarity);
    const floor = force ? VETOED / 2 : relative ? slider * Z_FLOOR_SCALE : slider;
    const margin = clamp(switchMargin, 0, 0.5, PICK_DEFAULTS.switchMargin) * (relative ? Z_MARGIN_SCALE : 1);
    const closeMargin = relative ? Z_CLOSE : PICK_DEFAULTS.closeMargin;

    const passing = rows.filter(row => row.value >= floor);
    if (!passing.length) return { action: 'none' };
    const best = Math.max(...passing.map(row => row.value));
    const cluster = passing.filter(row => best - row.value <= closeMargin);
    const pool = free ? others(cluster.map(row => row.item)) : cluster.map(row => row.item);
    const chosen = pickWeighted(pool, plays, randomFn);
    const chosenRow = cluster.find(row => row.item === chosen);

    if (!free && current) {
        // Время: в первую минуту не меняем; посреди трека меняем только при явном сдвиге (в конце — обычный порог).
        if (Number.isFinite(elapsed) && elapsed < TIMING.minDwell) return { action: 'keep' };
        const needed = Number.isFinite(remaining) && remaining > TIMING.nearEnd ? margin * TIMING.midTrackFactor : margin;
        if (chosen.id === current.id) return { action: 'keep' };
        const currentRow = rows.find(row => row.item.id === current.id);
        if (chosenRow.value - currentRow.value < needed) return { action: 'keep' };
    }

    // Смена назрела. Умный режим: теперь (и только теперь) спрашиваем Jev про категорию сцены и её накал.
    if (smart && !force) {
        const shortlist = shortlistOf(rows);
        if (!answers) return { action: 'ask', questions: buildQuestions(shortlist) };
        const intensity = sceneIntensity(answers, lastIntensity);
        const scored = shortlist.map((entry, index) => {
            const chance = answers[`c${index}`];
            const declared = entry.rows[0].item.intensity;
            const penalty = intensity !== null && Number.isFinite(declared) ? INTENSITY_PENALTY * Math.abs(declared - intensity) : 0;
            return { entry, chance, final: isChance(chance) ? chance + (relative ? JEV_WEIGHT_Z * Math.max(-2, Math.min(3, entry.value)) : 0) - penalty : null };
        }).filter(item => item.final !== null);
        const top = scored.sort((a, b) => b.final - a.final)[0];
        // Jev ответил и уверен: берём его категорию. Не ответил / неуверен — остаётся выбор по вектору.
        if (top && top.chance >= JEV_MIN_CHANCE) {
            if (!ended && current && keyOf(current) === top.entry.key) return { action: 'keep', intensity };
            const candidates = top.entry.rows.map(row => row.item);
            const pick = pickWeighted(ended ? others(candidates) : candidates, plays, randomFn);
            return asPlay(pick, top.entry.rows.find(row => row.item === pick).cosine, { intensity });
        }
        return asPlay(chosen, chosenRow.cosine, { intensity });
    }
    return asPlay(chosen, chosenRow.cosine);
}
