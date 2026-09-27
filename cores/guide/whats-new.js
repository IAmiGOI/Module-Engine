import { request } from '../../libraries/shared/request.js';
import { parseCompare, formatWhatsNew } from '../../libraries/core/guide-whatsnew.js';

const GITHUB_API = 'https://api.github.com';
const NETWORK_TIMEOUT_MS = 15000;
const KEY = 'lastCommit';

/**
 * «Что нового» гида: движок обновляется из git (Ядро самообновления), а гид помнит, на каком коммите его открывали в последний раз. Если коммит
 * сменился — спрашивает у GitHub список изменений между ними и отдаёт готовую реплику. Без модели и без затрат: пересказать человеческим
 * языком гид может по просьбе в чате. Молчит, когда сказать нечего: не git-установка, нет сети, первый запуск.
 *
 * `check()` → текст реплики | `null`. Отметку «видели» ставит только когда список получен или сравнивать нечего (коммит пропал из истории):
 * временный сбой сети не должен съесть сообщение.
 */
export function createWhatsNew({ host, call, read, write }) {
    async function compare(owner, repo, from, to) {
        const result = await request(host.network, 'http.request', {
            params: { url: `${GITHUB_API}/repos/${owner}/${repo}/compare/${from}...${to}`, method: 'GET', headers: { Accept: 'application/vnd.github+json' } },
            timeoutMs: NETWORK_TIMEOUT_MS,
        });
        if (!result.ok) return { failed: true };
        if (result.value?.status === 404) return { gone: true };
        if (!result.value?.ok) return { failed: true };
        try { return { data: JSON.parse(result.value.text) }; } catch { return { failed: true }; }
    }

    async function check({ hasChat = true } = {}) {
        const status = await call('selfUpdate.check');
        const current = status.ok && status.value?.checked ? status.value.currentCommitHash : null;
        if (!current) return null;
        const seen = await read(KEY, null);
        if (seen === current) return null;
        if (!seen || !hasChat) { await write(KEY, current); return null; }
        const repository = await call('selfUpdate.repository');
        if (!repository.ok || !repository.value?.owner) return null;
        const outcome = await compare(repository.value.owner, repository.value.repo, seen, current);
        if (outcome.failed) return null;
        await write(KEY, current);
        if (outcome.gone) return null;
        const changes = parseCompare(outcome.data);
        return changes.total ? formatWhatsNew(changes) : null;
    }

    return { check };
}
