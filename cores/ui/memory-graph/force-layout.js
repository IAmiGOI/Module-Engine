/**
 * Органическая раскладка одного региона — чистая функция, без DOM и Cytoscape, полностью детерминированная.
 *
 * Спираль Фогеля (`layoutRegion()`, layout.js) ставит ноды по порядку создания и вообще не смотрит на связи: у графа с двумя
 * героями, с которыми связан каждый факт, получалось пустое кольцо и рёбра через всю середину. Здесь позиции вытекают из СМЫСЛА:
 *
 *  1. Притяжение — не «одно ребро = одна пружина». Ребро к хабу (Core с десятками связей) почти ничего не говорит о ноде, поэтому
 *     его вес делится между всеми хабами ноды: факт только про Сашу тянется к Саше, факт про обоих — встаёт между ними. Рёбра между
 *     обычными нодами и рёбра событие↔факт — сильные. Плюс смысловые пружины: ближайшие по эмбедингу ноды тянутся друг к другу.
 *  2. Сообщества (распространение меток по связям без хабов) получают угловые сектора вокруг ядер — стартовая раскладка уже в виде
 *     «лепестков», а не случайного облака; дальше силовая симуляция с остыванием (пружины, отталкивание, гравитация к ядру,
 *     слабое стягивание к центру своего сообщества) доводит её до равновесия.
 *  3. Финальный проход разводит наложения жёстко (минимальное расстояние — как в `layoutRegion()`), затем раскладка поворачивается по
 *     главной оси (широкая сторона горизонтально) и центрируется — регион вписывается в круг минимального радиуса.
 *
 * Никакого `Math.random()`: любая «случайность» — хеш от id ноды, поэтому один и тот же граф всегда даёт ту же картинку.
 */

/** Силы раскладки — одним местом (экспортируется, чтобы подбирать числа на живых данных и в тестах). */
export const ORGANIC_TUNING = { repulsion: 0.1, gravity: 0.06, hubGravity: 0.18 };

const hashOf = text => { let hash = 2166136261; for (const ch of String(text)) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0; return hash; };
/** Детерминированное число в [0,1) из id и «соли». */
const unit = (id, salt) => (hashOf(`${salt}:${id}`) % 100000) / 100000;

const cosine = (a, b) => {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

const isEventNode = node => node.kind === 'event';
const isHubNode = node => !isEventNode(node) && Boolean(node.core || node.protectedNode);

/**
 * Пружины раскладки: реальные рёбра (с весами по смыслу, см. шапку) и смысловые (эмбединг). Возвращает `[{ a, b, weight, length }]`,
 * где a < b — индексы нод. `rest` — `(i, j) => минимальное расстояние`, длина пружины — доля от него.
 */
function buildSprings(nodes, index, rest, isHub) {
    const pair = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const real = new Map(); // ключ пары → { a, b, count }
    nodes.forEach((node, i) => {
        for (const edge of node.edges ?? []) {
            const j = index.get(edge.to);
            if (j === undefined || j === i) continue;
            const key = pair(i, j);
            const entry = real.get(key) ?? { a: Math.min(i, j), b: Math.max(i, j), count: 0, chain: false };
            entry.count += 1;
            if (edge.type === 'next') entry.chain = true;
            real.set(key, entry);
        }
    });

    // Сколько разных хабов у каждой не-хаб ноды — вес рёбер к хабам делится поровну.
    const hubNeighbours = nodes.map(() => 0);
    for (const { a, b } of real.values()) {
        if (isHub[a] && !isHub[b]) hubNeighbours[b] += 1;
        else if (isHub[b] && !isHub[a]) hubNeighbours[a] += 1;
    }
    // Локальная степень без хабов — глушит связи «толстых» не-хабов (чтобы одна нода-коллектор не стягивала всё).
    const plainDegree = nodes.map(() => 0);
    for (const { a, b } of real.values()) if (!isHub[a] && !isHub[b]) { plainDegree[a] += 1; plainDegree[b] += 1; }

    const springs = [];
    for (const { a, b, count, chain } of real.values()) {
        const hubSide = isHub[a] || isHub[b];
        const eventSide = isEventNode(nodes[a]) || isEventNode(nodes[b]);
        let weight;
        let length;
        if (isHub[a] && isHub[b]) { weight = 0.25; length = 1.9; }
        else if (hubSide) {
            const other = isHub[a] ? b : a;
            weight = (eventSide ? 0.28 : 0.5) / Math.max(1, hubNeighbours[other]);
            length = 1.55;
        } else {
            const crowd = Math.max(plainDegree[a], plainDegree[b]);
            weight = Math.min(1.4, (1 + 0.2 * (count - 1)) * Math.max(0.35, 4 / Math.max(4, crowd)));
            length = eventSide ? 1.05 : 1.25;
            if (chain) { weight = Math.max(weight, 0.9); length = 1.35; } // цепочка событий — ровная линия времени
        }
        springs.push({ a, b, weight, length: length * rest(a, b) });
    }

    // Смысловые пружины: у каждой не-хаб ноды с эмбедингом — до 3 ближайших, если сходство заметно выше типичного.
    const semantic = [];
    const withVector = nodes.map((node, i) => (!isHub[i] && Array.isArray(node.embedding) && node.embedding.length ? i : -1)).filter(i => i >= 0);
    if (withVector.length >= 4) {
        const sims = new Map();
        const all = [];
        for (let x = 0; x < withVector.length; x += 1) for (let y = x + 1; y < withVector.length; y += 1) {
            const value = cosine(nodes[withVector[x]].embedding, nodes[withVector[y]].embedding);
            sims.set(pair(withVector[x], withVector[y]), value);
            all.push(value);
        }
        const mean = all.reduce((sum, value) => sum + value, 0) / all.length;
        const std = Math.sqrt(all.reduce((sum, value) => sum + (value - mean) ** 2, 0) / all.length) || 1e-9;
        const taken = new Set();
        for (const i of withVector) {
            const ranked = withVector.filter(j => j !== i)
                .map(j => ({ j, value: sims.get(pair(i, j)) }))
                .filter(item => item.value >= mean + 0.6 * std)
                .sort((p, q) => q.value - p.value || p.j - q.j)
                .slice(0, 3);
            for (const { j, value } of ranked) {
                const key = pair(i, j);
                if (taken.has(key)) continue;
                taken.add(key);
                const strength = Math.min(1, (value - mean) / (3 * std));
                semantic.push({ a: Math.min(i, j), b: Math.max(i, j), weight: 0.12 + 0.26 * strength, length: 1.9 * rest(i, j) });
            }
        }
    }
    return { springs, semantic };
}

/** Сообщества — распространение меток по пружинам без хабов; ничьи решает наименьшая метка, обход в порядке индексов (детерминированно). */
function findCommunities(count, springs, isHub) {
    const label = Array.from({ length: count }, (_, i) => i);
    const adjacent = Array.from({ length: count }, () => []);
    for (const { a, b, weight } of springs) if (!isHub[a] && !isHub[b]) { adjacent[a].push([b, weight]); adjacent[b].push([a, weight]); }
    for (let round = 0; round < 14; round += 1) {
        let changed = false;
        for (let i = 0; i < count; i += 1) {
            if (isHub[i] || !adjacent[i].length) continue;
            const score = new Map();
            for (const [j, weight] of adjacent[i]) score.set(label[j], (score.get(label[j]) ?? 0) + weight);
            let best = label[i];
            let bestScore = score.get(label[i]) ?? 0;
            for (const [candidate, value] of score) if (value > bestScore + 1e-9 || (Math.abs(value - bestScore) <= 1e-9 && candidate < best)) { best = candidate; bestScore = value; }
            if (best !== label[i]) { label[i] = best; changed = true; }
        }
        if (!changed) break;
    }
    return label;
}

/**
 * `members` — ноды региона (и его события): `{ id, edges, embedding?, kind?, core?, protectedNode?, importance?, createdAt? }`.
 * `radiusOf(node)`/`minDistance(rA, rB)` — те же правила размера и зазора, что у спирали (layout.js). Возвращает
 * `{ positions: Map(id → {x,y}), radius }` — позиции относительно центра региона (0,0), `radius` — радиус описанного круга.
 */
export function organicRegionLayout(members, { centerId = null, radiusOf, minDistance, iterations = null } = {}) {
    const nodes = [...members].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const count = nodes.length;
    const positions = new Map();
    if (!count) return { positions, radius: 0 };
    const radii = nodes.map(radiusOf);
    if (count === 1) { positions.set(nodes[0].id, { x: 0, y: 0 }); return { positions, radius: radii[0] }; }

    const index = new Map(nodes.map((node, i) => [node.id, i]));
    const isHub = nodes.map(isHubNode);
    const rest = (i, j) => minDistance(radii[i], radii[j]);
    const { springs, semantic } = buildSprings(nodes, index, rest, isHub);
    const links = [...springs, ...semantic];
    const community = findCommunities(count, links, isHub);

    // --- Стартовая раскладка: ядра — в центре, сообщества — угловыми секторами вокруг -------------------------------------------
    const x = new Float64Array(count);
    const y = new Float64Array(count);
    const averageSpacing = nodes.reduce((sum, _node, i) => sum + minDistance(radii[i], radii[i]), 0) / count;
    const fieldRadius = Math.sqrt(count) * averageSpacing * 0.62;
    const hubs = nodes.map((_n, i) => i).filter(i => isHub[i]);
    const mainHub = hubs.find(i => nodes[i].id === centerId) ?? hubs[0] ?? -1;
    const others = hubs.filter(i => i !== mainHub);
    others.forEach((i, k) => {
        const angle = (2 * Math.PI * k) / others.length + 0.4;
        const distance = rest(mainHub, i) * 1.15;
        x[i] = Math.cos(angle) * distance;
        y[i] = Math.sin(angle) * distance;
    });

    const groups = new Map();
    nodes.forEach((_n, i) => { if (!isHub[i] && !isEventNode(nodes[i])) { if (!groups.has(community[i])) groups.set(community[i], []); groups.get(community[i]).push(i); } });
    const ordered = [...groups.values()].sort((a, b) => b.length - a.length || a[0] - b[0]);
    const totalPlain = ordered.reduce((sum, group) => sum + group.length, 0) || 1;
    let cursor = -Math.PI / 2;
    const importanceOf = i => Math.max(0, Math.min(10, nodes[i].importance ?? 0));
    for (const group of ordered) {
        const span = (2 * Math.PI * group.length) / totalPlain;
        const members = [...group].sort((p, q) => importanceOf(q) - importanceOf(p) || p - q);
        members.forEach((i, k) => {
            const angle = cursor + span * ((k + 0.5) / members.length) + (unit(nodes[i].id, 'a') - 0.5) * span * 0.35;
            const depth = 0.4 + 0.6 * ((k + unit(nodes[i].id, 'r')) / members.length);
            const distance = fieldRadius * depth + averageSpacing * 0.6;
            x[i] = Math.cos(angle) * distance;
            y[i] = Math.sin(angle) * distance;
        });
        cursor += span;
    }
    // События — рядом со своими фактами (центр масс соседей без хабов), иначе между хабами.
    nodes.forEach((_n, i) => {
        if (!isEventNode(nodes[i])) return;
        let sx = 0, sy = 0, total = 0;
        for (const link of springs) {
            const j = link.a === i ? link.b : link.b === i ? link.a : -1;
            if (j < 0 || isEventNode(nodes[j])) continue;
            const w = isHub[j] ? 0.25 : 1;
            sx += x[j] * w; sy += y[j] * w; total += w;
        }
        const jitterAngle = unit(nodes[i].id, 'e') * 2 * Math.PI;
        x[i] = (total ? sx / total : 0) + Math.cos(jitterAngle) * averageSpacing * 0.5;
        y[i] = (total ? sy / total : 0) + Math.sin(jitterAngle) * averageSpacing * 0.5;
    });

    // --- Силовая симуляция с остыванием ----------------------------------------------------------------------------------------
    const steps = iterations ?? Math.max(120, Math.min(420, Math.round(24000 / count)));
    const fx = new Float64Array(count);
    const fy = new Float64Array(count);
    const cutoff = averageSpacing * 5;
    for (let step = 0; step < steps; step += 1) {
        const heat = Math.pow(1 - step / steps, 1.6) + 0.02;
        fx.fill(0); fy.fill(0);
        for (let i = 0; i < count; i += 1) for (let j = i + 1; j < count; j += 1) {
            let dx = x[i] - x[j];
            let dy = y[i] - y[j];
            let distance = Math.hypot(dx, dy);
            if (distance > cutoff) continue;
            if (distance < 1e-6) { dx = unit(nodes[i].id, 'd') - 0.5; dy = unit(nodes[j].id, 'd') - 0.5; distance = Math.hypot(dx, dy) || 1; }
            const want = rest(i, j);
            const push = (want * want) / Math.max(distance, want * 0.2) * ORGANIC_TUNING.repulsion;
            fx[i] += (dx / distance) * push; fy[i] += (dy / distance) * push;
            fx[j] -= (dx / distance) * push; fy[j] -= (dy / distance) * push;
        }
        for (const { a, b, weight, length } of links) {
            const dx = x[b] - x[a];
            const dy = y[b] - y[a];
            const distance = Math.hypot(dx, dy) || 1e-6;
            const pull = weight * (distance - length) * 0.5;
            fx[a] += (dx / distance) * pull; fy[a] += (dy / distance) * pull;
            fx[b] -= (dx / distance) * pull; fy[b] -= (dy / distance) * pull;
        }
        // Центры масс сообществ — слабое стягивание «лепестка» к самому себе.
        const sums = new Map();
        for (let i = 0; i < count; i += 1) {
            if (isHub[i]) continue;
            const entry = sums.get(community[i]) ?? { sx: 0, sy: 0, n: 0 };
            entry.sx += x[i]; entry.sy += y[i]; entry.n += 1;
            sums.set(community[i], entry);
        }
        for (let i = 0; i < count; i += 1) {
            const gravity = isHub[i] ? ORGANIC_TUNING.hubGravity : ORGANIC_TUNING.gravity;
            fx[i] -= x[i] * gravity; fy[i] -= y[i] * gravity;
            const entry = sums.get(community[i]);
            if (!isHub[i] && entry && entry.n > 2) { fx[i] += (entry.sx / entry.n - x[i]) * 0.04; fy[i] += (entry.sy / entry.n - y[i]) * 0.04; }
        }
        const maxMove = averageSpacing * 0.5 * heat + 0.2;
        for (let i = 0; i < count; i += 1) {
            if (i === mainHub) { x[i] = 0; y[i] = 0; continue; }
            const length = Math.hypot(fx[i], fy[i]);
            const scale = length > maxMove ? maxMove / length : 1;
            x[i] += fx[i] * scale * 0.6;
            y[i] += fy[i] * scale * 0.6;
        }
        // Мягкое разведение наложений прямо во время симуляции — чтобы к финалу почти ничего не оставалось.
        for (let i = 0; i < count; i += 1) for (let j = i + 1; j < count; j += 1) {
            const dx = x[i] - x[j];
            const dy = y[i] - y[j];
            const distance = Math.hypot(dx, dy) || 1e-6;
            const need = rest(i, j) * 0.92;
            if (distance >= need) continue;
            const shift = ((need - distance) / distance) * 0.25;
            const wi = i === mainHub ? 0 : 1;
            const wj = j === mainHub ? 0 : 1;
            const total = wi + wj || 1;
            x[i] += dx * shift * (wi / total) * 2; y[i] += dy * shift * (wi / total) * 2;
            x[j] -= dx * shift * (wj / total) * 2; y[j] -= dy * shift * (wj / total) * 2;
        }
    }

    // --- Жёсткое разведение: гарантированный зазор (с запасом на округление до пикселя) ------------------------------------------
    for (let pass = 0; pass < 200; pass += 1) {
        let moved = false;
        for (let i = 0; i < count; i += 1) for (let j = i + 1; j < count; j += 1) {
            let dx = x[i] - x[j];
            let dy = y[i] - y[j];
            let distance = Math.hypot(dx, dy);
            const need = rest(i, j) + 1.5;
            if (distance >= need) continue;
            if (distance < 1e-6) { dx = unit(nodes[i].id, 'h') - 0.5; dy = unit(nodes[j].id, 'h') - 0.5; distance = Math.hypot(dx, dy) || 1; }
            const push = (need - distance) / 2 + 0.01;
            const wi = i === mainHub ? 0 : 1;
            const wj = j === mainHub ? 0 : 1;
            const total = wi + wj || 1;
            x[i] += (dx / distance) * push * 2 * (wi / total); y[i] += (dy / distance) * push * 2 * (wi / total);
            x[j] -= (dx / distance) * push * 2 * (wj / total); y[j] -= (dy / distance) * push * 2 * (wj / total);
            moved = true;
        }
        if (!moved) break;
    }

    // --- Поворот по главной оси и центрирование --------------------------------------------------------------------------------
    let cx = 0, cy = 0;
    for (let i = 0; i < count; i += 1) { cx += x[i]; cy += y[i]; }
    cx /= count; cy /= count;
    let sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < count; i += 1) { const dx = x[i] - cx; const dy = y[i] - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const cos = Math.cos(-theta);
    const sin = Math.sin(-theta);
    let radius = 0;
    nodes.forEach((node, i) => {
        const dx = x[i] - cx;
        const dy = y[i] - cy;
        const point = { x: Math.round(dx * cos - dy * sin), y: Math.round(dx * sin + dy * cos) };
        positions.set(node.id, point);
        radius = Math.max(radius, Math.hypot(point.x, point.y) + radii[i]);
    });
    return { positions, radius };
}
