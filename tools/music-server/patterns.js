import { scoreItems, pickWeighted, validVector, PICK_DEFAULTS, TIMING, Z_FLOOR_SCALE, Z_MARGIN_SCALE, clamp } from './pick.js';

/**
 * Паттерны — порядок проигрыша групп/треков, когда он уместен. Дерево: у паттернов общее начало, дальше любые ветки и под-ветки на любую глубину (узел = шаг,
 * `parent` — предыдущий шаг). Шаг — группа (играет её трек, как в обычном выборе: `1/(played+1)`) или конкретный трек. Те же треки остаются и в обычном выборе.
 *
 *  - ВХОД: корни дерева с тегом («когда уместно») вместе с обычными группами/треками оцениваются по одной шкале; корень входит в игру, если он заметно лучше всего
 *    обычного (и лучше играющего — по тем же правилам времени, что и смена трека);
 *  - ХОД: пока паттерн активен, сцена выбирает только между ВЕТКАМИ развилки; трек доиграл (`ended`) или нажали «следующий» — играет следующий шаг;
 *  - ВЫХОД: ветка кончилась, сцена не подходит ни одной ветке, или сцена резко сменилась (так же явно, как для смены трека посреди трека) — снова обычный выбор.
 *
 * Сервер без состояния: ME возвращает `pattern` (id узла, который играет) из прошлого ответа.
 */

const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id));
const childrenOf = (nodes, parent) => nodes.filter(node => (node.parent ?? null) === parent).sort(byOrder);
const tagged = (node, dim) => validVector(node.vector, dim);
const floorOf = (relative, minSimilarity) => { const slider = clamp(minSimilarity, 0, 1, PICK_DEFAULTS.minSimilarity); return relative ? slider * Z_FLOOR_SCALE : slider; };
const marginOf = (relative, switchMargin) => clamp(switchMargin, 0, 0.5, PICK_DEFAULTS.switchMargin) * (relative ? Z_MARGIN_SCALE : 1);
const asItem = (node, id = node.id) => ({ id, group: null, vector: node.vector, negVector: node.negVector ?? null, nodeId: node.id });

/** Какой трек играет на этом шаге: шаг-трек — он сам, шаг-группа — трек группы по ротации (не тот же подряд, если есть другие). `null` — играть нечего. */
export function resolveStep(node, { tracks, currentId = null, plays = new Map(), randomFn = Math.random }) {
    const pool = node.kind === 'track' ? tracks.filter(item => item.id === node.ref) : tracks.filter(item => item.group === node.ref);
    if (!pool.length) return null;
    const others = pool.filter(item => item.id !== currentId);
    return pickWeighted(others.length ? others : pool, plays, randomFn);
}

const played = (node, track, similarity = null) => ({ action: 'play', id: track.id, ext: track.ext, similarity, pattern: node.id });

/** Оценки входа: корни с тегом и обычные группы/треки по одной шкале (общее для решения и для объяснения владельцу). */
function entryScores({ nodes, items, vector, dim, minSimilarity, prototypes }) {
    const roots = childrenOf(nodes, null).filter(node => tagged(node, dim));
    if (!roots.length || !validVector(vector, dim)) return null;
    const { relative, rows } = scoreItems({ items: [...items, ...roots.map(node => asItem(node, `pattern:${node.id}`))], vector, prototypes });
    const floor = floorOf(relative, minSimilarity);
    const entries = rows.filter(row => row.item.nodeId && !row.vetoed).sort((a, b) => b.value - a.value);
    const regular = rows.filter(row => !row.item.nodeId && !row.vetoed);
    const regularBest = regular.length ? Math.max(...regular.map(row => row.value)) : -Infinity;
    return { relative, rows, floor, entries, regularBest };
}

/** Вход в паттерн: лучший корень с тегом, если он заметно лучше обычных вариантов (и играющего — когда оно играет). `null` — входить не стоит. */
export function findEntry({ nodes, items, vector, dim, currentId = null, ended = false, minSimilarity, switchMargin, prototypes = null, elapsed = null, remaining = null }) {
    const scored = entryScores({ nodes, items, vector, dim, minSimilarity, prototypes });
    if (!scored) return null;
    const { relative, rows, floor, entries, regularBest } = scored;
    const passing = entries.filter(row => row.value >= floor);
    if (!passing.length) return null;
    const best = passing[0];
    if (best.value <= regularBest) return null;
    const current = currentId ? rows.find(row => row.item.id === currentId) : null;
    if (current && !ended) {
        if (Number.isFinite(elapsed) && elapsed < TIMING.minDwell) return null;
        const needed = marginOf(relative, switchMargin) * (Number.isFinite(remaining) && remaining > TIMING.nearEnd ? TIMING.midTrackFactor : 1);
        if (best.value - current.value < needed) return null;
    }
    return { node: best.item.nodeId && nodes.find(node => node.id === best.item.nodeId), cosine: best.cosine };
}

/** Следующий шаг после `node`: единственная ветка — она; развилка — по тегам веток и сцене (не подходит ни одна — паттерн кончился). `null` — шагов дальше нет. */
export function nextStep({ nodes, node, vector, dim, minSimilarity, prototypes = null, plays = new Map(), randomFn = Math.random }) {
    const children = childrenOf(nodes, node.id);
    if (!children.length) return null;
    if (children.length === 1) return { node: children[0], cosine: null };
    const withTag = validVector(vector, dim) ? children.filter(child => tagged(child, dim)) : [];
    if (withTag.length) {
        const { relative, rows } = scoreItems({ items: withTag.map(child => asItem(child)), vector, prototypes });
        const floor = floorOf(relative, minSimilarity);
        const passing = rows.filter(row => !row.vetoed && row.value >= floor).sort((a, b) => b.value - a.value);
        if (passing.length) return { node: children.find(child => child.id === passing[0].item.id), cosine: passing[0].cosine };
    }
    const open = children.filter(child => !tagged(child, dim));   // ветки без тега годятся «по умолчанию», когда ни одна с тегом не подошла
    if (!open.length && validVector(vector, dim) && withTag.length) return null;   // сцена не подходит ни одной ветке
    const chosen = pickWeighted((open.length ? open : children).map(child => ({ id: child.id })), plays, randomFn);
    return chosen && { node: children.find(child => child.id === chosen.id), cosine: null };
}

/** Резкая смена сцены посреди паттерна: обычный выбор нашёл вариант заметно выше планки — как посреди трека (`midTrackFactor`). */
export function sceneBreaksPattern({ items, vector, dim, minSimilarity, switchMargin, prototypes = null, elapsed = null }) {
    if (!validVector(vector, dim) || !items.length) return false;
    if (Number.isFinite(elapsed) && elapsed < TIMING.minDwell) return false;
    const { relative, rows } = scoreItems({ items, vector, prototypes });
    const best = Math.max(...rows.filter(row => !row.vetoed).map(row => row.value), -Infinity);
    return best >= floorOf(relative, minSimilarity) + marginOf(relative, switchMargin) * TIMING.midTrackFactor;
}

/**
 * Решение паттернов для запроса `pick`: готовый ответ или `null` (решает обычный выбор).
 * `patternId` — узел, который играет сейчас (из прошлого ответа); чужой/удалённый id считается «паттерна нет».
 */
export function decidePattern({ nodes, patternId = null, tracks, items, vector, dim, currentId = null, ended = false, force = false, minSimilarity, switchMargin, prototypes = null, plays = new Map(), randomFn = Math.random, elapsed = null, remaining = null }) {
    if (!nodes.length) return null;
    const active = patternId ? nodes.find(node => node.id === patternId) : null;
    if (active) {
        if (ended || force) {
            const step = nextStep({ nodes, node: active, vector, dim, minSimilarity, prototypes, plays, randomFn });
            const track = step && resolveStep(step.node, { tracks, currentId, plays, randomFn });
            return track ? played(step.node, track, step.cosine) : null;   // ветка кончилась — обычный выбор
        }
        return sceneBreaksPattern({ items, vector, dim, minSimilarity, switchMargin, prototypes, elapsed }) ? null : { action: 'keep', pattern: active.id };
    }
    if (force) return null;   // «следующий» по кнопке паттернов не начинает
    const entry = findEntry({ nodes, items, vector, dim, currentId, ended, minSimilarity, switchMargin, prototypes, elapsed, remaining });
    const track = entry?.node && resolveStep(entry.node, { tracks, currentId, plays, randomFn });
    return track ? played(entry.node, track, entry.cosine) : null;
}

/**
 * Для владельца: что сделает паттерн на ЭТОЙ сцене (проверка на консоли). Вход считается так же, как в бою (без времени проигрывания: сцена проверяется «с нуля»),
 * дальше сцена ведёт по веткам развилок до конца паттерна или до места, где ни одна ветка не подошла. Ничего не меняет.
 * `{ entered, entry: { ranking, floor, regularBest }, path: [nodeId], forks: [{ nodeId, ranking: [{ id, value, passes, chosen }] }], stopped }`
 */
export function explainPatterns({ nodes, items, vector, dim, minSimilarity, switchMargin, prototypes = null }) {
    const scored = entryScores({ nodes, items, vector, dim, minSimilarity, prototypes });
    if (!scored) return { entered: false, reason: nodes.some(node => !node.parent) ? 'no tagged start or no scene' : 'no patterns', entry: null, path: [], forks: [], stopped: null };
    const { floor, entries, regularBest } = scored;
    const entry = { ranking: entries.map(row => ({ id: row.item.nodeId, value: row.value, cosine: row.cosine, passes: row.value >= floor })), floor, regularBest: Number.isFinite(regularBest) ? regularBest : null };
    const first = findEntry({ nodes, items, vector, dim, ended: true, minSimilarity, switchMargin, prototypes });
    if (!first?.node) return { entered: false, reason: entries.some(row => row.value >= floor) ? 'ordinary groups fit better' : 'no start fits the scene', entry, path: [], forks: [], stopped: null };
    const path = [first.node.id], forks = [];
    let node = first.node, stopped = null;
    for (let guard = 0; guard < 200; guard += 1) {
        const children = childrenOf(nodes, node.id);
        if (!children.length) { stopped = 'end'; break; }
        if (children.length > 1) {
            const withTag = children.filter(child => tagged(child, dim));
            const rows = withTag.length ? scoreItems({ items: withTag.map(child => asItem(child)), vector, prototypes }) : null;
            const floorHere = rows ? floorOf(rows.relative, minSimilarity) : 0;
            forks.push({ nodeId: node.id, ranking: children.map(child => {
                const row = rows?.rows.find(item => item.item.id === child.id);
                return { id: child.id, value: row ? row.value : null, passes: row ? !row.vetoed && row.value >= floorHere : null, tagged: Boolean(row) };
            }) });
        }
        const step = nextStep({ nodes, node, vector, dim, minSimilarity, prototypes, plays: new Map(), randomFn: () => 0 });
        if (!step) { stopped = 'no branch fits'; break; }
        node = step.node; path.push(node.id);
        const fork = forks.at(-1);
        if (fork && fork.nodeId === path.at(-2)) { const mine = fork.ranking.find(item => item.id === node.id); if (mine) mine.chosen = true; }
    }
    return { entered: true, entry, path, forks, stopped };
}
