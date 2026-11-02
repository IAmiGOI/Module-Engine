import { estimateTokens } from '../../libraries/core/token-estimate.js';
import { DIRECTOR_ARC_SUMMARY, fillPrompt } from '../../libraries/core/decision-prompts.js';
import { FULL_TURNS, buildTurnDigest, digestTokens, groupTurns } from '../../libraries/core/decision-turn-digest.js';

const text = value => String(value ?? '').trim();

function withinArc(record, arc) {
    const at = Number(record?.at);
    const from = Number(arc?.createdAt);
    const to = Number(arc?.closedAt);
    if (!Number.isFinite(at) || !Number.isFinite(from) || !Number.isFinite(to)) return false;
    return at >= from && at <= to;
}

/** Сжатые записи арки заменяются одной сводкой. Это единственная разрешённая перезапись префикса. */
export function replaceArcDigests(digests, arcs, summary, now = () => Date.now()) {
    const list = Array.isArray(digests) ? digests : [];
    const closed = Array.isArray(arcs) ? arcs : [];
    const key = `arc_summary_${closed.map(arc => arc.id).join('_')}`;
    const body = `CLOSED ARCS (summary):\n\n${text(summary)}`;
    const record = { key, at: now(), arcIds: closed.map(arc => arc.id), summary: true, text: body, tokens: estimateTokens(body) };
    const next = [];
    let inserted = false;
    for (const digest of list) {
        if (digest?.summary || !closed.some(arc => withinArc(digest, arc))) { next.push(digest); continue; }
        if (!inserted) { next.push(record); inserted = true; }
    }
    if (!inserted) next.push(record);
    return next;
}

/**
 * Сжатый префикс лога. После каждого хода ход, выпавший из окна двух полных,
 * один раз сжимается и дописывается в конец `turnDigests`; его полные циклы
 * уходят в архив. Уже лежащие записи не пересчитываются.
 */
export function createTurnPrefix({ store, getSettings, deciderWorker, call, publishEvent, now = () => Date.now() }) {
    let running = null;

    function sync() {
        if (running) return running;
        running = doSync().finally(() => { running = null; });
        return running;
    }

    async function doSync() {
        const turns = groupTurns(store.cycles());
        if (turns.length <= FULL_TURNS) return { dropped: 0, appended: 0 };
        const drop = turns.slice(0, -FULL_TURNS);
        const keep = turns.slice(-FULL_TURNS);
        let digests = typeof store.digests === 'function' ? store.digests() : [];
        const known = new Set(digests.map(record => record.key));
        const appended = [];
        for (const turn of drop) {
            if (turn.cycles.every(cycle => cycle.rejected)) continue;
            const record = buildTurnDigest(turn, { index: digests.length + appended.length, now });
            if (known.has(record.key)) continue;
            known.add(record.key);
            appended.push(record);
        }
        if (appended.length) {
            digests = [...digests, ...appended];
            await store.saveDigests(digests);
        }
        await store.saveLog(keep.flatMap(turn => turn.cycles), {
            archived: drop.flatMap(turn => turn.cycles),
            archiveLimitTokens: Number(getSettings().archiveLimitTokens) || 0,
        });
        await maybeSummarizeArcs(digests);
        if (appended.length) publishEvent('decision.digest.appended', { count: appended.length, turns: appended.map(record => record.turn) });
        return { dropped: drop.length, appended: appended.length };
    }

    async function maybeSummarizeArcs(digests) {
        const settings = getSettings();
        const tokens = digestTokens(digests);
        if (tokens <= (Number(settings.compressedLimitTokens) || 100000)) return null;
        const closed = store.arcs().filter(arc => arc.status === 'closed' && !arc.summary);
        if (!closed.length) {
            publishEvent('decision.log.warning', { reason: 'no closed arcs to summarize; the compressed prefix is over the limit', tokens });
            return null;
        }
        const worker = deciderWorker(settings);
        const prompt = fillPrompt(DIRECTOR_ARC_SUMMARY, {
            arcs: closed.map(arc => `ARC: ${arc.title}\nStages: ${(arc.stages ?? []).map(stage => stage.note).filter(Boolean).join('; ') || 'none'}`).join('\n\n'),
        });
        let summary = '';
        try {
            summary = await call('model.generate', { workerId: worker.id, prompt, maxTokens: 1200, temperature: 0, stream: false });
        } catch (error) {
            publishEvent('decision.log.warning', { reason: `arc summary failed: ${error?.message ?? error}`, tokens });
            return null;
        }
        if (!text(summary)) {
            publishEvent('decision.log.warning', { reason: 'the director returned an empty arc summary', tokens });
            return null;
        }
        const arcs = store.arcs().map(arc => (closed.some(item => item.id === arc.id) ? { ...arc, summary: text(summary), summaryAt: now() } : arc));
        await store.saveArcs(arcs);
        const replaced = replaceArcDigests(digests, closed, summary, now);
        await store.saveDigests(replaced);
        publishEvent('decision.log.compacted', { before: tokens, after: digestTokens(replaced), arcs: closed.length });
        return replaced;
    }

    /**
     * Удаление или правка сообщения, чей ход уже сжат: сжатая запись не
     * переписывается, в конец дописывается строка-поправка.
     */
    async function noteCorrection({ mesid, action = 'deleted' } = {}) {
        const run = store.runs()[String(mesid)];
        if (!run?.id) return false;
        const digests = store.digests();
        const match = digests.find(record => Array.isArray(record.runIds) && record.runIds.includes(run.id));
        if (!match) return false;
        const body = `turn ${match.turn}: message ${action} by the user`;
        await store.saveDigests([...digests, { key: `correction_${now()}_${digests.length}`, at: now(), text: body, correction: true, tokens: estimateTokens(body) }]);
        publishEvent('decision.digest.correction', { turn: match.turn, action });
        return true;
    }

    return { sync, noteCorrection };
}
