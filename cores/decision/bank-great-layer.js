import { createGreatBank } from './bank-great.js';
import { createPsychologist } from './psychologist.js';
import { renderDecreeForResolver, renderTemperForResolver, renderPsycheForResolver } from '../../libraries/core/decision-bank-projections.js';

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
        const inScene = Array.isArray(names) && names.length;
        const temper = inScene ? renderTemperForResolver(entries, { names }) : '';
        const psyche = inScene ? renderPsycheForResolver(entries, { names }) : '';
        return [renderDecreeForResolver(entries, { names }), temper, psyche].filter(Boolean).join('\n\n');
    }

    /** Раздел, который увидит движок: нужен ответу инструмента и проверке прав. */
    const sectionOf = value => great.sectionOf(value);

    return { great, farContext, nearContext, writerContext, decreeFor, edit, ensurePsyche, holdPsyche, releasePsyche, sectionOf, historyFor: name => great.historyFor(name) };
}
