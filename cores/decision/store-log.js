import { totalLogTokens } from '../../libraries/core/decision-log.js';
import { sanitizeCycles } from './store-sanitize.js';

/**
 * Журнал циклов и архив полных циклов в памяти чата. Вынесено из
 * `store.js`, чтобы файл хранилища оставался ≤ 300 строк. В контекст
 * директора журнал больше не входит: его заменяет плавающее окно; архив
 * остаётся для окна директора.
 */
export function createLogStore({ enqueue, call, namespace }) {
    let log = [];
    let archive = [];

    function appendCycle(cycle) {
        return enqueue(async () => {
            log = [...log, cycle];
            await call('storage.chatMemory.set', { namespace, key: 'log', value: log });
            return cycle;
        });
    }

    /** Цикл по id: заменить, если уже есть, иначе дописать — так долгий цикл сохраняется по ходу работы. */
    function upsertCycle(cycle) {
        return enqueue(async () => {
            const index = log.findIndex(item => item?.id === cycle?.id);
            log = index >= 0 ? [...log.slice(0, index), cycle, ...log.slice(index + 1)] : [...log, cycle];
            await call('storage.chatMemory.set', { namespace, key: 'log', value: log });
            return cycle;
        });
    }

    function saveLog(next, { archived = [], archiveLimitTokens = 0 } = {}) {
        return enqueue(async () => {
            log = sanitizeCycles(next);
            if (archived.length) archive = [...archive, ...sanitizeCycles(archived)];
            if (archiveLimitTokens > 0) {
                while (archive.length > 1 && totalLogTokens(archive) > archiveLimitTokens) archive = archive.slice(1);
            }
            await call('storage.chatMemory.set', { namespace, key: 'log', value: log });
            if (archived.length) await call('storage.chatMemory.set', { namespace, key: 'logArchive', value: archive });
            return log;
        });
    }

    return {
        log: () => log,
        archive: () => archive,
        setLog: value => { log = value; },
        setArchive: value => { archive = value; },
        appendCycle,
        upsertCycle,
        saveLog,
        logTokens: () => totalLogTokens(log),
        load: data => {
            log = sanitizeCycles(data?.log);
            archive = sanitizeCycles(data?.logArchive);
        },
    };
}
