/**
 * Чистая арифметика проверки обновлений — без сети, без ST, без DOM.
 *
 * Вынесено отдельно, потому что вся содержательная часть здесь ровно в трёх
 * решениях, и каждое из них в Alpha хоть раз оказывалось неверным (см.
 * cores/self-update — там записана история трёх багов подряд). Проверяются
 * они как функции, а не как поведение целого движка.
 */

/**
 * Имя папки расширения из адреса его же скрипта.
 *
 * Оно же — `extensionName`, которого ждут эндпоинты обновления ST. Форма
 * адреса одинакова и для установки «для всех», и для «только себе»:
 * `.../scripts/extensions/third-party/<name>/index.js`. Различить их ПО АДРЕСУ
 * невозможно — на этом Alpha и обожглась (см. `isGlobalInstall` в Сервисе).
 *
 * `null`, а не бросок, если адрес вообще не той формы: вне настоящей страницы
 * ST (тесты, узлы) это нормальное состояние, а не ошибка.
 */
export function deriveExtensionName(url) {
    const match = String(url ?? '').match(/\/extensions\/(?:third-party\/)?([^/]+)\/[^/]*$/);
    return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Ответ GitHub на запрос «какой сейчас HEAD у ветки» → чистый SHA.
 *
 * С заголовком `Accept: application/vnd.github.sha` тело ответа — это ровно
 * сорок символов SHA. Но между нами и GitHub бывает прокси, срезающий чужие
 * заголовки, и тогда приходит обычный JSON коммита — поэтому разбор с
 * запасным путём, а не жёсткая проверка формата.
 */
export function parseCommitSha(text) {
    const trimmed = String(text ?? '').trim();
    if (/^[0-9a-f]{40}$/i.test(trimmed)) return trimmed;
    try {
        const data = JSON.parse(trimmed);
        return typeof data?.sha === 'string' ? data.sha : null;
    } catch {
        return null;
    }
}

/**
 * Совпадают ли коммиты. Регистр не важен: ST и GitHub возвращают SHA в разном
 * регистре, и сравнение «как есть» дало бы вечное «не совпадает».
 */
export function commitsMatch(localSha, remoteSha) {
    if (!localSha || !remoteSha) return false;
    return String(localSha).toLowerCase() === String(remoteSha).toLowerCase();
}

/**
 * Что именно сказать в консоль по итогам сверки. Три состояния, и среднее —
 * то самое, ради чего сверка вообще существует: ST говорит «всё свежее», а
 * коммиты разные. У Alpha этот случай месяцами оставался догадкой, потому что
 * доказать его было нечем.
 */
export function describeUpdateDiagnosis({ applicable, matches, localSha, remoteSha, branch }, { upToDate } = {}) {
    if (!applicable) return null;
    const local = String(localSha).slice(0, 7);
    const remote = String(remoteSha).slice(0, 7);
    if (matches) return { level: 'info', text: `local commit ${local} matches GitHub's latest on "${branch}".` };
    if (upToDate) {
        return {
            level: 'warn',
            text: `MISMATCH: SillyTavern reported up to date at commit ${local}, but GitHub's latest on "${branch}" is ${remote}. The local checkout is stuck behind origin despite the update endpoint saying otherwise.`,
        };
    }
    return { level: 'info', text: `local commit ${local} is behind GitHub's latest ${remote} on "${branch}" — an update is about to be applied.` };
}
