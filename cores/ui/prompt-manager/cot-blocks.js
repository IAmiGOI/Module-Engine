import { request } from '../../../libraries/shared/request.js';

const BLOCK_CLASS = 'stme-cot-block';

/**
 * Свёрнутый блок Guided CoT под сообщением в чате (решение владельца: «ответ шагов — свёрнутый блок, сохраняется в метаданные
 * сообщения, в историю следующих ходов не уходит»). Только DOM: в `message.mes` не пишется ни байта, поэтому модель этот блок
 * не увидит. Записи лежат в памяти чата (`promptManager.cotRecords`, ключ — номер сообщения). `attach()` идемпотентен и чинит
 * то, что перерисовка ST стёрла; зовётся по событиям ST.
 */
export function createCotBlocks(host) {
    const own = (contract, params) => request(host.own, contract, { params });
    const service = async (contract, params) => { const result = await request(host.services, contract, { params }); return result.ok ? result.value : null; };

    async function build(record) {
        const details = await service('dom.createElement', { tag: 'details' });
        await service('dom.setProp', { el: details, key: 'class', value: BLOCK_CLASS });
        const summary = await service('dom.createElement', { tag: 'summary' });
        await service('dom.append', { parent: summary, child: await service('dom.createTextNode', { text: `Thinking · ${record.steps.length} step${record.steps.length === 1 ? '' : 's'}` }) });
        await service('dom.append', { parent: details, child: summary });
        for (const step of record.steps) {
            const title = await service('dom.createElement', { tag: 'strong' });
            await service('dom.append', { parent: title, child: await service('dom.createTextNode', { text: step.name || 'Step' }) });
            const body = await service('dom.createElement', { tag: 'pre' });
            await service('dom.append', { parent: body, child: await service('dom.createTextNode', { text: step.text }) });
            await service('dom.append', { parent: details, child: title });
            await service('dom.append', { parent: details, child: body });
        }
        return details;
    }

    async function attach() {
        const answer = await own('promptManager.cotRecords');
        const records = answer.ok ? answer.value ?? {} : {};
        for (const [index, record] of Object.entries(records)) {
            const element = await service('stChat.messageElement', { mesid: index });
            if (!element || element.querySelector?.(`:scope > .${BLOCK_CLASS}`)) continue;
            const block = await build(record);
            if (block) await service('dom.append', { parent: element, child: block });
        }
        return true;
    }

    const subscriptions = ['st.chatChanged', 'st.messageSwiped', 'st.messageEdited', 'st.messageUpdated', 'st.characterMessageRendered', 'st.userMessageRendered', 'promptManager.cotDone']
        .map(event => host.events.subscribe(event, () => { setTimeout(() => { attach().catch(() => {}); }, 150); }));
    return { attach, stop: () => subscriptions.forEach(unsubscribe => unsubscribe?.()) };
}
