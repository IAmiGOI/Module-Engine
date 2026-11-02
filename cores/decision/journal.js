import { DECISION_MEMORY_NAMESPACE } from '../../libraries/core/decision-settings.js';

/**
 * Журнал хода: что отвергнутый ход успел записать в банк памяти и какие имена
 * выдал. Банк запоминается по изменившимся персонажам (ссылки на неизменённые
 * массивы совпадают), поэтому в снимок попадает только тронутое, а не весь
 * банк. Лог не откатывается — его циклы помечаются `rejected`.
 */
export function createJournal({ enqueue, call, getBank, setBank, getNames, setNames, getLog, setLog }) {
    let bankBaseline = {};
    let namesBaseline = [];
    let bankTracking = false;

    function beginTurn(track = true) {
        bankTracking = Boolean(track);
        bankBaseline = {};
        namesBaseline = [...getNames()];
        return { bank: bankBaseline, names: namesBaseline };
    }

    function rememberBank(before, after) {
        if (!bankTracking) return;
        const oldBank = before && typeof before === 'object' ? before : {};
        const newBank = after && typeof after === 'object' ? after : {};
        for (const character of new Set([...Object.keys(oldBank), ...Object.keys(newBank)])) {
            if (oldBank[character] === newBank[character]) continue;
            if (!Object.prototype.hasOwnProperty.call(bankBaseline, character)) {
                bankBaseline[character] = oldBank[character] ? JSON.parse(JSON.stringify(oldBank[character])) : null;
            }
        }
    }

    function restoreJournal(journal) {
        return enqueue(async () => {
            if (!journal || typeof journal !== 'object') return false;
            let bank = getBank() && typeof getBank() === 'object' ? getBank() : {};
            let changed = false;
            for (const [character, before] of Object.entries(journal.bank ?? {})) {
                const next = { ...bank };
                if (before === null) { if (Object.prototype.hasOwnProperty.call(next, character)) { delete next[character]; changed = true; } }
                else { next[character] = JSON.parse(JSON.stringify(before)); changed = true; }
                bank = next;
            }
            if (changed) {
                setBank(bank);
                await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'memoryBank', value: bank });
            }
            const names = getNames();
            if (Array.isArray(journal.names) && JSON.stringify(journal.names) !== JSON.stringify(names)) {
                setNames([...journal.names]);
                await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'names', value: getNames() });
            }
            return true;
        });
    }

    function markRejected(runId) {
        return enqueue(async () => {
            if (!runId) return false;
            let changed = false;
            const next = getLog().map(cycle => {
                if (cycle.runId !== runId || cycle.rejected) return cycle;
                changed = true;
                return { ...cycle, rejected: true, rejectedAt: Date.now() };
            });
            if (changed) {
                setLog(next);
                await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'log', value: next });
            }
            return changed;
        });
    }

    return { beginTurn, rememberBank, restoreJournal, markRejected };
}
