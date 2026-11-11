import { PSYCHOLOGIST_DESK_PROPOSAL, PSYCHOLOGIST_DESK_SYSTEM, PSYCHOLOGIST_SYSTEM, PSYCHOLOGIST_TASK, fillPrompt } from '../../libraries/core/decision-prompts.js';
import { psychologistWorkerId } from '../../libraries/core/decision-settings.js';
import { findCharacter, needsPsyche } from '../../libraries/core/decision-great-bank.js';
import { psycheLines } from '../../libraries/core/decision-psyche.js';
import { parsePart, renderPart } from '../../libraries/core/court-bank-files.js';
import { promptText } from '../../libraries/core/prompt-overrides.js';

/**
 * Психолог за одним столом с Директором. Директор ведёт цикл агента и пишет
 * файлы; перед каждой записью material.md, spiritual.md или decree.md
 * Психолог получает общую историю сессии и предлагаемый текст и отвечает
 * «ok» или одним конкретным возражением. Возражение возвращается Директору
 * как результат инструмента, и запись не применяется.
 *
 * Одна история на сессию: реплики Директора — сообщения role "user" с
 * пометкой «DIRECTOR:», реплики Психолога — его собственные сообщения
 * ассистента. Для Директора возражение приходит ещё и репликой
 * «PSYCHOLOGIST:» (см. `decision-agent.js`).
 *
 * В конце сессии Психолог пишет psyche.md тем же разговором — для персонажей,
 * чьи банки писались в этой сессии, вместо отдельного вызова.
 */

const CHECK_MAX_TOKENS = 700;
const PSYCHE_MAX_TOKENS = 1600;
const CHECKED_PARTS = new Set(['material', 'spiritual', 'decree']);
const text = value => String(value ?? '').trim();
const key = value => text(value).toLowerCase();
const cleanLine = value => text(value).replace(/\s+/g, ' ');
const lineKey = (name, part, line) => `${key(name)}|${part}|${cleanLine(line)}`;

/** Строки части файла: только сами утверждения, без заголовков разделов. */
function linesOf(body, part) {
    return Object.values(parsePart(body, part)).flat().map(text).filter(Boolean);
}

/** Строки, которых не было в файле: именно их предлагает Директор. */
function addedLines(before, after, part) {
    const was = new Set(linesOf(before, part).map(cleanLine));
    return linesOf(after, part).filter(line => !was.has(cleanLine(line)));
}

export function createPsyDesk({
    call, getSettings = () => ({}), getWorkers = () => [], publishEvent = () => {},
    great = null, world = () => '',
}) {
    let active = false;
    const targets = new Map(); // нижний регистр → имя, как его зовёт Директор
    const users = new Set();
    const seen = new Set(); // строки, которые Психолог уже видел: по строке — один круг
    const log = []; // { by: 'director' | 'psychologist', text }

    function settings() {
        try { return getSettings?.() ?? {}; } catch { return {}; }
    }

    function workerInfo() {
        const id = text(psychologistWorkerId(settings()));
        if (!id) return null;
        const list = typeof getWorkers === 'function' ? getWorkers() : [];
        const found = (Array.isArray(list) ? list : []).find(item => item?.id === id) ?? null;
        return { id, format: text(found?.format) };
    }

    function historyMessages() {
        return log.map(entry => entry.by === 'director'
            ? { role: 'user', content: `DIRECTOR: ${entry.text}` }
            : { role: 'assistant', content: entry.text });
    }

    function transcript() {
        return log.map(entry => `${entry.by === 'director' ? 'DIRECTOR' : 'PSYCHOLOGIST'}: ${entry.text}`).join('\n\n');
    }

    /**
     * Запрос модели: openai-воркер получает настоящие messages (история
     * сессии с ролями), остальные — тот же разговор текстом, как psyche.md.
     */
    function request({ system, task = '', maxTokens = CHECK_MAX_TOKENS } = {}) {
        const worker = workerInfo();
        if (!worker) return null;
        const base = {
            purpose: system === PSYCHOLOGIST_DESK_SYSTEM ? 'psy-desk' : 'psychologist',
            workerId: worker.id, maxTokens, temperature: 0, stream: false,
            reasoningMode: 'disabled', reasoningEffort: 'low', reasoningBudget: 0,
        };
        if (worker.format === 'openai') {
            return {
                ...base,
                systemPrompt: promptText(system),
                messages: [
                    { role: 'system', content: promptText(system) },
                    ...historyMessages(),
                    ...(task ? [{ role: 'user', content: task }] : []),
                ],
            };
        }
        return {
            ...base,
            systemPrompt: promptText(system),
            prompt: [transcript(), task].filter(Boolean).join('\n\n'),
        };
    }

    /** Сессия включается формой Директора, где есть write_bank. Пользователя — никогда. */
    function activate({ names = [], users: userNames = [] } = {}) {
        for (const name of userNames) users.add(key(name));
        let added = false;
        for (const name of names) {
            const clean = text(name);
            if (!clean || users.has(key(clean))) continue;
            targets.set(key(clean), clean);
            added = true;
        }
        if (added) active = true;
        return active;
    }

    /**
     * Проверка перед записью файла. Возвращает `{ ok: true }` или отказ с
     * текстом возражения и пометкой, что говорит Психолог.
     */
    async function check({ path = '', part = '', name = '', before = '', after = '', comment = '' } = {}) {
        if (!active) return { ok: true };
        if (!CHECKED_PARTS.has(part)) return { ok: true };
        if (!text(name) || users.has(key(name))) return { ok: true };
        const added = addedLines(before, after, part);
        if (!added.length) return { ok: true };
        // Возражать можно сколько угодно: каждая новая версия файла идёт к Психологу. Предел — шаги Директора.
        // Довод Директора (comment вызова) Психолог видит рядом с файлом.
        log.push({ by: 'director', text: [fillPrompt(PSYCHOLOGIST_DESK_PROPOSAL, { path: text(path), text: text(after) }), text(comment) ? `The Director says: ${text(comment)}` : ''].filter(Boolean).join('\n\n') });
        const requestParams = request({ system: PSYCHOLOGIST_DESK_SYSTEM });
        if (!requestParams) {
            for (const line of added) seen.add(lineKey(name, part, line));
            publishEvent('decision.psyche.skipped', { character: name, path: text(path), reason: 'no connection is configured' });
            return { ok: true };
        }
        publishEvent('decision.psyche.checking', { character: name, path: text(path) });
        let answer = '';
        try {
            answer = text(await call('model.generate', requestParams));
        } catch (error) {
            // Модель недоступна — не держим Директора: строки принимаются как есть.
            for (const line of added) seen.add(lineKey(name, part, line));
            publishEvent('decision.psyche.failed', { character: name, path: text(path), message: error?.message ?? String(error) });
            return { ok: true };
        }
        log.push({ by: 'psychologist', text: answer || 'ok' });
        for (const line of added) seen.add(lineKey(name, part, line));
        const ok = !answer || /^ok[.!]?$/i.test(answer);
        publishEvent('decision.psyche.checked', { character: name, path: text(path), ok });
        if (ok) return { ok: true };
        return { ok: false, error: `${text(path)}: ${answer}`, speaker: 'PSYCHOLOGIST', character: name, path: text(path) };
    }

    /** Кого сессия держит до конца прогона: их psyche.md пишет она, а не отдельный вызов. */
    function targetNames() {
        return [...targets.values()];
    }

    /**
     * Конец сессии: psyche.md для персонажей, чьи банки писались здесь, — с
     * историей сессии в контексте. Отдельный вызов психолога для них заменён.
     */
    async function finish({ state = null } = {}) {
        if (!active) return { skipped: true, written: [] };
        const written = [];
        const warnings = [];
        let current = state;
        if (!current && great?.load) current = await great.load().catch(() => ({}));
        let worldText = 'unknown';
        try {
            worldText = text(typeof world === 'function' ? await world() : world) || 'unknown';
        } catch { /* без строки мира psyche.md всё равно пишется */ }

        for (const [lower, name] of targets) {
            if (users.has(lower)) continue;
            const character = findCharacter(current, name);
            if (!character || !needsPsyche(character)) continue;
            const task = fillPrompt(PSYCHOLOGIST_TASK, {
                name: character.name,
                material: renderPart(character, 'material'),
                spiritual: renderPart(character, 'spiritual'),
                decree: renderPart(character, 'decree'),
                world: worldText,
            });
            const requestParams = request({ system: PSYCHOLOGIST_SYSTEM, task, maxTokens: PSYCHE_MAX_TOKENS });
            if (!requestParams) {
                warnings.push(`${character.name}: the Psychologist has no connection — psyche.md was not written`);
                continue;
            }
            publishEvent('decision.psyche.started', { character: character.name });
            let answer;
            try {
                answer = await call('model.generate', requestParams);
            } catch (error) {
                warnings.push(`${character.name}: the Psychologist could not write psyche.md — ${error?.message ?? String(error)}`);
                publishEvent('decision.psyche.failed', { character: character.name, message: error?.message ?? String(error) });
                continue;
            }
            const lines = psycheLines(answer);
            if (!lines.length) {
                warnings.push(`${character.name}: the Psychologist returned no lines for psyche.md`);
                publishEvent('decision.psyche.failed', { character: character.name, message: 'the model returned no lines' });
                continue;
            }
            const saved = await great?.setPsyche?.({
                character: character.name, lines,
                comment: 'The Psychologist wrote how their mind moves.',
            }).catch(error => ({ ok: false, error: error?.message ?? String(error) }));
            if (saved?.ok === false) {
                warnings.push(`${character.name}: psyche.md was not saved — ${saved.error}`);
                publishEvent('decision.psyche.failed', { character: character.name, message: saved.error });
                continue;
            }
            written.push(character.name);
            publishEvent('decision.psyche.ready', { character: character.name, lines: lines.length });
        }
        return { ok: true, written, warnings };
    }

    return {
        activate, check, finish,
        targets: targetNames,
    };
}
