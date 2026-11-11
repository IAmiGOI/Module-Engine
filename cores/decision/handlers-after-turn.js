import { findCharacter } from '../../libraries/core/decision-great-bank.js';
import { buildLedgerRows, isClosedTelegram } from '../../libraries/core/decision-ledger.js';
import { createFileLayer } from './files-layer.js';

/**
 * `after_turn` — единственная запись после ответа писателя. Исход хода и
 * изменения идут по тексту страницы; Молитва и Телеграмма сохраняются и
 * видны в журнале, а Телеграмма ставит флаг «следующий ход ждёт Указа»
 * (ожидание включится в фазе 4).
 */
export function createAfterTurnHandler({ store, banks = null, knowledge = null, state = {}, publishEvent = () => {} }) {
    return async args => {
        const form = state.lastForm && typeof state.lastForm === 'object' ? state.lastForm : null;
        const writerText = String(state.lastWriterText ?? '');
        const outcome = (Array.isArray(args.outcome) ? args.outcome : [])
            .filter(item => item && typeof item === 'object')
            .map(item => ({ character: String(item.character ?? '').trim(), result: String(item.result ?? '').trim() }))
            .filter(item => item.character);
        const results = [];

        // Изменения — файлами, как у директора (`edits`, часть 21): material.md и knowledge.md; права резолвера — в файловом слое.
        if (Array.isArray(args.edits) && args.edits.length && banks?.great) {
            const files = createFileLayer({ banks, knowledge });
            const edited = await files.edit({ edits: args.edits, comment: String(args.comment ?? '').trim() }, { by: 'resolver' });
            for (const file of edited.files ?? []) results.push({ kind: 'file', path: file.path, ok: file.ok, ...(file.note ? { note: file.note } : {}) });
        }
        // Старая форма `bankEdits` — тем же движком, что `bank_edit`.
        if (Array.isArray(args.bankEdits) && args.bankEdits.length && banks?.edit) {
            const edited = await banks.edit({ comment: String(args.comment ?? '').trim(), edits: args.bankEdits }, { by: 'resolver' });
            for (const change of edited.changes ?? []) {
                if (change.kind === 'knowledge') {
                    if (knowledge?.handlers?.character_knowledge && String(change.new ?? '').trim()) {
                        const added = await knowledge.handlers.character_knowledge({ op: 'add', character: change.character, fact: change.new, comment: String(args.comment ?? '') });
                        results.push({ kind: 'knowledge', character: change.character, ok: added.ok !== false });
                    }
                    continue;
                }
                results.push({ kind: 'bank', character: change.character, part: change.part, section: change.section, pending: Boolean(change.pending) });
            }
        }

        // Цель дня из Указа каждого — для «хотел» в Ведомости.
        const great = banks?.great?.load ? await banks.great.load().catch(() => null) : null;
        const wantedOf = name => {
            const character = great ? findCharacter(great, name) : null;
            const lines = Object.values(character?.decree ?? {}).flat().map(line => String(line ?? ''));
            const today = lines.find(line => /(^|\]\s*)Today:/i.test(line));
            return today ? today.replace(/^\[[^\]]*\]\s*/, '').replace(/^Today:\s*/i, '').trim() : '';
        };
        const rows = buildLedgerRows({ turn: state.turnCounter, at: Date.now(), form, outcome, writerText, wantedOf });
        const ledger = await store.appendLedger?.(rows).catch(() => null);
        if (!ledger && typeof store.saveLedger === 'function') await store.saveLedger(rows).catch(() => {});

        const prayer = String(args.prayer ?? '').trim();
        if (prayer) {
            await store.addPrayer?.({ at: Date.now(), turn: state.turnCounter, text: prayer }).catch(() => {});
            publishEvent('decision.prayer', { turn: state.turnCounter, text: prayer });
        }
        let blocked = false;
        const telegram = String(args.telegram ?? '').trim();
        if (telegram) {
            // Закрытый список поводов: вне его Телеграмма не блокирует ход, но остаётся в журнале.
            blocked = isClosedTelegram(telegram);
            await store.addTelegram?.({ at: Date.now(), turn: state.turnCounter, text: telegram, blocked }).catch(() => {});
            publishEvent('decision.telegram', { turn: state.turnCounter, text: telegram, blocked });
            if (blocked) await store.saveAwaitingDecree?.({ since: Date.now(), turn: state.turnCounter, why: telegram }).catch(() => {});
        }
        return {
            ok: true, outcome: outcome.length, changes: results.length, rows: rows.length,
            ...(prayer ? { prayer: true } : {}),
            ...(telegram ? { telegram: true, blocked } : {}),
        };
    };
}
