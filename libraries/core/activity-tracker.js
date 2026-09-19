/**
 * Учёт параллельной работы для светофора активности — чистая машина состояний без таймеров и без DOM.
 *
 * Зачем. Раньше светофор был одной переменной «последнее событие побеждает»: когда саммари заканчивало свёртку (событие
 * «успех»), пока сама генерация ответа ещё шла, лампочка сразу показывала «готово». Здесь работа считается ЗАДАЧАМИ: каждая
 * начатая задача держит светофор в `working`, пока она не завершена; итог показывается только когда закончились ВСЕ.
 *
 * Правила:
 *  - `start(key)` — задача идёт; пока задач хоть одна, показывается `working`;
 *  - `end(key, result)` — задача закончилась с итогом `success | warning | error`; если задач больше нет, показывается худший
 *    итог из всего накопленного (error > warning > success), иначе итог откладывается до конца остальных;
 *  - `result(r)` — итог события, у которого своей задачи нет (например, «саммари свернулось»): при работающих задачах он
 *    откладывается (и учитывается в итоге), при простое показывается сразу;
 *  - `touch(key)` — «задача жива» (продлевает срок), не меняет состояния; задача, о которой давно ничего не слышно
 *    (`ttlMs`), считается зависшей и молча снимается: лампочка не должна вечно гореть оранжевым из-за потерянного события;
 *  - показанный итог — `terminal`; сбрасывает его в покой владелец таймера (`clearTerminal()`), а новая задача перебивает его сразу.
 */

const SEVERITY = { success: 1, warning: 2, error: 3 };

export function worstResult(results) {
    let worst = null;
    for (const result of results) if (result && (!worst || SEVERITY[result] > SEVERITY[worst])) worst = result;
    return worst;
}

export function createActivityTracker({ now = Date.now, ttlMs = 10 * 60 * 1000 } = {}) {
    const jobs = new Map();   // key -> метка времени последнего признака жизни
    let results = [];         // итоги, накопленные с начала текущей «пачки» работы
    let terminal = null;      // показанный сейчас итог, если работы нет

    function sweep() {
        const cutoff = now() - ttlMs;
        let dropped = false;
        for (const [key, seenAt] of jobs) if (seenAt < cutoff) { jobs.delete(key); results.push('warning'); dropped = true; }
        if (dropped && jobs.size === 0) settle();
    }

    function settle() {
        terminal = worstResult(results);
        results = [];
    }

    function start(key) {
        sweep();
        if (jobs.size === 0) { results = []; terminal = null; }
        jobs.set(key, now());
    }

    function touch(key) {
        if (jobs.has(key)) jobs.set(key, now());
    }

    function end(key, resultValue) {
        sweep();
        if (!jobs.delete(key)) { result(resultValue); return; }
        results.push(resultValue);
        if (jobs.size === 0) settle();
    }

    function result(resultValue) {
        sweep();
        if (jobs.size > 0) { results.push(resultValue); return; }
        results = [resultValue];
        settle();
    }

    return {
        start, touch, end, result, sweep,
        /** Что показывать сейчас: `working`, показанный итог или `idle`. */
        display() { sweep(); return jobs.size > 0 ? 'working' : (terminal ?? 'idle'); },
        /** Итог показан и его время вышло — вернуться в покой. */
        clearTerminal() { terminal = null; },
        active() { return jobs.size > 0; },
        jobs: () => [...jobs.keys()],
    };
}
