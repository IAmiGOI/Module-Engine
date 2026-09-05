import { request } from '../../libraries/shared/request.js';
import { commitsMatch, describeUpdateDiagnosis, parseCommitSha } from '../../libraries/core/update-check.js';

/**
 * Ядро самообновления — движок сам подтягивает себя из своего репозитория.
 *
 * Механика та же, что у Alpha: спросить у SillyTavern её собственные
 * git-эндпоинты (за ними стоит кнопка «Update» в её менеджере расширений) и,
 * если мы отстали, попросить её же сделать `git pull`. Своего клонирования и
 * своей распаковки здесь нет и не нужно.
 *
 * Сверх этого — **прямая сверка кода с GitHub**. ST отвечает «свежо» или
 * «отстал» как чёрный ящик; мы отдельно спрашиваем у GitHub настоящий HEAD
 * ветки и сравниваем с тем коммитом, на котором ST нас считает. Сверка
 * ПО КОММИТУ, а не по дате: в этом проекте бывает по два десятка коммитов в
 * день, и «сегодня» — слишком грубая единица, чтобы что-то значить.
 *
 * ## Три бага Alpha, которые здесь не должны повториться
 *
 * 1. **Не угадывать тип установки по адресу.** Общая («для всех») и личная
 *    («только себе») отдаются с ОДИНАКОВОГО адреса
 *    `/scripts/extensions/third-party/<name>/`; различить их по нему
 *    невозможно в принципе. Спрашиваем `/api/extensions/discover`, как это
 *    делает сама ST. Не смогли определить — считаем «не общая»: ошибка в эту
 *    сторону даёт безобидный 404 у редкой общей установки, а в другую —
 *    ломала обновление у самой частой личной.
 * 2. **Отметка о попытке — ВРЕМЯ, а не флаг.** Постоянный `'1'` после первого
 *    же удачного обновления навсегда блокировал проверки до конца жизни
 *    вкладки.
 * 3. **Сверка обязана быть наблюдателем.** Она не влияет на то, применится ли
 *    обновление, и её собственный сбой не мешает ничему: иначе недоступный
 *    GitHub означал бы «не обновляться».
 *
 * Молчит, если сказать нечего: не git-установка, нет сети, уже свежее — всё
 * это проходит без единого следа в интерфейсе.
 */

const SESSION_KEY = 'stme.beta.updateAttemptedAt';
/** Пауза между попытками. Не «раз в сессию»: после применённого обновления страница перезагружается, и вторая проверка сразу за ней — норма, а не повод молчать до конца вкладки. */
const RETRY_COOLDOWN_MS = 20000;
const GITHUB_API = 'https://api.github.com';

export function createSelfUpdateCore(host, {
    extensionName,
    owner,
    repo,
    log = console,
    now = () => Date.now(),
    cooldownMs = RETRY_COOLDOWN_MS,
} = {}) {
    async function service(contract, params) {
        return request(host.services, contract, { params });
    }

    /**
     * Общая ли это установка. Спрашиваем ST, а не гадаем по адресу — см.
     * заголовок файла, пункт 1. Любой сбой — «не общая»: сознательный выбор
     * безопасной стороны, а не недосмотр.
     */
    async function isGlobalInstall() {
        if (!extensionName) return false;
        const result = await service('stExtensions.discover');
        if (!result.ok || !Array.isArray(result.value)) return false;
        const entry = result.value.find(item => item?.name === extensionName || item?.name === `third-party/${extensionName}`);
        return entry?.type === 'global';
    }

    /**
     * `{ checked: false }` на всё, что мешает дать настоящий ответ, и вызывающий
     * обязан принять это как «идём дальше молча». Поля `currentCommitHash` и
     * `currentBranchName` ST отдаёт сама — Alpha их выбрасывала, а без них
     * сверить с GitHub нечего.
     */
    async function check() {
        if (!extensionName) return { checked: false };
        const global = await isGlobalInstall();
        const result = await service('stExtensions.version', { extensionName, global });
        if (!result.ok) {
            log.info?.('[ST Module Engine (Beta)] Update check skipped (not a git install, or the check failed):', result.error.message);
            return { checked: false };
        }
        return {
            checked: true,
            global,
            upToDate: Boolean(result.value?.isUpToDate),
            currentCommitHash: result.value?.currentCommitHash || null,
            currentBranchName: result.value?.currentBranchName || null,
            remoteUrl: result.value?.remoteUrl || null,
        };
    }

    /**
     * Настоящий HEAD ветки прямо с GitHub. Идёт через СЕТЕВУЮ Шину, то есть
     * через отдельный сетевой Гейт: у Ядра должно быть явное право выходить в
     * интернет, и самообновление здесь не исключение.
     */
    async function fetchRemoteSha(branch) {
        const result = await request(host.network, 'http.request', {
            params: {
                url: `${GITHUB_API}/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
                method: 'GET',
                headers: { Accept: 'application/vnd.github.sha' },
            },
        });
        if (!result.ok || !result.value?.ok) return null;
        return parseCommitSha(result.value.text);
    }

    /** Сверка. Никогда не бросает и ни на что не влияет — только наблюдает. */
    async function diagnose({ currentCommitHash, currentBranchName } = {}) {
        if (!currentCommitHash || !currentBranchName) return { applicable: false };
        const remoteSha = await fetchRemoteSha(currentBranchName);
        if (!remoteSha) return { applicable: false };
        return {
            applicable: true,
            matches: commitsMatch(currentCommitHash, remoteSha),
            localSha: currentCommitHash,
            remoteSha,
            branch: currentBranchName,
        };
    }

    async function apply({ global = false } = {}) {
        if (!extensionName) return { applied: false, error: 'Could not determine this extension\'s folder name.' };
        const result = await service('stExtensions.update', { extensionName, global });
        if (!result.ok) {
            log.error?.('[ST Module Engine (Beta)] Self-update failed:', result.error.message);
            return { applied: false, error: result.error.message };
        }
        return { applied: true, upToDate: Boolean(result.value?.isUpToDate) };
    }

    async function attemptedRecently() {
        const stored = await service('session.get', { key: SESSION_KEY, fallback: '0' });
        return now() - Number(stored.ok ? stored.value : 0) < cooldownMs;
    }

    /**
     * Весь ход целиком: проверить → сверить с GitHub → при необходимости
     * обновиться и перезагрузиться.
     *
     * `force` пропускает паузу: явное нажатие пользователя не должно молча
     * игнорироваться. Возвращает, ЧТО именно произошло, — вызывающему
     * (панели) есть что показать, а тесту есть что проверить.
     */
    async function run({ force = false } = {}) {
        if (!force && await attemptedRecently()) return { outcome: 'cooling-down' };

        const status = await check();
        if (!status.checked) return { outcome: 'unavailable' };

        // Сверка запускается ДО решения и её результат только пишется в
        // консоль: она наблюдатель, а не участник.
        const diagnosis = await diagnose(status);
        const described = describeUpdateDiagnosis(diagnosis, { upToDate: status.upToDate });
        if (described) log[described.level]?.(`[ST Module Engine (Beta)] Update check: ${described.text}`);

        if (status.upToDate) return { outcome: 'up-to-date', diagnosis };

        await service('session.set', { key: SESSION_KEY, value: now() });
        const applied = await apply({ global: status.global });
        if (!applied.applied) return { outcome: 'failed', error: applied.error, diagnosis };

        await service('session.reload');
        return { outcome: 'updated', diagnosis };
    }

    const unregisters = [
        host.own.register('selfUpdate.check', () => check()),
        host.own.register('selfUpdate.run', params => run(params)),
        host.own.register('selfUpdate.repository', () => ({ owner, repo, extensionName })),
    ];

    return {
        check,
        diagnose,
        apply,
        run,
        isGlobalInstall,
        unregister: () => { for (const unregister of unregisters) unregister(); },
    };
}
