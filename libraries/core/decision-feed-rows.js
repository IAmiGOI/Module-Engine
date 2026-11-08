/**
 * Строки ленты, которые строятся из вызова инструмента, а не из формы:
 * «после хода» — Ведомость, Молитва и Телеграмма. Вынесено из
 * `decision-feed.js`, чтобы файл держался в пределах 300 строк.
 */

const text = value => String(value ?? '').trim();

/** Вызовы `after_turn`: Ведомость, Молитва и Телеграмма видны в ленте отдельными строками. */
export function afterTurnRows(call, index) {
    const args = call?.args && typeof call.args === 'object' ? call.args : {};
    const result = call?.result && typeof call.result === 'object' ? call.result : {};
    if (call?.name !== 'after_turn' || result.ok === false) return [];
    const rows = [];
    const outcome = (Array.isArray(args.outcome) ? args.outcome : [])
        .map(item => [text(item?.character), text(item?.result)])
        .filter(([character]) => character)
        .map(([character, entry]) => `- ${character}: ${entry || '(nothing)'}`);
    if (outcome.length) rows.push({ kind: 'ledger', id: `ledger_${index}`, text: outcome.join('\n') });
    if (text(args.prayer)) rows.push({ kind: 'prayer', id: `prayer_${index}`, text: text(args.prayer) });
    if (text(args.telegram)) rows.push({ kind: 'telegram', id: `telegram_${index}`, text: text(args.telegram), blocked: Boolean(result.blocked) });
    return rows;
}

/**
 * Вызовы Советника: разбор Ведомости (Petition или nothing_yet), ответ
 * пользователю и Молитва — отдельными строками журнала.
 */
export function counsellorRows(call, index) {
    const args = call?.args && typeof call.args === 'object' ? call.args : {};
    const result = call?.result && typeof call.result === 'object' ? call.result : {};
    if (result.ok === false) return [];
    if (call?.name === 'petition') {
        return [{
            kind: 'petition', id: `petition_${index}`, character: text(args.character),
            problem: text(args.problem), excerpt: text(args.excerpt),
            promote: args.promote && typeof args.promote === 'object'
                ? { level: text(args.promote.level), reason: text(args.promote.reason) } : null,
            status: text(result.status) || 'queued',
        }];
    }
    if (call?.name === 'nothing_yet') return [{ kind: 'nothing', id: `nothing_${index}`, reason: text(args.reason) }];
    if (call?.name === 'reply') return [{ kind: 'counsellor_reply', id: `reply_${index}`, text: text(args.text) }];
    if (call?.name === 'prayer') return [{ kind: 'prayer', id: `prayer_${index}`, text: text(args.text), status: text(result.status) || 'queued' }];
    return [];
}

/**
 * Вызовы God: разделы Creation, системы весов, открытия, вопросы и ответы
 * Советника на них — отдельными строками журнала (фаза 5).
 */
export function godRows(call, index) {
    const args = call?.args && typeof call.args === 'object' ? call.args : {};
    const result = call?.result && typeof call.result === 'object' ? call.result : {};
    if (result.ok === false) return [];
    if (call?.name === 'creation_write') {
        const titles = (Array.isArray(args.sections) ? args.sections : []).map(item => text(item?.title)).filter(Boolean);
        return [{
            kind: 'creation', id: `creation_${index}`, titles,
            complete: result.complete === true, missing: Array.isArray(result.missing) ? result.missing.map(text) : [],
        }];
    }
    if (call?.name === 'scale_write') {
        const rules = Array.isArray(args.rules) ? args.rules.map(item => text(item?.name)).filter(Boolean) : [];
        return [{ kind: 'scale', id: `scale_${index}`, system: text(args.system), principle: text(args.principle), payment: text(args.payment), rules, replaced: Boolean(result.replaced) }];
    }
    if (call?.name === 'discovery_write') {
        return [{ kind: 'discovery', id: `discovery_${index}`, system: text(args.system), rule: text(args.rule), text: text(args.text), at: text(result.at) }];
    }
    if (call?.name === 'ask') {
        const questions = (Array.isArray(args.questions) ? args.questions : []).map(item => ({ question: text(item?.question), why: text(item?.why) })).filter(item => item.question);
        return questions.length ? [{ kind: 'god_questions', id: `god_questions_${index}`, questions, kept: Number(result.kept) || 0 }] : [];
    }
    if (call?.name === 'god_answer') {
        return [{ kind: 'god_answer', id: `god_answer_${index}`, question: text(args.id), answer: text(args.answer), closed: Boolean(result.closed) }];
    }
    return [];
}

/** Сводка очередей со статусом — последней строкой цикла Советника. */
export function queueRow(queues) {
    if (!queues || typeof queues !== 'object') return null;
    const petitions = Array.isArray(queues.petitions) ? queues.petitions : [];
    const prayers = Array.isArray(queues.prayers) ? queues.prayers : [];
    return {
        kind: 'queues', id: 'queues',
        petitions: petitions.map(item => ({ character: text(item?.character), status: text(item?.status) || 'queued', day: Boolean(item?.day) })),
        prayers: prayers.map(item => ({ text: text(item?.text), status: text(item?.status) || 'queued' })),
    };
}
