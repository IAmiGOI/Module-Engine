import { request } from '../../libraries/shared/request.js';
import { stMainWorkerRecord, ST_MAIN_FORMAT } from '../../libraries/core/st-main-request.js';

/**
 * Действия гида — белый список того, что гид может предложить кнопкой в чате (блок ```action```). Каждое — через контракты движка
 * под правами Ядра гида или через реестр Модулей, переданный сборщиком; `description` уходит модели в системный промпт.
 * `run(params)` → `{ ok, message }`: сообщение показывается в чате заметкой.
 */
export function createGuideActions({ host, call, modules, reveal, checklist, markDone }) {
    return {
        'models.addSillyTavern': {
            description: 'Add SillyTavern\'s current connection as a model worker and check it. No params.',
            async run() {
                const main = await request(host.services, 'stGeneration.mainConnection');
                if (main.ok && main.value && !main.value.supported) return { ok: false, message: `SillyTavern's current API (${main.value.api || 'unknown'}) can't be used — switch it to Chat or Text Completion.` };
                const current = await call('model.workers.get');
                const list = current.ok ? current.value ?? [] : [];
                if (!list.some(worker => worker.format === ST_MAIN_FORMAT)) await call('model.workers.set', { workers: [...list, stMainWorkerRecord()] });
                const id = (list.find(worker => worker.format === ST_MAIN_FORMAT) ?? stMainWorkerRecord()).id;
                const probe = await call('model.workers.probe', { workerId: id });
                const up = probe.ok && probe.value?.[0]?.state === 'up';
                return { ok: up, message: up ? 'SillyTavern\'s connection is added and answers.' : `The connection didn't answer${probe.value?.[0]?.lastError ? `: ${probe.value[0].lastError.message}` : '.'}` };
            },
        },
        'models.check': {
            safe: true,
            description: 'Check all model connections now. No params.',
            async run() {
                const probe = await call('model.workers.probe', {});
                if (!probe.ok) return { ok: false, message: probe.error.message };
                const up = probe.value.filter(worker => worker.state === 'up');
                return { ok: up.length > 0, message: up.length ? `Working: ${up.map(worker => worker.workerId).join(', ')}.` : 'No connection answered.' };
            },
        },
        'modules.enable': {
            description: 'Turn a module on. Params: {"id": "<module id from the live state>"}.',
            async run({ id } = {}) {
                if (!modules?.list?.().some(item => item.id === id)) return { ok: false, message: `There is no module "${id}".` };
                await modules.enable(id);
                return { ok: true, message: `${modules.list().find(item => item.id === id)?.title ?? id} is on.` };
            },
        },
        'modules.disable': {
            description: 'Turn a module off. Params: {"id": "<module id>"}.',
            async run({ id } = {}) {
                if (!modules?.list?.().some(item => item.id === id)) return { ok: false, message: `There is no module "${id}".` };
                await modules.disable(id);
                return { ok: true, message: `${modules.list().find(item => item.id === id)?.title ?? id} is off.` };
            },
        },
        'ui.reveal': {
            safe: true,
            description: 'Open and highlight a block. Params: {"anchor": "<anchor>"}. Prefer a plain link for this.',
            async run({ anchor } = {}) { const result = await reveal(anchor); return { ok: result, message: result ? '' : `Couldn't find "${anchor}".` }; },
        },
        'checklist.mark': {
            safe: true,
            description: `Mark a first-start checklist item done. Params: {"id": one of ${checklist.map(item => `"${item.id}"`).join(', ')}}.`,
            async run({ id } = {}) {
                if (!checklist.some(item => item.id === id)) return { ok: false, message: `Unknown checklist item "${id}".` };
                await markDone(id);
                return { ok: true, message: 'Checked off.' };
            },
        },
    };
}
