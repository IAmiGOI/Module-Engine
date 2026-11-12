import { isUserCharacter } from '../../libraries/core/decision-great-bank.js';
import { createGreatBank } from './bank-great.js';
import { createPsychologist } from './psychologist.js';
import { renderDecreeForResolver, renderTemperForResolver, renderPsycheForResolver } from '../../libraries/core/decision-bank-projections.js';
import { renderWithUser, renderDeadlines } from '../../libraries/core/acquaintance.js';

/**
 * Great Bank поверх банков-карточек: проекции (дальняя компактная, ближняя
 * полная, писателю), правка одним вызовом и предложения резолвера. Банки
 * чата — источник; Great Bank раскладывает их по разделам и правит строки.
 */
export function createGreatBankLayer({ call, store, banks, publishEvent = () => {}, getSettings = null }) {
    const great = createGreatBank({ call, store, banks, timeOfDay: () => getSettings?.()?.bankTimeOfDay ?? null });
    const psychologist = createPsychologist({ call, store, great, getSettings, publishEvent });
    // Персонажи, которых держит Психолог-сосед: отдельный вызов их psyche.md не пишет.
    const held = new Set();
    const heldKey = name => String(name ?? '').trim().toLowerCase();
    const withoutHeld = state => Object.fromEntries(Object.entries(state ?? {})
        .filter(([key, character]) => !held.has(heldKey(character?.name ?? key))));

    /** Психолог не держит ход: пишет psyche.md, когда банк впервые готов, в фоне. */
    const schedulePsyche = state => { if (state) psychologist.maybeRun(withoutHeld(state)).catch(() => {}); };
    const sync = async () => {
        const state = await great.sync().catch(() => null);
        schedulePsyche(state);
        return state;
    };
    const ensurePsyche = async () => psychologist.maybeRun(withoutHeld(await great.sync().catch(() => null)));

    /** По просьбе пользователя: Психолог переписывает psyche.md заново; это исправление — откат хода его не отменяет. */
    async function rewritePsyche(name) {
        const state = await great.sync().catch(() => null);
        const character = Object.values(state ?? {}).find(item => heldKey(item?.name) === heldKey(name));
        if (!character) return { ok: false, error: `There is no character "${name}".` };
        if (isUserCharacter(character)) return { ok: false, error: `${character.name} is the user's character: nobody writes their psyche.md.` };
        if (held.has(heldKey(character.name))) return { ok: false, error: `${character.name} is at the Director's desk right now — try again when the session ends.` };
        return psychologist.runOne(character, { correction: true });
    }

    /** Сессия Директора берёт персонажей себе: до её конца отдельный Психолог их не трогает. */
    function holdPsyche(names = []) {
        for (const name of Array.isArray(names) ? names : []) held.add(heldKey(name));
    }

    function releasePsyche(names = []) {
        for (const name of Array.isArray(names) ? names : []) held.delete(heldKey(name));
    }

    /** Дальняя компактная проекция: Material 1, 3, 6 + Spiritual 4, 6, по всем персонажам. */
    async function farContext() {
        await sync();
        return great.farText();
    }

    /** Ближняя полная проекция: только активный ростер — она в некешируемом хвосте. */
    async function nearContext(names = []) {
        await sync();
        return great.nearText(names);
    }

    /**
     * Писателю: полные банки активного ростера, Указы всех персонажей (пока
     * пустые — фаза 4) и описание сцены. Сцена описывает мир, а не персонажа,
     * в Great Bank не входит и идёт своим текстом.
     */
    async function writerContext(names = [], { sceneText = () => '' } = {}) {
        await sync();
        const active = await great.writerText(names);
        const scene = String(sceneText() ?? '').trim();
        return { banks: [active, scene].filter(Boolean).join('\n\n'), decrees: await great.decreeText() };
    }

    /** `bank_edit` — несколько персонажей одним вызовом; резолвер правит только предметным. */
    async function edit(params = {}, options = {}) {
        const result = await great.edit(params, options);
        publishEvent('decision.bank.edited', { changes: result.changes.length, by: options.by ?? 'director' });
        schedulePsyche(await great.load().catch(() => null));
        return result;
    }

    /** Указ, Нрав и psyche действующих — в контекст резолвера на @10. Пока Указов нет — честная строка. */
    async function decreeFor(names = null) {
        await sync();
        const state = await great.load();
        const entries = Object.values(state).map(character => ({ character }));
        // Пустой ростер (первый ход) — нрав и психология всех, у кого есть Указ: раньше на первом ходу резолвер
        // получал голый Указ, без отчёта Психолога и без того, как персонаж проявляет чувства.
        const filled = part => Object.values(part ?? {}).some(lines => Array.isArray(lines) && lines.some(line => String(line ?? '').trim()));
        const scene = Array.isArray(names) && names.length ? names
            : entries.filter(entry => !isUserCharacter(entry.character) && filled(entry.character?.decree)).map(entry => entry.character.name);
        const temper = scene.length ? renderTemperForResolver(entries, { names: scene }) : '';
        const psyche = scene.length ? renderPsycheForResolver(entries, { names: scene }) : '';
        // Сколько каждый знает пользователя — по часам игры, словами; вехи — из банка.
        const userName = entries.map(entry => entry.character).find(isUserCharacter)?.name || 'the user';
        const present = scene.map(name => entries.find(entry => String(entry.character?.name ?? '').toLowerCase() === String(name).toLowerCase())?.character)
            .filter(character => character && !isUserCharacter(character));
        const withUser = renderWithUser(present, { now: great.clockMinutes?.() ?? 0, user: userName });
        // Сроки — по RP-времени (метка с датой), как их ставит Директор.
        const deadlines = renderDeadlines(present, { now: (await great.rpNow?.().catch(() => null))?.value ?? 0 });
        // Психология первой: на ней читаются Указ и нрав, а не наоборот.
        return [psyche, withUser, deadlines, renderDecreeForResolver(entries, { names }), temper].filter(Boolean).join('\n\n');
    }

    /** Раздел, который увидит движок: нужен ответу инструмента и проверке прав. */
    const sectionOf = value => great.sectionOf(value);

    return { great, farContext, nearContext, writerContext, decreeFor, edit, ensurePsyche, rewritePsyche, holdPsyche, releasePsyche, sectionOf, historyFor: name => great.historyFor(name) };
}
