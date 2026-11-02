/**
 * Очередь событий директора. Между циклами он «ждёт» (`awaiting`), во время
 * хода — нет. Сообщение пользователю и отчёт субагента не мешают ходу: пока
 * цикл идёт, они лежат в очереди и запускаются строго по одному после него.
 */
export function createWakeQueue({ enqueue, publishEvent }) {
    // Ядро стартует между циклами: первое событие не должно ждать пустого хода.
    let awaiting = true;
    const jobs = [];

    function drain() {
        if (!awaiting || !jobs.length) return;
        const job = jobs.shift();
        enqueue(async () => {
            awaiting = false;
            try { return await job(); }
            finally { awaiting = true; drain(); }
        }).catch(error => publishEvent('decision.cycle.failed', { runId: null, message: error?.message ?? String(error) }));
    }

    /** Выполнить сейчас, не дожидаясь конца текущего цикла. */
    function runNow(job) {
        return enqueue(async () => {
            awaiting = false;
            try { return await job(); }
            finally { awaiting = true; drain(); }
        });
    }

    /** Ждёт ли директор события: если да — сразу, иначе в очередь. */
    function schedule(job) {
        if (awaiting) return runNow(job);
        jobs.push(job);
        return Promise.resolve({ queued: true });
    }

    return {
        begin: () => { awaiting = false; },
        rest: () => { awaiting = true; drain(); },
        isAwaiting: () => awaiting,
        schedule,
        runNow,
        drain,
        queued: () => jobs.length,
    };
}
