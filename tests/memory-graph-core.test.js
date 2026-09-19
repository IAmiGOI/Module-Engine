import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SECTORS, RINGS, DEFAULT_SETTINGS, clampGraphSettings,
    regionKey, allRegionCoords, regionAdjacency,
    computeRegionLogits, updateDistanceStats, stddevOf, isStrongChange,
    computeNodeWeight, pickConfidentRegion, decideFirstPlacement, decideStagingStep,
    pickEvictionCandidate, jaccardOverlap, findMergeCandidate, wordsOf,
    scoreBeaconCandidate, pickBeacons, findShortestPath, buildBeaconRoute, renderMemoryPrompt,
    gaussianRandom, expandNoiseNodes,
    importanceFromLorebookEntry, applyConnectionBonus,
    buildRegionSkeletonPrompt, parseRegionSkeletonResponse,
    buildAdditionalCentersPrompt, parseAdditionalCentersResponse,
    pickNearestRegion,
    buildRegionEdgesPrompt, parseRegionEdgesResponse,
    buildOrphanConnectionsPrompt, parseOrphanConnectionsResponse,
    scoreBeaconSet, shouldReplaceStickySet, RETRIEVAL_STABILITY_MARGINS,
    nearestEmbeddingDistance,
    buildSkeletonPartPrompt, buildCentersPartPrompt, parseCandidatesResponse, mergeCandidateGroups,
    trimCandidatesToBudget, buildSkeletonReducePrompt, buildCentersReducePrompt,
    assignBootstrapUids, entryTitle,
} from '../cores/memory-graph/index.js';

// --- Физика регионов --------------------------------------------------

test('allRegionCoords() produces exactly 5 sectors × 3 rings = 15 regions, no duplicates', () => {
    const coords = allRegionCoords();
    assert.equal(coords.length, SECTORS * RINGS);
    const keys = new Set(coords.map(c => regionKey(c.sector, c.ring)));
    assert.equal(keys.size, 15);
});

test('regionAdjacency() wraps around sectors (sector 4 neighbors sector 0) but never wraps rings', () => {
    const wrap = regionAdjacency(4, 1);
    assert.ok(wrap.some(n => n.sector === 0 && n.ring === 1), 'sector 4 must be adjacent to sector 0 (circular)');

    const innerRing = regionAdjacency(2, 0);
    assert.ok(!innerRing.some(n => n.ring === -1), 'ring 0 must not wrap to a negative ring');
    const outerRing = regionAdjacency(2, RINGS - 1);
    assert.ok(!outerRing.some(n => n.ring === RINGS), 'the outermost ring must not wrap past itself');
});

test('regionAdjacency() gives a middle ring exactly 4 neighbors (2 sectors + 2 rings), edge rings exactly 3', () => {
    assert.equal(regionAdjacency(2, 1).length, 4); // middle ring
    assert.equal(regionAdjacency(2, 0).length, 3); // inner ring, no ring -1
    assert.equal(regionAdjacency(2, RINGS - 1).length, 3); // outer ring, no ring beyond
});

test('regionAdjacency() never returns a region that does not touch it geometrically — a distant sector/ring never appears', () => {
    const neighbors = regionAdjacency(0, 0);
    assert.ok(!neighbors.some(n => n.sector === 2), 'sector 2 does not touch sector 0');
    assert.ok(!neighbors.some(n => n.ring === 2), 'ring 2 does not touch ring 0');
});

// --- Формула логитов региона (числовой пример из обсуждения с пользователем) ---

test('computeRegionLogits() reproduces the user\'s worked example: v=0.6/0.4/0.1, keyword matches 5/10/0, w=1 -> region 2 overtakes region 1, region 3 collapses', () => {
    const probs = computeRegionLogits([0.6, 0.4, 0.1], [5, 10, 0], 1);

    assert.ok(probs[1] > probs[0], 'region 2 (more keyword matches) must overtake region 1 despite lower vector prior');
    assert.ok(probs[2] < 0.05, 'region 3 (zero keyword matches) must collapse to near-zero');
    assert.ok(Math.abs(probs.reduce((a, b) => a + b, 0) - 1) < 1e-9, 'must be a real probability distribution');
});

test('computeRegionLogits() treats zero keyword matches as NEUTRAL (ln(1+0)=0), not a penalty — a region with no keyword activity is judged on its vector prior alone', () => {
    const withZeroEverywhere = computeRegionLogits([0.7, 0.3], [0, 0], 1);
    const pureVectorSoftmax = computeRegionLogits([0.7, 0.3], [0, 0], 0); // w=0 disables keyword entirely
    assert.ok(Math.abs(withZeroEverywhere[0] - pureVectorSoftmax[0]) < 1e-9, 'all-zero keyword counts must not shift the outcome at all vs. no keyword signal');
});

test('computeRegionLogits() lets keyword evidence flip a close vector call with only modest evidence, but a landslide needs much more', () => {
    const close = computeRegionLogits([0.51, 0.49], [0, 3], 1);
    assert.ok(close[1] > close[0], 'a close vector race must flip with just a few keyword matches');

    // The same modest evidence (3 matches) must NOT flip a landslide prior —
    // this is the actual "keyword only decides when vector is unsure" property.
    const landslideResists = computeRegionLogits([0.95, 0.05], [0, 3], 1);
    assert.ok(landslideResists[0] > landslideResists[1], 'a landslide vector prior must resist the SAME modest keyword evidence that flipped a close race');

    // Log-odds combination has no ceiling: given enough keyword evidence,
    // even a landslide prior CAN flip. Documented as real, intended behavior
    // (not a bug) — matches the design note that `w` needs empirical tuning.
    const landslideFlipsWithEnoughEvidence = computeRegionLogits([0.95, 0.05], [0, 20], 1);
    assert.ok(landslideFlipsWithEnoughEvidence[1] > landslideFlipsWithEnoughEvidence[0], 'with enough accumulated keyword evidence, even a landslide vector prior can flip — no artificial ceiling in the formula');
});

// --- Адаптивный порог "сильного изменения" -----------------------------

test('isStrongChange() treats the first two distances (no baseline yet) as ALWAYS strong — the graph must be able to bootstrap its first nodes', () => {
    assert.equal(isStrongChange(0.01, null, 1.5), true);
    assert.equal(isStrongChange(0.01, updateDistanceStats(null, 0.5), 1.5), true);
});

test('nearestEmbeddingDistance() is 1 minus the best REAL cosine — 0 for an identical vector, 1 for orthogonal, 1 with no candidates, never outside [0,1]', () => {
    assert.equal(nearestEmbeddingDistance([1, 0], [[0, 1], [1, 0]]), 0, 'the best candidate wins, not the first');
    assert.equal(nearestEmbeddingDistance([1, 0], [[0, 1]]), 1, 'orthogonal is distance 1');
    assert.equal(nearestEmbeddingDistance([1, 0], [[-1, 0]]), 1, 'an opposite vector must not push the distance past 1');
    assert.equal(nearestEmbeddingDistance([1, 0], []), 1, 'nothing to compare with means fully unknown');
    assert.equal(nearestEmbeddingDistance([1, 0], [null, undefined, [1, 0]]), 0, 'missing embeddings are skipped, not treated as a match');
    assert.ok(Math.abs(nearestEmbeddingDistance([1, 0], [[1, 1]]) - (1 - Math.SQRT1_2)) < 1e-9, 'a 45-degree candidate has cosine sqrt(1/2)');
});

test('updateDistanceStats()/stddevOf() compute a real running mean and stddev (Welford), matching a plain manual calculation', () => {
    const values = [0.2, 0.4, 0.3, 0.5, 0.1];
    let stats = null;
    for (const v of values) stats = updateDistanceStats(stats, v);

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);

    assert.ok(Math.abs(stats.mean - mean) < 1e-9);
    assert.ok(Math.abs(stddevOf(stats) - Math.sqrt(variance)) < 1e-9);
});

test('isStrongChange() adapts to the graph\'s own distance distribution — the same raw distance is "strong" in a tight-variance graph but routine in a wide-variance one', () => {
    let tight = null;
    for (const v of [0.10, 0.11, 0.09, 0.10, 0.11]) tight = updateDistanceStats(tight, v);
    let wide = null;
    for (const v of [0.05, 0.30, 0.15, 0.40, 0.10]) wide = updateDistanceStats(wide, v);

    const probeDistance = 0.20;
    assert.equal(isStrongChange(probeDistance, tight, 1.5), true, 'a 0.20 distance is way outside a tight [0.09-0.11] distribution');
    assert.equal(isStrongChange(probeDistance, wide, 1.5), false, 'the same 0.20 distance is unremarkable inside a wide, noisy distribution');
});

// --- Decay -------------------------------------------------------------

test('computeNodeWeight() returns Infinity for protected nodes regardless of elapsed time — protection means never decaying', () => {
    const weight = computeNodeWeight({ importance: 1, degree: 0, elapsed: 100000, protectedNode: true });
    assert.equal(weight, Infinity);
});

test('computeNodeWeight() decays toward zero as elapsed time grows, for an unprotected node', () => {
    const fresh = computeNodeWeight({ importance: 5, degree: 2, elapsed: 0 });
    const old = computeNodeWeight({ importance: 5, degree: 2, elapsed: 1000 });
    assert.ok(fresh > old, 'an old, unprotected node must weigh less than a fresh one with identical importance/degree');
    assert.ok(old >= 0, 'weight must never go negative');
});

test('computeNodeWeight() rewards higher degree (more connections) and higher importance, all else equal', () => {
    const base = computeNodeWeight({ importance: 1, degree: 0, elapsed: 5 });
    const moreConnected = computeNodeWeight({ importance: 1, degree: 10, elapsed: 5 });
    const moreImportant = computeNodeWeight({ importance: 10, degree: 0, elapsed: 5 });
    assert.ok(moreConnected > base);
    assert.ok(moreImportant > base);
});

// --- Каскад размещения ---------------------------------------------------

test('decideFirstPlacement() prioritizes a beacon match over everything else (Phase 2 hook, exercised here directly)', () => {
    const result = decideFirstPlacement({ beaconRegion: { sector: 1, ring: 1 }, nameMatchRegion: { sector: 3, ring: 0 }, regionProbs: [0.9, 0.1], regionCoords: [{ sector: 0, ring: 0 }, { sector: 1, ring: 1 }] });
    assert.deepEqual(result, { status: 'placed', region: { sector: 1, ring: 1 }, reason: 'beacon' });
});

test('decideFirstPlacement() falls to name-match when there is no beacon', () => {
    const result = decideFirstPlacement({ nameMatchRegion: { sector: 3, ring: 0 }, regionProbs: [0.9, 0.1], regionCoords: [{ sector: 0, ring: 0 }, { sector: 1, ring: 1 }] });
    assert.deepEqual(result, { status: 'placed', region: { sector: 3, ring: 0 }, reason: 'name-match' });
});

test('decideFirstPlacement() falls to a confident region-logit winner when there is no beacon or name-match', () => {
    const coords = [{ sector: 0, ring: 0 }, { sector: 1, ring: 1 }];
    const result = decideFirstPlacement({ regionProbs: [0.9, 0.1], regionCoords: coords });
    assert.deepEqual(result, { status: 'placed', region: coords[0], reason: 'region-logit' });
});

test('decideFirstPlacement() stages the node when no signal is confident — this is the fix for the "corrupt the centroid with a weak guess" risk raised earlier in design', () => {
    const coords = [{ sector: 0, ring: 0 }, { sector: 1, ring: 1 }];
    const result = decideFirstPlacement({ regionProbs: [0.55, 0.45], regionCoords: coords });
    assert.equal(result.status, 'staged');
});

test('decideFirstPlacement() seeds region 0:0 for a completely EMPTY graph even with a tied/uniform region distribution — a tie with zero region centers is not a "weak guess" worth protecting the centroid from, it is zero information, found live via a scenario test where every fresh graph got stuck staging its very first node forever', () => {
    const coords = [{ sector: 0, ring: 0 }, { sector: 1, ring: 1 }];
    const result = decideFirstPlacement({ regionProbs: [0.5, 0.5], regionCoords: coords, isEmptyGraph: true });
    assert.deepEqual(result, { status: 'placed', region: { sector: 0, ring: 0 }, reason: 'bootstrap-seed' });
});

test('decideFirstPlacement() does NOT apply the empty-graph seed once a confident region-logit winner exists, or when name-match/beacon already resolved it', () => {
    const coords = [{ sector: 0, ring: 0 }, { sector: 1, ring: 1 }];
    const confident = decideFirstPlacement({ regionProbs: [0.9, 0.1], regionCoords: coords, isEmptyGraph: true });
    assert.equal(confident.reason, 'region-logit', 'a real winner must still win, isEmptyGraph is only a LAST resort');

    const named = decideFirstPlacement({ nameMatchRegion: { sector: 1, ring: 1 }, regionProbs: [0.5, 0.5], regionCoords: coords, isEmptyGraph: true });
    assert.equal(named.reason, 'name-match');
});

test('decideStagingStep() keeps a first-attempt node WAITING before its scheduled retry turn — no re-check before turn 5', () => {
    const entry = { attemptCount: 1, firstAttemptTurn: 10 };
    const coords = [{ sector: 0, ring: 0 }, { sector: 1, ring: 1 }];
    const result = decideStagingStep({ entry, regionProbs: [0.55, 0.45], regionCoords: coords, settings: DEFAULT_SETTINGS, currentTurn: 12, poolSize: 1 });
    assert.equal(result.status, 'waiting');
});

test('decideStagingStep() signals retry-now once the scheduled +5-turn retry point is reached', () => {
    const entry = { attemptCount: 1, firstAttemptTurn: 10 };
    const coords = [{ sector: 0, ring: 0 }, { sector: 1, ring: 1 }];
    const result = decideStagingStep({ entry, regionProbs: [0.55, 0.45], regionCoords: coords, settings: DEFAULT_SETTINGS, currentTurn: 15, poolSize: 1 });
    assert.equal(result.status, 'retry-now');
});

test('decideStagingStep() places the node immediately if the retry finds a confident region — it does not wait out the rest of the schedule once resolved', () => {
    const entry = { attemptCount: 1, firstAttemptTurn: 10 };
    const coords = [{ sector: 0, ring: 0 }, { sector: 1, ring: 1 }];
    const result = decideStagingStep({ entry, regionProbs: [0.95, 0.05], regionCoords: coords, settings: DEFAULT_SETTINGS, currentTurn: 15, poolSize: 1 });
    assert.deepEqual(result, { status: 'placed', region: coords[0], reason: 'region-logit-retry' });
});

test('decideStagingStep() escalates to SideCar once a SECOND failed attempt accumulates a full batch, even before the 20-turn timeout', () => {
    const entry = { attemptCount: 2, firstAttemptTurn: 10 };
    const coords = [{ sector: 0, ring: 0 }, { sector: 1, ring: 1 }];
    const result = decideStagingStep({ entry, regionProbs: [0.55, 0.45], regionCoords: coords, settings: DEFAULT_SETTINGS, currentTurn: 16, poolSize: DEFAULT_SETTINGS.stagingBatchSize });
    assert.equal(result.status, 'escalate');
});

test('decideStagingStep() escalates on the 20-turn timeout even with a batch of just ONE straggler', () => {
    const entry = { attemptCount: 2, firstAttemptTurn: 10 };
    const coords = [{ sector: 0, ring: 0 }, { sector: 1, ring: 1 }];
    const timeoutTurn = 10 + DEFAULT_SETTINGS.stagingRetryTurns + DEFAULT_SETTINGS.stagingMaxTurns;
    const result = decideStagingStep({ entry, regionProbs: [0.55, 0.45], regionCoords: coords, settings: DEFAULT_SETTINGS, currentTurn: timeoutTurn, poolSize: 1 });
    assert.equal(result.status, 'escalate');
});

test('decideStagingStep() keeps waiting on a second failed attempt when neither the batch nor the timeout condition is met yet', () => {
    const entry = { attemptCount: 2, firstAttemptTurn: 10 };
    const coords = [{ sector: 0, ring: 0 }, { sector: 1, ring: 1 }];
    const result = decideStagingStep({ entry, regionProbs: [0.55, 0.45], regionCoords: coords, settings: DEFAULT_SETTINGS, currentTurn: 16, poolSize: 1 });
    assert.equal(result.status, 'waiting');
});

// --- Переполнение региона: вытеснение слабейшего --------------------------

test('pickEvictionCandidate() evicts the lowest-weight member, never a protected one', () => {
    const members = [
        { id: 'a', importance: 8, degree: 3, protectedNode: false, createdTurn: 0 },
        { id: 'weakest', importance: 0, degree: 0, protectedNode: false, createdTurn: 0 },
        { id: 'center', importance: 0, degree: 0, protectedNode: true, createdTurn: 0 },
    ];
    const victim = pickEvictionCandidate(members, { settings: DEFAULT_SETTINGS, turnCounter: 0 });
    assert.equal(victim, 'weakest');
});

test('pickEvictionCandidate() returns null when EVERY member is protected — nothing left to evict, a documented edge case, not a crash', () => {
    const members = [
        { id: 'a', protectedNode: true, createdTurn: 0 },
        { id: 'b', protectedNode: true, createdTurn: 0 },
    ];
    assert.equal(pickEvictionCandidate(members, { settings: DEFAULT_SETTINGS, turnCounter: 0 }), null);
});

test('pickEvictionCandidate() breaks a tie by evicting the OLDER member — first-seen-minimum, not last', () => {
    const members = [
        { id: 'older', importance: 0, degree: 0, protectedNode: false, createdTurn: 0 },
        { id: 'newer', importance: 0, degree: 0, protectedNode: false, createdTurn: 0 },
    ];
    assert.equal(pickEvictionCandidate(members, { settings: DEFAULT_SETTINGS, turnCounter: 5 }), 'older');
});

test('pickEvictionCandidate() lets elapsed time decay an old, once-important node below a fresher, more modest one', () => {
    const members = [
        { id: 'old-important', importance: 5, degree: 0, protectedNode: false, createdTurn: 0 },
        { id: 'fresh-modest', importance: 1, degree: 0, protectedNode: false, createdTurn: 90 },
    ];
    // halfLife=20: by turn 100, old-important has decayed 100 turns (5
    // half-lives — weight 5*exp(-5)≈0.034), fresh-modest only 10 turns (0.5
    // half-lives — weight 1*exp(-0.5)≈0.607). The OLD node is now the
    // weaker one, despite starting with 5x the raw importance.
    const victim = pickEvictionCandidate(members, { settings: DEFAULT_SETTINGS, turnCounter: 100 });
    assert.equal(victim, 'old-important');
});

// --- Объединение почти-дубликатов -----------------------------------------

test('jaccardOverlap() is 1 for identical word sets, 0 for disjoint sets', () => {
    assert.equal(jaccardOverlap(['sword', 'cave', 'dark'], ['sword', 'cave', 'dark']), 1);
    assert.equal(jaccardOverlap(['sword', 'cave'], ['forest', 'river']), 0);
});

test('jaccardOverlap() is 0 when either side is empty — never divides by zero', () => {
    assert.equal(jaccardOverlap([], ['sword']), 0);
    assert.equal(jaccardOverlap([], []), 0);
});

test('jaccardOverlap() computes a real partial ratio: |intersection|/|union|', () => {
    // {sword,cave,dark} vs {sword,cave,forest} -> intersection 2, union 4
    assert.equal(jaccardOverlap(['sword', 'cave', 'dark'], ['sword', 'cave', 'forest']), 0.5);
});

test('findMergeCandidate() rejects a HIGHER-similarity match that shares no words, in favor of a lower-similarity one that does — the cheap word filter must actually exclude it, not just lose on similarity anyway', () => {
    const newNode = { words: wordsOf('The old tavern door creaks in the wind.'), embedding: [1, 0, 0] };
    const members = [
        { id: 'near-dup', words: wordsOf('The old tavern door creaks loudly in the wind.'), embedding: [0.93, 0.3676, 0] }, // cosine 0.93 — shares real words
        { id: 'unrelated', words: wordsOf('A dragon sleeps atop a mountain of gold.'), embedding: [0.99, 0.1411, 0] }, // cosine 0.99 — HIGHER, but zero shared words
    ];
    const match = findMergeCandidate(newNode, members, { wordOverlapThreshold: 0.3, similarityThreshold: 0.9 });
    assert.equal(match, 'near-dup', 'unrelated has the higher raw cosine score, so it must be the word filter (not similarity ranking) rejecting it');
});

test('findMergeCandidate() rejects a word-overlapping pair whose embeddings are not actually similar enough', () => {
    const newNode = { words: wordsOf('The tavern door is old and creaky.'), embedding: [1, 0, 0] };
    const members = [{ id: 'a', words: wordsOf('The tavern door was replaced last year.'), embedding: [0, 1, 0] }];
    assert.equal(findMergeCandidate(newNode, members, { wordOverlapThreshold: 0.1, similarityThreshold: 0.9 }), null);
});

test('findMergeCandidate() returns null when there are no members at all', () => {
    assert.equal(findMergeCandidate({ words: ['a'], embedding: [1, 0] }, [], {}), null);
});

test('findMergeCandidate() picks the HIGHEST-similarity match when several members pass the filter', () => {
    const newNode = { words: ['sword', 'cave', 'dark'], embedding: [1, 0, 0] };
    const members = [
        { id: 'okay-match', words: ['sword', 'cave', 'dark'], embedding: [0.95, 0.312, 0] },
        { id: 'best-match', words: ['sword', 'cave', 'dark'], embedding: [0.999, 0.045, 0] },
    ];
    assert.equal(findMergeCandidate(newNode, members, { wordOverlapThreshold: 0.3, similarityThreshold: 0.9 }), 'best-match');
});

// --- Settings clamp ------------------------------------------------------

test('clampGraphSettings() falls back to defaults on garbage input, without throwing', () => {
    const settings = clampGraphSettings({ thresholdK: 'nope', stagingBatchSize: -5 });
    assert.equal(settings.thresholdK, DEFAULT_SETTINGS.thresholdK);
    assert.equal(settings.stagingBatchSize, 1);
});

test('clampGraphSettings() keeps maxNodesPerRegion at the resolved capacity (23 = 1 center + 2 sub-centers + up to 10 each) by default', () => {
    assert.equal(DEFAULT_SETTINGS.maxNodesPerRegion, 23);
});

test('clampGraphSettings() defaults stallMs to 60000 — large enough that a reasoning-enabled bootstrap pass over a whole Lorebook is not falsely flagged as "stalled" before it ever gets a first chunk (реальный баг: "вылезает ошибка по таймауту на первом проходе" — the original 5000ms was borrowed from a different, much lighter feature)', () => {
    assert.equal(DEFAULT_SETTINGS.stallMs, 60000);
});

test('clampGraphSettings() treats stallMs:0 as a deliberate "disable it" value, not garbage to fall back from — same meaning as falsy stallMs in internal-engine.js', () => {
    assert.equal(clampGraphSettings({ stallMs: 0 }).stallMs, 0);
});

test('clampGraphSettings() clamps a garbage/out-of-range stallMs back to the default, and caps it at 120000ms', () => {
    assert.equal(clampGraphSettings({ stallMs: 'nope' }).stallMs, DEFAULT_SETTINGS.stallMs);
    assert.equal(clampGraphSettings({ stallMs: 999999 }).stallMs, 120000);
});

test('clampGraphSettings() sanitizes fallbackWorkerIds to a clean list of trimmed, non-empty strings, and falls back to [] for garbage', () => {
    assert.deepEqual(clampGraphSettings({ fallbackWorkerIds: [' worker-b ', '', 'worker-c', 42] }).fallbackWorkerIds, ['worker-b', 'worker-c', '42']);
    assert.deepEqual(clampGraphSettings({ fallbackWorkerIds: 'not-an-array' }).fallbackWorkerIds, []);
    assert.deepEqual(DEFAULT_SETTINGS.fallbackWorkerIds, []);
});

// --- Phase 2: отбор маяков и маршрут ---------------------------------------

test('scoreBeaconCandidate() lets a protected node outscore a topically closer one — "не менее подцентра региона"', () => {
    const context = [1, 0, 0];
    const protectedNode = { embedding: [0, 1, 0], importance: 0, degree: 0, protectedNode: true, createdTurn: 0 }; // orthogonal — zero topical relevance
    const irrelevantButProtected = scoreBeaconCandidate(protectedNode, context, { settings: DEFAULT_SETTINGS, turnCounter: 0 });
    const topicalWeak = scoreBeaconCandidate({ embedding: [1, 0, 0], importance: 0, degree: 0, protectedNode: false, createdTurn: 0 }, context, { settings: DEFAULT_SETTINGS, turnCounter: 0 });
    assert.ok(irrelevantButProtected > topicalWeak, 'Infinity weight must dominate even a perfect similarity match from a weak, unprotected node');
});

test('scoreBeaconCandidate() ranks a topically closer node higher when weight is equal', () => {
    const context = [1, 0, 0];
    const close = scoreBeaconCandidate({ embedding: [1, 0, 0], importance: 2, degree: 0, protectedNode: false, createdTurn: 0 }, context, { settings: DEFAULT_SETTINGS, turnCounter: 0 });
    const far = scoreBeaconCandidate({ embedding: [0, 1, 0], importance: 2, degree: 0, protectedNode: false, createdTurn: 0 }, context, { settings: DEFAULT_SETTINGS, turnCounter: 0 });
    assert.ok(close > far);
});

test('pickBeacons() returns the top-N ids, best first, and never more than there are candidates', () => {
    const context = [1, 0, 0];
    const candidates = [
        { id: 'weak', embedding: [0, 1, 0], importance: 0, degree: 0, protectedNode: false, createdTurn: 0 },
        { id: 'strong', embedding: [1, 0, 0], importance: 5, degree: 0, protectedNode: false, createdTurn: 0 },
        { id: 'medium', embedding: [0.7, 0.7, 0], importance: 1, degree: 0, protectedNode: false, createdTurn: 0 },
    ];
    assert.deepEqual(pickBeacons(candidates, context, { count: 2, settings: DEFAULT_SETTINGS, turnCounter: 0 }), ['strong', 'medium']);
    assert.equal(pickBeacons(candidates, context, { count: 10, settings: DEFAULT_SETTINGS, turnCounter: 0 }).length, 3, 'must not ask for more than exist');
});

// --- Sticky balance ретрива: scoreBeaconSet()/shouldReplaceStickySet() ----

test('scoreBeaconSet() sums PURE similarity (shifted to [0,1]) over the whole set — not the full importance-weighted scoreBeaconCandidate()', () => {
    const context = [1, 0, 0];
    const nodesById = {
        a: { id: 'a', embedding: [1, 0, 0], importance: 0, degree: 0, protectedNode: false, createdTurn: 0 }, // identical direction -> similarity 1 -> shifted 1
        b: { id: 'b', embedding: [0, 1, 0], importance: 0, degree: 0, protectedNode: false, createdTurn: 0 }, // orthogonal -> similarity 0 -> shifted 0.5
    };
    assert.equal(scoreBeaconSet(['a', 'b'], nodesById, context), 1.5);
});

test('scoreBeaconSet() ignores importance/protection entirely — summing full scoreBeaconCandidate() would let one Infinity-weighted protected node poison the whole aggregate forever', () => {
    const context = [1, 0, 0];
    const nodesById = {
        protectedNode: { id: 'protectedNode', embedding: [0, 1, 0], importance: 0, degree: 0, protectedNode: true, createdTurn: 0 }, // orthogonal AND protected — would be Infinity via scoreBeaconCandidate()
        ordinary: { id: 'ordinary', embedding: [1, 0, 0], importance: 0, degree: 0, protectedNode: false, createdTurn: 0 },
    };
    const total = scoreBeaconSet(['protectedNode', 'ordinary'], nodesById, context);
    assert.ok(Number.isFinite(total), 'a protected member must not make the whole set score Infinity');
    assert.equal(total, 1.5); // 0.5 (orthogonal, shifted) + 1 (identical, shifted)
});

test('scoreBeaconSet() returns null when ANY id in the set is missing — a whole-set dangling reference, not a partial score', () => {
    const context = [1, 0, 0];
    const nodesById = { a: { id: 'a', embedding: [1, 0, 0], importance: 0, degree: 0, protectedNode: false, createdTurn: 0 } };
    assert.equal(scoreBeaconSet(['a', 'gone'], nodesById, context), null);
});

test('shouldReplaceStickySet() always replaces when there is no sticky score at all (first turn, or a dangling reference)', () => {
    assert.equal(shouldReplaceStickySet({ stickyScore: null, freshScore: 0, stability: 'sticky' }), true);
    assert.equal(shouldReplaceStickySet({ stickyScore: undefined, freshScore: -5, stability: 'sticky' }), true);
});

test('shouldReplaceStickySet() keeps the sticky set on an EXACT tie — "лучше, а не также" (решено с пользователем явно)', () => {
    assert.equal(shouldReplaceStickySet({ stickyScore: 10, freshScore: 10, stability: 'often' }), false);
});

test('shouldReplaceStickySet() rejects a fresh candidate that is only marginally better than the sticky score, under EVERY stability level except a big enough win', () => {
    // 5% better clears "often" (margin 1.02) but not "balanced" (1.15) or "sticky" (1.4).
    assert.equal(shouldReplaceStickySet({ stickyScore: 10, freshScore: 10.5, stability: 'often' }), true);
    assert.equal(shouldReplaceStickySet({ stickyScore: 10, freshScore: 10.5, stability: 'balanced' }), false);
    assert.equal(shouldReplaceStickySet({ stickyScore: 10, freshScore: 10.5, stability: 'sticky' }), false);
});

test('shouldReplaceStickySet() accepts a fresh candidate once it clears the configured level\'s own margin', () => {
    for (const level of ['often', 'balanced', 'sticky']) {
        const margin = RETRIEVAL_STABILITY_MARGINS[level];
        assert.equal(shouldReplaceStickySet({ stickyScore: 10, freshScore: 10 * margin + 0.01, stability: level }), true, `${level} must accept a win past its own margin`);
        assert.equal(shouldReplaceStickySet({ stickyScore: 10, freshScore: 10 * margin - 0.01, stability: level }), false, `${level} must reject a win just short of its own margin`);
    }
});

test('shouldReplaceStickySet() falls back to "balanced" for an unrecognized stability value, rather than crashing or always-replacing', () => {
    assert.equal(shouldReplaceStickySet({ stickyScore: 10, freshScore: 10.5, stability: 'not-a-real-level' }), false);
});

test('findShortestPath() returns an empty path for start === end, without touching edges', () => {
    assert.deepEqual(findShortestPath({}, 'a', 'a'), []);
});

test('findShortestPath() finds a direct edge as a single step', () => {
    const nodesById = { a: { edges: [{ to: 'b', type: 'mentions' }] }, b: { edges: [{ to: 'a', type: 'mentions' }] } };
    assert.deepEqual(findShortestPath(nodesById, 'a', 'b'), [{ from: 'a', to: 'b', type: 'mentions' }]);
});

test('findShortestPath() prefers the genuinely SHORTEST path over a longer alternate route — real BFS, not DFS-first-found', () => {
    // From "start": a 2-hop route via "short" AND a 4-hop route via "wrong"
    // (wrong listed SECOND in start's edges, so a stack-based traversal
    // would push it last and pop it FIRST, diving 4 hops deep down the
    // wrong branch before ever trying "short" — only a real FIFO/BFS queue
    // reaches "short" before "wrong" gets expanded at all).
    const nodesById = {
        start: { edges: [{ to: 'short', type: 'mentions' }, { to: 'wrong', type: 'mentions' }] },
        short: { edges: [{ to: 'start', type: 'mentions' }, { to: 'end', type: 'mentions' }] },
        wrong: { edges: [{ to: 'start', type: 'mentions' }, { to: 'deeper', type: 'mentions' }] },
        deeper: { edges: [{ to: 'wrong', type: 'mentions' }, { to: 'deepest', type: 'mentions' }] },
        deepest: { edges: [{ to: 'deeper', type: 'mentions' }, { to: 'end', type: 'mentions' }] },
        end: { edges: [{ to: 'short', type: 'mentions' }, { to: 'deepest', type: 'mentions' }] },
    };
    assert.deepEqual(findShortestPath(nodesById, 'start', 'end'), [{ from: 'start', to: 'short', type: 'mentions' }, { from: 'short', to: 'end', type: 'mentions' }]);
});

test('findShortestPath() returns null when the two nodes are in disconnected components', () => {
    const nodesById = { a: { edges: [{ to: 'b', type: 'mentions' }] }, b: { edges: [{ to: 'a', type: 'mentions' }] }, c: { edges: [] } };
    assert.equal(findShortestPath(nodesById, 'a', 'c'), null);
});

test('findShortestPath() returns null once the real distance exceeds maxHops — a real safety cap, not decorative', () => {
    const nodesById = {
        a: { edges: [{ to: 'b', type: 'mentions' }] },
        b: { edges: [{ to: 'a', type: 'mentions' }, { to: 'c', type: 'mentions' }] },
        c: { edges: [{ to: 'b', type: 'mentions' }, { to: 'd', type: 'mentions' }] },
        d: { edges: [{ to: 'c', type: 'mentions' }] },
    };
    assert.equal(findShortestPath(nodesById, 'a', 'd', { maxHops: 2 }), null, 'a->d is 3 hops, must be rejected at a 2-hop cap');
    assert.ok(findShortestPath(nodesById, 'a', 'd', { maxHops: 3 }), 'the same path must succeed once the cap allows it');
});

test('buildBeaconRoute() chains three beacons into two segments when the graph connects them', () => {
    const nodesById = {
        a: { edges: [{ to: 'b', type: 'mentions' }] },
        b: { edges: [{ to: 'a', type: 'mentions' }, { to: 'c', type: 'mentions' }] },
        c: { edges: [{ to: 'b', type: 'mentions' }] },
    };
    const route = buildBeaconRoute(nodesById, ['a', 'b', 'c']);
    assert.deepEqual(route.segments, [{ from: 'a', to: 'b', type: 'mentions' }, { from: 'b', to: 'c', type: 'mentions' }]);
    assert.deepEqual(route.standalone, []);
});

test('buildBeaconRoute() lists an unreachable beacon as standalone instead of silently dropping it', () => {
    const nodesById = {
        a: { edges: [{ to: 'b', type: 'mentions' }] },
        b: { edges: [{ to: 'a', type: 'mentions' }] },
        c: { edges: [] }, // disconnected from a/b entirely
    };
    const route = buildBeaconRoute(nodesById, ['a', 'b', 'c']);
    assert.deepEqual(route.segments, [{ from: 'a', to: 'b', type: 'mentions' }]);
    assert.deepEqual(route.standalone, ['c']);
});

test('buildBeaconRoute() with a single beacon produces no segments — the lone beacon is its own standalone entry', () => {
    const route = buildBeaconRoute({ a: { edges: [] } }, ['a']);
    assert.deepEqual(route.segments, []);
    assert.deepEqual(route.standalone, ['a']);
});

test('renderMemoryPrompt() lists each involved node\'s content exactly ONCE, even when it sits at the junction of two segments', () => {
    const nodesById = {
        a: { label: 'Alice', content: 'a wandering merchant.' },
        b: { label: 'Bob', content: 'the town blacksmith.' },
        c: { label: 'Cara', content: 'a retired guard captain.' },
    };
    const route = { segments: [{ from: 'a', to: 'b', type: 'mentions' }, { from: 'b', to: 'c', type: 'mentions' }], standalone: [] };
    const text = renderMemoryPrompt(route, nodesById);

    assert.equal(text.match(/Bob/g).length, 2, 'Bob appears in the chain line AND once in the detail list — never twice in details');
    assert.equal((text.match(/the town blacksmith\./g) ?? []).length, 1, 'the actual CONTENT must appear exactly once, not duplicated per segment');
    assert.ok(text.includes('Alice -[mentions]-> Bob -[mentions]-> Cara'), 'the compact chain line must connect all three in order');
});

test('renderMemoryPrompt() marks an unreachable beacon as "(unconnected)" instead of silently dropping its content', () => {
    const nodesById = {
        a: { label: 'Alice', content: 'a wandering merchant.' },
        b: { label: 'Bob', content: 'the town blacksmith.' },
        lonely: { label: 'Distant Kingdom', content: 'a realm far to the north.' },
    };
    const route = { segments: [{ from: 'a', to: 'b', type: 'mentions' }], standalone: ['lonely'] };
    const text = renderMemoryPrompt(route, nodesById);

    assert.ok(text.includes('Distant Kingdom (unconnected): a realm far to the north.'));
});

test('renderMemoryPrompt() returns null for a completely empty route — nothing for the caller to inject', () => {
    assert.equal(renderMemoryPrompt({ segments: [], standalone: [] }, {}), null);
});

test('renderMemoryPrompt() renders each noise edge as its own connective line, tagged "(noise)" — "шум идёт от маршрута, связь будет"', () => {
    const nodesById = {
        a: { label: 'Alice', content: 'main route node.' },
        b: { label: 'Bob', content: 'main route node too.' },
        n: { label: 'Nomad', content: 'a wandering trader.' },
    };
    const route = { segments: [{ from: 'a', to: 'b', type: 'mentions' }], standalone: [], noise: [{ from: 'a', to: 'n', type: 'knows' }] };
    const text = renderMemoryPrompt(route, nodesById);
    assert.ok(text.includes('Alice -[knows]-> Nomad (noise)'), 'the real anchoring edge (with its real type) must be shown, not a bare mention');
    assert.ok(text.includes('- Nomad (noise): a wandering trader.'), 'the noise node\'s content must still be visible, tagged as noise');
});

test('renderMemoryPrompt() does not tag a node "(noise)" if it is genuinely on the main route — defensive against overlap', () => {
    const nodesById = { a: { label: 'A', content: 'one.' }, b: { label: 'B', content: 'two.' } };
    const route = { segments: [{ from: 'a', to: 'b', type: 'mentions' }], standalone: [], noise: [{ from: 'a', to: 'b', type: 'mentions' }] };
    const text = renderMemoryPrompt(route, nodesById);
    assert.equal((text.match(/- B/g) ?? []).length, 1, 'B must appear once in the detail list');
    assert.ok(!text.includes('- B (noise)'), 'a node genuinely on the main route must never be mislabeled as noise');
});

// --- Шум: гауссова выборка + многошаговая экспансия фронта ---------------
// ВТОРОЙ заход на ретрив (решено с пользователем явно): "как выберем пять
// нод-маяков. Строим маршрут между ними. Затем по шуму берём несколько
// соседних от каждой точки маршрута подключений. Потом шум применяем к ним
// и так далее. Пока не соберётся около 20 нод." — раньше был один плоский
// слой соседей маршрута, набираемый по бюджету СИМВОЛОВ; теперь —
// итеративное расширение фронта, бюджет чисто по КОЛИЧЕСТВУ узлов
// (маяки+маршрут+шум вместе), символьный лимит убран совсем.

test('gaussianRandom() computes the Box-Muller transform correctly for known inputs', () => {
    const seq = [Math.exp(-0.5), 0]; // u1, u2 -> sqrt(-2*ln(u1))=1, cos(0)=1 -> 1
    let i = 0;
    const value = gaussianRandom(() => seq[i++]);
    assert.ok(Math.abs(value - 1) < 1e-9);
});

test('gaussianRandom() never produces NaN/Infinity even when random() returns exactly 0 — log(0) would be -Infinity without a floor', () => {
    let calls = 0;
    const random = () => (calls++ === 0 ? 0 : 0.5);
    assert.ok(Number.isFinite(gaussianRandom(random)));
});

test('expandNoiseNodes() only considers OFF-route neighbors — a route node\'s edge to ANOTHER route node is never noise', () => {
    const nodesById = {
        r1: { edges: [{ to: 'r2', type: 'mentions' }, { to: 'n1', type: 'mentions' }] },
        r2: { edges: [{ to: 'r1', type: 'mentions' }] },
        n1: { label: 'Noise One', content: 'a stranger passing through.', edges: [] },
    };
    const accepted = expandNoiseNodes(nodesById, ['r1', 'r2'], { targetTotal: 10, fanoutPerNode: 5, random: () => 0.5 });
    assert.deepEqual(accepted, [{ from: 'r1', to: 'n1', type: 'mentions' }]);
});

test('expandNoiseNodes() never includes the same off-route node twice, even reachable from two different route anchors', () => {
    const nodesById = {
        r1: { edges: [{ to: 'n1', type: 'mentions' }] },
        r2: { edges: [{ to: 'n1', type: 'knows' }] },
        n1: { label: 'Shared', content: 'reachable from both.', edges: [] },
    };
    const accepted = expandNoiseNodes(nodesById, ['r1', 'r2'], { targetTotal: 10, fanoutPerNode: 5, random: () => 0.5 });
    assert.equal(accepted.length, 1);
});

test('expandNoiseNodes() never takes more than fanoutPerNode neighbors from a single frontier node, even when more are available', () => {
    const nodesById = {
        r1: { edges: [{ to: 'a', type: 'mentions' }, { to: 'b', type: 'mentions' }, { to: 'c', type: 'mentions' }] },
        a: { label: 'A', content: 'x', edges: [] },
        b: { label: 'B', content: 'x', edges: [] },
        c: { label: 'C', content: 'x', edges: [] },
    };
    const accepted = expandNoiseNodes(nodesById, ['r1'], { targetTotal: 10, fanoutPerNode: 2, random: () => 0.5 });
    assert.equal(accepted.length, 2, 'fanoutPerNode=2 must cap r1\'s own contribution at 2, even though it has 3 off-route neighbors');
});

test('expandNoiseNodes() stops growing the instant targetTotal is reached, even mid-round with more candidates available', () => {
    const nodesById = {
        r1: { edges: [{ to: 'a', type: 'mentions' }, { to: 'b', type: 'mentions' }, { to: 'c', type: 'mentions' }] },
        a: { label: 'A', content: 'x', edges: [] },
        b: { label: 'B', content: 'x', edges: [] },
        c: { label: 'C', content: 'x', edges: [] },
    };
    // route already has 1 node (r1) -> targetTotal 2 leaves room for exactly ONE more.
    const accepted = expandNoiseNodes(nodesById, ['r1'], { targetTotal: 2, fanoutPerNode: 5, random: () => 0.5 });
    assert.equal(accepted.length, 1);
});

test('expandNoiseNodes() expands into a SECOND hop when the first hop alone does not reach targetTotal — this is the actual "and so on" multi-step behavior', () => {
    const nodesById = {
        r1: { edges: [{ to: 'hop1', type: 'mentions' }] },
        hop1: { label: 'Hop1', content: 'x', edges: [{ to: 'hop2', type: 'mentions' }] },
        hop2: { label: 'Hop2', content: 'x', edges: [] },
    };
    const accepted = expandNoiseNodes(nodesById, ['r1'], { targetTotal: 3, fanoutPerNode: 5, random: () => 0.5 });
    assert.deepEqual(accepted, [
        { from: 'r1', to: 'hop1', type: 'mentions' },
        { from: 'hop1', to: 'hop2', type: 'mentions' },
    ], 'hop2 is only reachable THROUGH hop1, one edge off the route — it must still be picked up by continuing the expansion from the previous round\'s new nodes');
});

test('expandNoiseNodes() terminates gracefully (does not hang, does not throw) when the frontier runs dry before reaching targetTotal — a small graph is not an error', () => {
    const nodesById = {
        r1: { edges: [{ to: 'only', type: 'mentions' }] },
        only: { label: 'Only', content: 'x', edges: [] }, // dead end — no further edges to expand into
    };
    const accepted = expandNoiseNodes(nodesById, ['r1'], { targetTotal: 100, fanoutPerNode: 5, random: () => 0.5 });
    assert.deepEqual(accepted, [{ from: 'r1', to: 'only', type: 'mentions' }], 'must return what it found, not fail just because it fell short of a target far bigger than the whole reachable graph');
});

test('expandNoiseNodes() returns nothing when the route already meets or exceeds targetTotal — no room left to grow', () => {
    const nodesById = { r1: { edges: [{ to: 'n1', type: 'mentions' }] }, n1: { label: 'N', content: 'x', edges: [] } };
    assert.deepEqual(expandNoiseNodes(nodesById, ['r1'], { targetTotal: 1, fanoutPerNode: 5, random: () => 0.5 }), []);
});

// --- importanceFromLorebookEntry() / applyConnectionBonus() — auto importance for bootstrap (решено с пользователем) ---

test('importanceFromLorebookEntry() scores a constant (curated, always-on) entry higher than a normal one, order equal', () => {
    const constant = importanceFromLorebookEntry({ constant: true, order: 100 });
    const normal = importanceFromLorebookEntry({ constant: false, order: 100 });
    assert.ok(constant > normal, `constant entry (${constant}) must outscore a normal one (${normal})`);
});

test('importanceFromLorebookEntry() treats HIGHER order as MORE important — real ST sorts entries by "b.order - a.order" (descending)', () => {
    const highOrder = importanceFromLorebookEntry({ constant: false, order: 200 });
    const neutralOrder = importanceFromLorebookEntry({ constant: false, order: 100 });
    const lowOrder = importanceFromLorebookEntry({ constant: false, order: 0 });
    assert.ok(highOrder > neutralOrder, `order 200 (${highOrder}) must outscore neutral order 100 (${neutralOrder})`);
    assert.ok(neutralOrder > lowOrder, `neutral order 100 (${neutralOrder}) must outscore order 0 (${lowOrder})`);
});

test('importanceFromLorebookEntry() clamps to [0, 10] and tolerates a missing/non-numeric order (ST default is 100 = neutral, no field at all must not crash)', () => {
    const missingOrder = importanceFromLorebookEntry({ constant: true });
    assert.ok(missingOrder >= 0 && missingOrder <= 10);
    const extreme = importanceFromLorebookEntry({ constant: true, order: 999999 });
    assert.ok(extreme <= 10);
    const negative = importanceFromLorebookEntry({ constant: false, order: -999999 });
    assert.ok(negative >= 0);
});

test('applyConnectionBonus() adds degree to the base importance, clamped at 10 — a heavily-mentioned node must not exceed the scale', () => {
    assert.equal(applyConnectionBonus(3, 2), 5);
    assert.equal(applyConnectionBonus(9, 5), 10, 'must clamp at the ceiling, not overflow past 10');
    assert.equal(applyConnectionBonus(3, 0), 3, 'zero connections leaves the base signal untouched');
});

// --- LLM-driven семантические регионы бутстрапа (решено с пользователем) ---

test('buildRegionSkeletonPrompt() includes EVERY entry, numbered, and the mandatory region names', () => {
    const entries = [
        { uid: 5, label: 'Alpha', content: 'first fact' },
        { uid: 9, label: 'Beta', content: 'second fact' },
    ];
    const prompt = buildRegionSkeletonPrompt(entries, ['Locations', 'Factions']);
    assert.ok(prompt.includes('5. Alpha: first fact'));
    assert.ok(prompt.includes('9. Beta: second fact'));
    assert.ok(prompt.includes('Locations'));
    assert.ok(prompt.includes('Factions'));
});

test('buildRegionSkeletonPrompt() does NOT invite the model to invent its own regions — that is exclusively Pass 2\'s job', () => {
    const entries = [{ uid: 1, label: 'A', content: 'x' }];
    const prompt = buildRegionSkeletonPrompt(entries, ['Locations']);
    assert.ok(!/propose|your own additional/i.test(prompt), 'Pass 1 must only assign sub-centers to the given regions, never invent new ones — see buildAdditionalCentersPrompt()');
    assert.ok(prompt.includes('ONLY these regions'));
});

test('parseRegionSkeletonResponse() drops a region with no valid sub-center uid, but keeps other valid regions', () => {
    const entries = [{ uid: 1 }, { uid: 2 }, { uid: 3 }];
    const parsed = [
        { region: 'Good', subCenterUids: [1, 2] },
        { region: 'Bad', subCenterUids: [999] }, // uid 999 does not exist
        { region: '', subCenterUids: [3] }, // no name at all
    ];
    const result = parseRegionSkeletonResponse(parsed, entries);
    assert.deepEqual(result, [{ name: 'Good', subCenterUids: [1, 2] }]);
});

test('parseRegionSkeletonResponse() never assigns the SAME uid as a sub-center twice across different regions', () => {
    const entries = [{ uid: 1 }, { uid: 2 }];
    const parsed = [
        { region: 'First', subCenterUids: [1, 2] },
        { region: 'Second', subCenterUids: [1] }, // uid 1 already claimed by "First"
    ];
    const result = parseRegionSkeletonResponse(parsed, entries);
    assert.equal(result.length, 1, 'a region left with zero valid sub-centers after dedup must be dropped entirely');
    assert.deepEqual(result[0].subCenterUids, [1, 2]);
});

test('parseRegionSkeletonResponse() returns nothing for a non-array response — model.generate is defensive, never throws on bad JSON', () => {
    assert.deepEqual(parseRegionSkeletonResponse(undefined, []), []);
    assert.deepEqual(parseRegionSkeletonResponse({ not: 'an array' }, []), []);
});

test('buildAdditionalCentersPrompt() names the existing regions and the target region count', () => {
    const entries = [{ uid: 1, label: 'A', content: 'x' }];
    const prompt = buildAdditionalCentersPrompt(entries, ['Locations', 'Factions'], 5, 20);
    assert.ok(prompt.includes('Locations'));
    assert.ok(prompt.includes('Factions'));
    assert.ok(prompt.includes('5'), 'the target total region count must appear in the prompt');
});

test('parseAdditionalCentersResponse() dedups by BOTH region name and center uid — a model reusing either must not double-count', () => {
    const entries = [{ uid: 1 }, { uid: 2 }, { uid: 3 }];
    const parsed = [
        { region: 'A', centerUid: 1 },
        { region: 'A', centerUid: 2 }, // same region name again — dropped
        { region: 'B', centerUid: 1 }, // same uid already used by "A" — dropped
        { region: 'C', centerUid: 3 },
        { region: 'D', centerUid: 999 }, // invalid uid — dropped
    ];
    const result = parseAdditionalCentersResponse(parsed, entries);
    assert.deepEqual(result, [{ name: 'A', centerUid: 1 }, { name: 'C', centerUid: 3 }]);
});

test('pickNearestRegion() returns the region of the anchor with the HIGHEST cosine similarity, ignoring anchors with no embedding/regionId', () => {
    const anchors = [
        { regionId: 'Far', embedding: [1, 0, 0, 0] },
        { regionId: 'Close', embedding: [0, 1, 0, 0] },
        { regionId: 'Broken', embedding: null }, // must not crash, just skipped
    ];
    const embedding = [0, 0.9, 0.1, 0]; // clearly closer to "Close"'s direction
    assert.equal(pickNearestRegion(embedding, anchors), 'Close');
});

test('pickNearestRegion() returns null when there are no usable anchors at all', () => {
    assert.equal(pickNearestRegion([1, 0, 0, 0], []), null);
    assert.equal(pickNearestRegion([1, 0, 0, 0], [{ regionId: null, embedding: [1, 0, 0, 0] }]), null);
});

test('buildRegionEdgesPrompt() lists every node by its REAL graph id (a string), not a lorebook uid', () => {
    const nodes = [{ id: 'node_abc', label: 'Alice', content: 'hero' }, { id: 'node_xyz', label: 'Bob', content: 'sidekick' }];
    const prompt = buildRegionEdgesPrompt(nodes);
    assert.ok(prompt.includes('node_abc. Alice: hero'));
    assert.ok(prompt.includes('node_xyz. Bob: sidekick'));
});

test('parseRegionEdgesResponse() filters to valid ids only, drops self-loops, and dedups an unordered pair', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const parsed = [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' }, // same unordered pair as above — must not duplicate
        { from: 'a', to: 'a' }, // self-loop — dropped
        { from: 'a', to: 'zzz' }, // 'zzz' not in this region — dropped
        { from: 'b', to: 'c' },
    ];
    const result = parseRegionEdgesResponse(parsed, nodes);
    const keys = result.map(e => [e.from, e.to].sort().join('|')).sort();
    assert.deepEqual(keys, ['a|b', 'b|c']);
});

// --- buildOrphanConnectionsPrompt()/parseOrphanConnectionsResponse() — Проход 4 (условный связующий проход) ---

test('buildOrphanConnectionsPrompt() lists the WHOLE graph by id, but names only the disconnected ones as needing a connection', () => {
    const allNodes = [
        { id: 'node_a', label: 'Alice', content: 'hero' },
        { id: 'node_b', label: 'Bob', content: 'sidekick' },
        { id: 'node_c', label: 'Cave', content: 'a dark place' },
    ];
    const prompt = buildOrphanConnectionsPrompt(allNodes, ['node_c']);
    assert.ok(prompt.includes('node_a. Alice: hero'), 'the full listing must include EVERY node, not just the orphans, so the model has real candidates to connect to');
    assert.ok(prompt.includes('node_b. Bob: sidekick'));
    assert.ok(prompt.includes('node_c'));
    assert.match(prompt, /without exception/i, 'the model must be told it cannot skip any of the disconnected entries — unlike every other SideCar prompt in this file');
});

test('buildOrphanConnectionsPrompt() gives NO escape hatch — no skip/decline wording, unlike askSideCarForNode()/askSideCarForMerge()', () => {
    const prompt = buildOrphanConnectionsPrompt([{ id: 'a', label: 'A', content: 'x' }], ['a']);
    assert.doesNotMatch(prompt, /"skip"|"distinct"|"discard"/i, 'a disconnected node is worse than an imperfectly-connected one — this prompt must never offer a decline path');
});

test('parseOrphanConnectionsResponse() only accepts edges FOR a requested orphan id — it cannot smuggle in a connection for some other node', () => {
    const allNodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const parsed = [
        { id: 'c', connectTo: ['a'] }, // 'c' IS the requested orphan — accepted
        { id: 'b', connectTo: ['a'] }, // 'b' was never asked about — must be dropped entirely
    ];
    const result = parseOrphanConnectionsResponse(parsed, allNodes, ['c']);
    assert.deepEqual(result, [{ from: 'c', to: 'a' }]);
});

test('parseOrphanConnectionsResponse() filters to valid ids, drops self-loops, and dedups per orphan — same discipline as parseRegionEdgesResponse()', () => {
    const allNodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const parsed = [
        { id: 'c', connectTo: ['a', 'a', 'c', 'zzz', 'b'] }, // dup 'a', self-loop 'c', unknown 'zzz', real 'b'
    ];
    const result = parseOrphanConnectionsResponse(parsed, allNodes, ['c']);
    const keys = result.map(e => [e.from, e.to].sort().join('|')).sort();
    assert.deepEqual(keys, ['a|c', 'b|c']);
});

test('parseOrphanConnectionsResponse() returns nothing for a non-array response, same tolerance as every other SideCar parser in this file', () => {
    assert.deepEqual(parseOrphanConnectionsResponse({ not: 'an array' }, [{ id: 'a' }], ['a']), []);
    assert.deepEqual(parseOrphanConnectionsResponse(null, [{ id: 'a' }], ['a']), []);
});

test('fitEntriesToTokenBudget() shortens entry text to fit the budget, leaves entries alone when unlimited or already small', async () => {
    const { fitEntriesToTokenBudget } = await import('../cores/memory-graph/index.js');
    const entries = [{ uid: 1, label: 'A', content: 'x'.repeat(4000) }, { uid: 2, label: 'B', content: 'y'.repeat(4000) }];
    assert.equal(fitEntriesToTokenBudget(entries, 0), entries, '0 means unlimited');
    assert.equal(fitEntriesToTokenBudget(entries, 100000), entries, 'already within budget');
    const fitted = fitEntriesToTokenBudget(entries, 500);
    assert.ok(fitted.every(entry => entry.content.length < 1200), 'each entry is shortened to roughly its share');
    assert.equal(entries[0].content.length, 4000, 'the originals are not mutated');
});

// --- Чанкованные Проходы 1-2 ------------------------------------------------

const chunkEntries = [
    { uid: 1, label: 'Alpha Land', content: 'FULLTEXT-ONE alpha land description' },
    { uid: 2, label: 'Beta Guild', content: 'FULLTEXT-TWO beta guild description' },
    { uid: 3, label: 'Gamma Hero', content: 'FULLTEXT-THREE gamma hero description' },
];
const chunkEntryByUid = new Map(chunkEntries.map(entry => [entry.uid, entry]));

test('buildSkeletonPartPrompt()/buildCentersPartPrompt() give the FULL text of this part only, but the label INDEX of every entry', () => {
    for (const prompt of [
        buildSkeletonPartPrompt({ partEntries: [chunkEntries[0]], allEntries: chunkEntries, partNumber: 1, partCount: 3, baseRegionNames: ['Locations', 'Factions'] }),
        buildCentersPartPrompt({ partEntries: [chunkEntries[0]], allEntries: chunkEntries, partNumber: 1, partCount: 3, existingRegionNames: ['Locations'], targetTotalRegions: 5, entriesPerRegionCenter: 20 }),
    ]) {
        assert.ok(prompt.includes('FULLTEXT-ONE'), 'this part\'s entry arrives whole');
        assert.ok(!prompt.includes('FULLTEXT-TWO') && !prompt.includes('FULLTEXT-THREE'), 'other parts\' text is NOT duplicated in this call');
        for (const entry of chunkEntries) assert.ok(prompt.includes(`${entry.uid}. ${entry.label}`), `index still names ${entry.label}`);
        assert.ok(prompt.includes('part 1 of 3'));
    }
    assert.ok(buildSkeletonPartPrompt({ partEntries: chunkEntries, allEntries: chunkEntries, partNumber: 1, partCount: 1, baseRegionNames: ['Locations', 'Factions'] }).includes('Use ONLY these regions'), 'base regions stay a closed list — the part prompt must not invite inventing regions');
});

test('parseCandidatesResponse() is tolerant: filters unknown uids / duplicate uids / disallowed regions, keeps rank order, caps per region, normalizes region-name spelling', () => {
    const valid = new Set([1, 2, 3]);
    const parsed = [
        { region: ' locations ', candidates: [{ uid: 2, note: 'n2' }, { uid: 99, note: 'ghost' }, { uid: 2, note: 'dup' }, { uid: 1 }, { uid: 3 }] },
        { region: 'Invented', candidates: [{ uid: 1 }] },
        { region: 'Factions', candidates: [{ uid: 404 }] },
        'garbage', null,
    ];
    const result = parseCandidatesResponse(parsed, valid, { allowedRegionNames: ['Locations', 'Factions'], maxPerRegion: 2 });
    assert.deepEqual(result, [{ region: 'Locations', candidates: [{ uid: 2, note: 'n2' }, { uid: 1, note: '' }] }], 'canonical name, ghost + dup dropped, capped at 2, invented and empty regions dropped');
    const open = parseCandidatesResponse(parsed, valid, { maxPerRegion: 3 });
    assert.ok(open.some(group => group.region === 'Invented'), 'with no allow-list (Проход 2) new regions are kept');
    assert.deepEqual(parseCandidatesResponse('nope', valid), []);
});

test('mergeCandidateGroups() interleaves by RANK across parts (every part\'s #1 before any #2), dedups uids, keeps known region names first and merges spelling variants of a new region', () => {
    const partA = [{ region: 'Locations', candidates: [{ uid: 1, note: 'a1' }, { uid: 2, note: 'a2' }] }];
    const partB = [{ region: 'locations', candidates: [{ uid: 3, note: 'b1' }, { uid: 1, note: 'dup of a1' }] }, { region: 'Military', candidates: [{ uid: 2, note: 'm' }] }];
    const partC = [{ region: 'Military ', candidates: [{ uid: 3, note: 'm2' }] }];
    const merged = mergeCandidateGroups([partA, partB, partC], chunkEntryByUid, ['Locations']);
    assert.equal(merged[0].region, 'Locations');
    assert.deepEqual(merged[0].candidates.map(c => c.uid), [1, 3, 2], 'rank 0 of part A, rank 0 of part B, then rank 1s — duplicate uid 1 appears once');
    assert.equal(merged[0].candidates[0].label, 'Alpha Land', 'labels come from the entries, not from the model');
    assert.equal(merged.length, 2);
    assert.deepEqual(merged[1].candidates.map(c => c.uid), [2, 3], '"Military" and "Military " are the same new region');
});

test('trimCandidatesToBudget() drops only the LOWEST-ranked candidates (from the widest region, keeping at least one per region) and reports how many', () => {
    const many = (region, n) => ({ region, candidates: Array.from({ length: n }, (_, i) => ({ uid: i + 1, label: `Label ${i}`, note: 'x'.repeat(40) })) });
    const groups = [many('A', 6), many('B', 2)];
    const untouched = trimCandidatesToBudget(groups, 100000);
    assert.equal(untouched.trimmed, 0);
    const tight = trimCandidatesToBudget(groups, 60);
    assert.ok(tight.trimmed > 0);
    assert.ok(tight.groups.every(group => group.candidates.length >= 1), 'never empties a region');
    assert.deepEqual(tight.groups[0].candidates.map(c => c.uid), [1, 2, 3, 4, 5, 6].slice(0, tight.groups[0].candidates.length), 'the survivors are the TOP-ranked prefix');
    assert.equal(groups[0].candidates.length, 6, 'input is not mutated');
    assert.equal(trimCandidatesToBudget(groups, 0).trimmed, 0, 'budget 0 = no trimming');
});

test('reduce prompts list every candidate with its note; the Проход 2 reduce asks to merge same-meaning new regions', () => {
    const groups = [{ region: 'Locations', candidates: [{ uid: 1, label: 'Alpha Land', note: 'a big place' }] }];
    const skeleton = buildSkeletonReducePrompt(groups, ['Locations', 'Factions']);
    assert.ok(skeleton.includes('1. Alpha Land — a big place') && skeleton.includes('subCenterUids'));
    const centers = buildCentersReducePrompt(groups, ['Locations'], 7, 20);
    assert.ok(centers.includes('1. Alpha Land — a big place') && centers.includes('centerUid') && /SAME region/.test(centers) && centers.includes('about 7 regions'));
});

// --- Несколько активных Lorebook ----------------------------------------------

test('assignBootstrapUids() keeps original uids when they are unique (single book = unchanged behavior) and renumbers 0..N-1 when books collide', () => {
    assert.deepEqual(assignBootstrapUids([10, 20, 30]), [10, 20, 30], 'unique — untouched, including gaps');
    assert.deepEqual(assignBootstrapUids([0, 1, 0, 1]), [0, 1, 2, 3], 'two books both with uids 0 and 1 — sequential handles');
    assert.deepEqual(assignBootstrapUids([5, 7, 5]), [0, 1, 2], 'ANY collision renumbers everything, so handles stay stable and unique');
    assert.deepEqual(assignBootstrapUids([]), []);
});

test('entryTitle() appends the book only when the entry carries one (several active lorebooks)', () => {
    assert.equal(entryTitle({ label: 'Alpha' }), 'Alpha');
    assert.equal(entryTitle({ label: 'Alpha', book: 'World A' }), 'Alpha [World A]');
});
