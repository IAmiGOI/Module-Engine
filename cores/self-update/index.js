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

const SESSION_KEY = 'stme.beta.updateAttempt';
/**
 * Пауза между попытками. Не «раз в сессию»: после применённого обновления
 * страница перезагружается, и вторая проверка сразу за ней — норма, а не
 * повод молчать до конца вкладки. Защищает только сам ШАГ «нашли отставание →
 * тянем → перезагружаемся» (см. `attemptedRecently()`) — просто ПРОВЕРКА
 * ничего не зацикливает и ею никогда не гейтится.
 */
const RETRY_COOLDOWN_MS = 20000;
/** Ни один сетевой шаг самообновления не имеет права висеть дольше этого — иначе перекрытие экрана виснет вместе с ним, и единственный выход у пользователя — перезагрузка, которая сама попадает в паузу остывания молча. */
const NETWORK_TIMEOUT_MS = 15000;
/** Сам `git pull` — файловая/сетевая операция на СТОРОНЕ ST, вправе занять чуть больше, чем простой опрос статуса. */
const APPLY_TIMEOUT_MS = 30000;
const GITHUB_API = 'https://api.github.com';

export function createSelfUpdateCore(host, {
    extensionName,
    owner,
    repo,
    log = console,
    now = () => Date.now(),
    cooldownMs = RETRY_COOLDOWN_MS,
    networkTimeoutMs = NETWORK_TIMEOUT_MS,
    applyTimeoutMs = APPLY_TIMEOUT_MS,
    publish,
} = {}) {
    // Публикация — через Ядро событий (защиты, реестр поверхности); прямой
    // эмит оставлен для узких тестов, поднимающих это Ядро в одиночку.
    const publishEvent = publish ?? ((event, payload) => host.events.emit(event, payload));

    /** `timeoutMs` только на РЕАЛЬНО сетевых шагах (см. вызовы ниже) — сессия/локальные контракты внутри движка не виснут никогда, таймаут им только мешал бы. */
    async function service(contract, params, { timeoutMs } = {}) {
        return request(host.services, contract, { params, timeoutMs });
    }

    /**
     * Общая ли это установка. Спрашиваем ST, а не гадаем по адресу — см.
     * заголовок файла, пункт 1. Любой сбой — «не общая»: сознательный выбор
     * безопасной стороны, а не недосмотр.
     */
    async function isGlobalInstall() {
        if (!extensionName) return false;
        const result = await service('stExtensions.discover', {}, { timeoutMs: networkTimeoutMs });
        if (!result.ok || !Array.isArray(result.value)) return false;
        const entry = result.value.find(item => item?.name === extensionName || item?.name === `third-party/${extensionName}`);
        return entry?.type === 'global';
    }

    /** Один запрос версии под конкретное предположение о типе установки. */
    async function askVersion(global) {
        const result = await service('stExtensions.version', { extensionName, global }, { timeoutMs: networkTimeoutMs });
        if (!result.ok) return { ok: false, reason: `${global ? 'global' : 'per-user'} lookup: ${result.error.message}` };
        return {
            ok: true,
            status: {
                checked: true,
                global,
                upToDate: Boolean(result.value?.isUpToDate),
                currentCommitHash: result.value?.currentCommitHash || null,
                currentBranchName: result.value?.currentBranchName || null,
                remoteUrl: result.value?.remoteUrl || null,
            },
        };
    }

    /**
     * `{ checked: false }` на всё, что мешает дать настоящий ответ, и вызывающий
     * обязан принять это как «идём дальше молча». Поля `currentCommitHash` и
     * `currentBranchName` ST отдаёт сама — Alpha их выбрасывала, а без них
     * сверить с GitHub нечего.
     *
     * **Догадка о типе установки ПРОВЕРЯЕТСЯ, а не принимается на веру.** От
     * неё зависит, в какой папке ST будет искать расширение: у общей —
     * `public/scripts/extensions/third-party`, у личной —
     * `data/<пользователь>/extensions`. Промах означает 404 и полное молчание —
     * ровно та болезнь Alpha, от которой `/discover` и спасал. Но `/discover`
     * сам может быть недоступен, а его ответ мы обязаны были принять как
     * окончательный — и тогда молчание возвращалось. Поэтому при отказе первой
     * попытки пробуем ВТОРОЙ вариант: лишний запрос дешевле неработающего
     * обновления.
     *
     * Причина отказа больше не теряется — `reason` доходит до панели. «Молчит,
     * когда сказать нечего» слишком легко превращается в «молчит всегда», и
     * отличить работающее обновление от сломанного становится нечем.
     */
    async function check() {
        if (!extensionName) {
            return { checked: false, reason: 'Could not work out this extension\'s folder name from its script URL.' };
        }
        const guessed = await isGlobalInstall();
        const first = await askVersion(guessed);
        if (first.ok) return first.status;
        const second = await askVersion(!guessed);
        if (second.ok) return second.status;

        const reason = `${first.reason}; ${second.reason}`;
        log.info?.('[ST Module Engine (Beta)] Update check skipped (not a git install, or the check failed):', reason);
        return { checked: false, reason };
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
            timeoutMs: networkTimeoutMs,
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
        const result = await service('stExtensions.update', { extensionName, global }, { timeoutMs: applyTimeoutMs });
        if (!result.ok) {
            log.error?.('[ST Module Engine (Beta)] Self-update failed:', result.error.message);
            return { applied: false, error: result.error.message };
        }
        return { applied: true, upToDate: Boolean(result.value?.isUpToDate) };
    }

    /** Читает последнюю попытку из сессии — `null`, если её не было или запись повреждена (никогда не бросает). */
    async function lastAttempt() {
        const stored = await service('session.get', { key: SESSION_KEY, fallback: null });
        if (!stored.ok || !stored.value) return null;
        try {
            const parsed = JSON.parse(stored.value);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch {
            return null;
        }
    }

    function recordAttempt(outcome, extra = {}) {
        return service('session.set', { key: SESSION_KEY, value: JSON.stringify({ at: now(), outcome, ...extra }) });
    }

    /**
     * Остыла ли пауза. `pending` — попытка НАЧАЛАСЬ, но её исход неизвестен:
     * либо `apply()` до сих пор идёт (тогда `run()` и так не позовут второй
     * раз параллельно с самим собой — незачем и рано), либо страница
     * перезагрузилась или закрылась ПОСЕРЕДИНЕ, а мы этого не увидели. Во
     * втором случае бы молчать паузой значило бы просто повторить тот же
     * симптом «после зависшего обновления ничего не происходит», от которого
     * теперь спасает `networkTimeoutMs`/`applyTimeoutMs` — но защититься сразу
     * с обеих сторон надёжнее, чем понадеяться на один таймаут. Поэтому
     * `pending` НЕ считается остыванием: следующая попытка идёт сразу же, а
     * `apply()` в любом случае безопасно повторить — она либо уже применилась
     * (тогда ST тут же ответит «свежо»), либо нет (тогда просто дотянется).
     */
    async function attemptedRecently() {
        const last = await lastAttempt();
        if (!last || last.outcome === 'pending') return false;
        return now() - Number(last.at ?? 0) < cooldownMs;
    }

    /**
     * Весь ход целиком: проверить → сверить с GitHub → при необходимости
     * обновиться и перезагрузиться.
     *
     * `force` пропускает паузу: явное нажатие пользователя не должно молча
     * игнорироваться. Возвращает, ЧТО именно произошло, — вызывающему
     * (панели) есть что показать, а тесту есть что проверить.
     *
     * **Ход ОБЪЯВЛЯЕТСЯ, а не показывается.** События `selfUpdate.started`/
     * `applied`/`failed`/`upToDate` — всё, что это Ядро делает для интерфейса;
     * перекрытие экрана и полосу с «Retry» рисует [Ядро экрана
     * обновления](../ui/update-overlay.js), которое про git не знает вовсе. У
     * Alpha `attemptCoreUpdate()` сам создавал и удалял свои узлы, то есть ход
     * обновления и его показ были одним куском кода, и разделить их было негде.
     */
    async function run({ force = false } = {}) {
        if (!force && await attemptedRecently()) {
            // Автоматическая проверка при загрузке молчала бы точно так же, как
            // и раньше — но если ПРОШЛАЯ попытка в это самое окно остывания
            // закончилась неудачей, полоса с причиной обязана вернуться и после
            // перезагрузки, а не пропасть вместе с ней: иначе «обновление не
            // работает» неотличимо от «обновляться нечего», ровно то, из-за
            // чего перезагрузка выглядела так, будто вообще ничего не
            // происходит.
            const last = await lastAttempt();
            if (last?.outcome === 'failed') publishEvent('selfUpdate.failed', { reason: last.reason ?? null });
            return { outcome: 'cooling-down', lastOutcome: last?.outcome ?? null };
        }

        const status = await check();
        if (!status.checked) {
            const reason = status.reason ?? null;
            // Не-git установка — не поломка: показывать нечего. Но если человек
            // нажал кнопку сам, промолчать в ответ нельзя.
            if (force) publishEvent('selfUpdate.failed', { reason });
            return { outcome: 'unavailable', reason };
        }

        // Сверка запускается ДО решения и её результат только пишется в
        // консоль: она наблюдатель, а не участник.
        const diagnosis = await diagnose(status);
        const described = describeUpdateDiagnosis(diagnosis, { upToDate: status.upToDate });
        if (described) log[described.level]?.(`[ST Module Engine (Beta)] Update check: ${described.text}`);

        if (status.upToDate) {
            publishEvent('selfUpdate.upToDate', { commit: status.currentCommitHash, branch: status.currentBranchName });
            return { outcome: 'up-to-date', diagnosis };
        }

        // Отсюда и до перезагрузки экран перекрыт: код меняется под ногами, и
        // работать с наполовину заменённым движком нельзя. Пауза остывания
        // защищает ИМЕННО этот шаг (не сам по себе просмотр статуса) — только
        // отсюда и пишется отметка попытки.
        publishEvent('selfUpdate.started', { branch: status.currentBranchName });
        await recordAttempt('pending');
        const applied = await apply({ global: status.global });
        if (!applied.applied) {
            await recordAttempt('failed', { reason: applied.error ?? null });
            publishEvent('selfUpdate.failed', { reason: applied.error ?? null });
            return { outcome: 'failed', error: applied.error, diagnosis };
        }

        await recordAttempt('updated');
        publishEvent('selfUpdate.applied', { branch: status.currentBranchName });
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
