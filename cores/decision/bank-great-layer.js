import { createGreatBank } from './bank-great.js';
import { renderDecreeForResolver } from '../../libraries/core/decision-bank-projections.js';

/**
 * Great Bank поверх банков-карточек: проекции (дальняя компактная, ближняя
 * полная, писателю), правка одним вызовом и предложения резолвера. Банки
 * чата — источник; Great Bank раскладывает их по разделам и правит строки.
 */
export function createGreatBankLayer({ call, store, banks, publishEvent = () => {}, getSettings = null }) {
    const great = createGreatBank({ call, store, banks, timeOfDay: () => getSettings?.()?.bankTimeOfDay ?? null });
    const sync = () => great.sync().catch(() => {});

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
        return result;
    }

    /** Указ действующих персонажей — в контекст резолвера на @10. Пока Указов нет — честная строка. */
    async function decreeFor(names = []) {
        await sync();
        const state = await great.load();
        const entries = Object.values(state).map(character => ({ character }));
        return renderDecreeForResolver(entries, { names });
    }

    /** Раздел, который увидит движок: нужен ответу инструмента и проверке прав. */
    const sectionOf = value => great.sectionOf(value);

    return { great, farContext, nearContext, writerContext, decreeFor, edit, sectionOf, historyFor: name => great.historyFor(name) };
}
