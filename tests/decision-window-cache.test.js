import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeciderContext } from '../libraries/core/decision-context.js';
import { compareRequests } from '../libraries/core/decision-cache.js';
import { buildCycleDigest, buildFrozenRecord, splitWindow, windowTurnCount } from '../libraries/core/decision-window.js';
import { estimateTokens } from '../libraries/core/token-estimate.js';

/**
 * Синтетика части 10: 120 ходов, ростер меняется раз в ~15 ходов,
 * арка заканчивается на 70-м. Окно только дописывается, переключается на
 * 50 циклах и на конце арки; защищённая часть между переключениями стоит.
 */
const TURNS = 120;
const SESSION = 1000;
const words = (count, word) => Array.from({ length: count }, () => word).join(' ');

function cycle(number) {
    const comment = `The reason for this call is plain. ${words(12, 'comment')}`;
    return {
        id: `cyc_${number}`, runId: `run_${number}`, event: 'turn', turn: number, at: number + SESSION, clockMinutes: number * 5,
        toolCalls: [
            { name: 'assess', args: { character: 'Aria', comment }, result: { ok: true, probability: 0.4, degree: 'barely' }, comment },
            { name: 'character_note', args: { character: 'Rem', op: 'add', text: `note ${number}`, comment }, result: { ok: true }, comment },
            { name: 'set_character_plan', args: { character: 'Rem', summary: `Plan ${number}.`, comment }, result: { ok: true }, comment },
            { name: 'memory', args: { op: 'search', character: 'Rem', query: 'wound', comment }, result: { ok: true }, comment },
            { name: 'library', args: { comment }, result: { ok: true }, comment },
        ],
        form: { resolution: `Resolution ${number}.`, characters: [], scene: { minutes: 5, place: 'the east corridor' }, meta: { place: 'the east corridor' } },
        push: `This turn took 5 minutes.\nPlace: the east corridor.\nResolution: Resolution ${number}.\nThe user's action: it works.\nRem will wait. ${words(45, 'push')}`,
    };
}

function diaryEntry(number) {
    return buildCycleDigest(cycle(number), {
        turn: number, userText: `The user acts on turn ${number}. ${words(30, 'action')}`,
        writerText: `The writer answers turn ${number}. ${words(35, 'prose')}`,
    });
}

function simulated() {
    let saved = [];
    let frozen = [];
    let boundaryVersion = 0;
    let lorebookVersion = 0;
    let switches = [];
    const contexts = [];

    const boundary = () => ({
        roster: [`Aria ${boundaryVersion}`, 'Rem'],
        libraryText: `CHARACTER LIBRARY ${boundaryVersion}\n\n- Aria ${boundaryVersion} (level 1)\n- Rem (level 3)`,
        plansText: `CHARACTER PLANS ${boundaryVersion}\n\n${words(200, 'plan')}`,
        activeBanksText: `ACTIVE BANKS ${boundaryVersion}\n\n${words(400, 'active')}`,
    });

    function context(version) {
        return buildDeciderContext({
            banksText: `CHARACTER BANKS\n\n${words(1200, 'bank')}`,
            lorebookText: `THE LOREBOOK ${lorebookVersion}\n\n${words(1200, 'lore')}`,
            arcs: [{ status: 'open', title: 'The Escape' }],
            libraryText: boundary().libraryText,
            frozenWindows: frozen,
            plansText: boundary().plansText,
            roster: boundary().roster,
            activeBanksText: boundary().activeBanksText,
            windowEntries: [
                ...saved,
                { kind: 'turn', turn: version, at: version + SESSION, text: `TURN ${version} (compressed)\nUser: The user acts on turn ${version}. ${words(30, 'action')}` },
            ],
            knowledgeText: `WHAT CHARACTERS KNOW ${version}\n\n${words(120, 'knowledge')}`,
            notes: { rem: [{ title: 'wound', text: `${words(70, 'note')} ${version}` }] },
            plan: { direction: `plan ${version}` },
            windowMode: true,
            task: `A new turn. ${version}`,
        });
    }

    function switchWindow(turn, reason) {
        const { dropped, kept } = splitWindow(saved, { share: 0.6 });
        if (!dropped.length) return;
        frozen = [...frozen, buildFrozenRecord({ text: `WINDOW SUMMARY ${turn}: ${words(500, 'summary')}`, reason, at: turn + SESSION, key: `w${turn}` })];
        saved = kept;
        boundaryVersion = turn;
        lorebookVersion = turn;
        switches.push({ turn, reason, dropped: dropped.filter(entry => entry.kind === 'turn').length, kept: windowTurnCount(kept) });
    }

    for (let number = 1; number <= TURNS; number += 1) {
        contexts.push(context(number));
        saved.push(diaryEntry(number));
        // Ростер меняется раз в ~15 ходов — это остаётся фактом в окне, не снимком.
        if (number % 15 === 0 && number !== 50 && number !== 70) {
            saved.push({ kind: 'fact', turn: number, at: number + SESSION, text: `update_roster: + Traveller ${number}` });
        }
        if (number === 50) switchWindow(number, '50 cycles');
        if (number === 70) switchWindow(number, 'the arc ended');
        if (windowTurnCount(saved) >= 50) switchWindow(number, '50 cycles');
    }
    return { contexts, switches };
}

function measure(contexts) {
    let shared = 0; let total = 0; let reRead = 0;
    const rows = [];
    for (let index = 1; index < contexts.length; index += 1) {
        const comparison = compareRequests(contexts[index - 1].messages, contexts[index].messages);
        shared += comparison.sharedTokens;
        total += comparison.totalTokens;
        reRead += comparison.totalTokens - comparison.sharedTokens;
        rows.push({ turn: index + 1, ratio: comparison.ratio, shared: comparison.sharedTokens, total: comparison.totalTokens, culprit: comparison.culprit?.index ?? null });
    }
    return {
        ratio: shared / total,
        reReadPerTurn: reRead / (contexts.length - 1),
        averageTotal: total / (contexts.length - 1),
        rows,
    };
}

test('the 120-turn synthetic keeps the protected part and the window cached between switches', () => {
    const { contexts, switches } = simulated();
    const stats = measure(contexts);
    const windowSizes = contexts.map(context => estimateTokens(context.messages.map(message => message.content).join('\n')));
    // Замер (node 18, без ST): 93,4 % общего префикса; 1136 токенов заново за ход;
    // средний контекст 17 108 токенов, максимум 25 874; переключения на 50, 70 (арка) и 104.
    void windowSizes;
    assert.ok(stats.ratio > 0.85, `the shared prefix is ${stats.ratio}`);
    assert.ok(stats.reReadPerTurn < 5000, `re-read per turn is ${stats.reReadPerTurn}`);
    assert.ok(switches.length >= 3, 'switches happened at 50, at the arc end and again at 50');
    assert.equal(switches[0].dropped, 30);
    assert.equal(switches[0].kept, 20);
    assert.equal(switches[1].reason, 'the arc ended');
});
