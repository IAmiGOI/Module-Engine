/**
 * Форма Директора перед действием (`check_reports`): по каждому персонажу, которого касаются отчёты, — что с ним
 * делать. Движок сверяет с формой каждый шаг: до формы — ничего; в форму — только названные отчётами; файлы и важность —
 * только как записано; `await` — когда обещанное сделано. Так дешёвая модель не пишет банк тому, чьи пустые файлы
 * просто лежали перед ней (Альдебаран на телеграмме об Эмилии), и не уходит на отдых, не тронув Указ из Петиции.
 * Чистая обёртка над обработчиками, без модели и хранилища.
 */

const text = value => String(value ?? '').trim();
const key = name => text(name).toLowerCase();
const DECREE = ['none', 'edit', 'create'];
const FORM_FIRST = 'Fill check_reports first: for each character the reports touch, whether to write their bank, what to do with their Decree and their standing. Every other call waits for it.';

/** «Characters/<Имя>/<часть>.md» → { name, part }. */
export function characterFile(path) {
    const match = /^Characters\/([^/]+)\/([a-z]+)\.md$/i.exec(text(path));
    return match ? { name: match[1], part: match[2].toLowerCase() } : null;
}

/**
 * Кого называют отчёты: персонажи банка, чьё имя встречается в тексте задания и отчётов целым словом — полное имя,
 * псевдоним или первое слово имени («Roswaal» в Петиции — это «Roswaal L. Mathers» в банке).
 * `names` — строки или { name, aliases }.
 */
export function namedInReports(reportsText, names) {
    const body = ` ${text(reportsText).toLowerCase()} `;
    const said = word => {
        const escaped = key(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return escaped.length >= 3 && new RegExp(`(^|[^\\p{L}])${escaped}($|[^\\p{L}])`, 'u').test(body);
    };
    return [...new Set((Array.isArray(names) ? names : []).filter(entry => {
        const name = typeof entry === 'string' ? entry : text(entry?.name);
        const aliases = typeof entry === 'string' ? [] : (Array.isArray(entry?.aliases) ? entry.aliases : []);
        const first = text(name).split(/\s+/)[0];
        return [name, ...aliases, ...(first && first !== text(name) && first.length >= 4 ? [first] : [])].some(said);
    }).map(entry => (typeof entry === 'string' ? entry : text(entry.name))))];
}

/**
 * @param handlers  обработчики Директора (view, edit, create, set_bank_importance, resolve_proposals, await)
 * @param allowed   имена, которых касаются отчёты (namedInReports)
 * @param everyone  имена всех с Указом — для нового дня
 * @param importanceOf  имя → текущая важность (или null, если неизвестна)
 */
/** Строка Указа без метки времени и маркера списка — чтобы скопированную строку узнать в файле. */
const bare = value => text(value).replace(/^[-*]\s*/, '').replace(/^\[[^\]]*\]\s*/, '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').toLowerCase();
const holds = (file, line) => {
    const probe = bare(line).slice(0, 80);
    return Boolean(probe) && text(file).split('\n').some(row => bare(row).includes(probe) || (bare(row).length > 20 && probe.includes(bare(row))));
};

/**
 * @param decreeOf    имя → текст decree.md (или null, если неизвестен) — для проверки скопированной строки
 * @param bankWritten имя → true/false/null — написан ли банк (material и spiritual)
 */
export function withDirectorChecklist(handlers, { allowed = [], everyone = [], importanceOf = () => null, decreeOf = () => null, bankWritten = () => null, known = null, pastMissing = () => false, onForm = null } = {}) {
    let form = null;
    let refusals = 0;
    const done = new Map();
    const mark = (name, what) => { const set = done.get(key(name)) ?? new Set(); set.add(what); done.set(key(name), set); };
    const entryFor = name => form?.characters.find(item => key(item.name) === key(name)) ?? null;

    const check = args => {
        const newDay = args?.new_day === true;
        const pool = new Set([...allowed, ...(newDay ? everyone : [])].map(key));
        const characters = (Array.isArray(args?.characters) ? args.characters : []).map(item => ({
            name: text(item?.name), named_by: text(item?.named_by), write_bank: item?.write_bank === true,
            decree: DECREE.includes(text(item?.decree)) ? text(item.decree) : 'none', importance: text(item?.importance).toLowerCase(),
            line: text(item?.line), evidence: text(item?.evidence || item?.why),
        })).filter(item => item.name);
        const outside = characters.filter(item => !pool.has(key(item.name)));
        if (outside.length) {
            // Без банка в чате — другая причина, чем «отчёты их не называют»: Директор крутил форму, не понимая, почему нельзя.
            const missing = typeof known === 'function' ? outside.filter(item => !known(item.name)) : [];
            const unnamed = outside.filter(item => !missing.includes(item));
            const parts = [];
            if (missing.length) parts.push(`No bank exists for: ${missing.map(item => item.name).join(', ')} — this chat has no card.md or files for them, so there is nothing to write from. Leave them out of the form and say so in your await reason.`);
            if (unnamed.length) parts.push(`Not named by the reports: ${unnamed.map(item => item.name).join(', ')}. The form holds only characters the reports touch: ${[...allowed].join(', ') || 'none'}${newDay ? ', and on a new day everyone with a Decree' : ''}. Leave the others as they are.`);
            return { ok: false, error: parts.join(' ') };
        }
        // Каждый, кого называют отчёты, — в форме, хотя бы с «none» и строкой, которая это покрывает: иначе его просто пропускали.
        const listed = new Set(characters.map(item => key(item.name)));
        const skipped = [...allowed].filter(name => !listed.has(key(name)));
        if (skipped.length) return { ok: false, error: `The reports also name: ${skipped.join(', ')}. Add each to the form — with decree "none" and the line that already covers the report if nothing changes for them.` };
        const unnamed = characters.filter(item => !item.named_by);
        if (unnamed.length) return { ok: false, error: `Say for each which report names them (named_by): ${unnamed.map(item => item.name).join(', ')}.` };
        // Самопроверка: решение держится на строке Указа и факте отчёта, а не на ощущении «надо бы обновить».
        const problems = [];
        for (const item of characters) {
            const decree = decreeOf(item.name);
            const hasDecree = decree !== null && Boolean(text(decree).replace(/^#.*$/gm, '').trim());
            if (item.decree === 'edit' && (!item.line || !item.evidence)) problems.push(`${item.name}: edit needs the line the report breaks (line) and the fact that breaks it (evidence) — if you cannot name them, the Decree holds: decree "none".`);
            else if (item.decree === 'edit' && hasDecree && !holds(decree, item.line)) problems.push(`${item.name}: the line you gave is not in their decree.md — copy it exactly from the file.`);
            if (item.decree === 'none' && item.line && hasDecree && !holds(decree, item.line)) problems.push(`${item.name}: the covering line you gave is not in their decree.md — copy it exactly.`);
            if (item.decree === 'edit' && decree !== null && !hasDecree) problems.push(`${item.name} has no Decree yet — use decree "create".`);
            if (item.decree === 'create' && hasDecree) problems.push(`${item.name} already has a Decree — use "edit" for the lines the report breaks, or "none".`);
            if (item.write_bank && bankWritten(item.name) === true) problems.push(`${item.name}'s bank is already written — write_bank is only for empty material.md and spiritual.md.`);
        }
        if (problems.length) return { ok: false, error: `Check your form against the files: ${problems.join(' ')}` };
        const sameStanding = characters.filter(item => item.importance && importanceOf(item.name) === item.importance);
        if (sameStanding.length) return { ok: false, error: `Already at that standing — leave importance empty for: ${sameStanding.map(item => `${item.name} (${item.importance})`).join(', ')}.` };
        form = { newDay, characters };
        // Форма принята: движок узнаёт, что в этом прогоне пишутся банки, и зовёт Психолога за стол.
        try { onForm?.(form); } catch { /* ошибка соседа не отменяет принятую форму */ }
        const plan = characters.filter(item => item.write_bank || item.decree !== 'none' || item.importance);
        return { ok: true, plan: plan.map(item => `${item.name}: ${[item.write_bank ? 'write material.md and spiritual.md' : '', item.decree !== 'none' ? `${item.decree} decree.md` : '', item.importance ? `standing → ${item.importance}` : ''].filter(Boolean).join('; ')}`), note: plan.length ? 'Do exactly this, then await.' : 'Nothing to change: call await.' };
    };

    const guardFiles = (paths, verb) => {
        if (!form) return FORM_FIRST;
        for (const path of paths) {
            const file = characterFile(path);
            if (!file) continue;
            const entry = entryFor(file.name);
            if (!entry) return `${file.name} is not in your check_reports form — the reports do not touch them. Leave their files as they are.`;
            if (file.part === 'decree' && entry.decree === 'none') return `Your form says ${file.name}'s Decree stays as it is. Fill check_reports again if the reports really change it.`;
            if (['material', 'spiritual'].includes(file.part) && !entry.write_bank && entry.decree === 'none') return `Your form changes nothing for ${file.name}. Fill check_reports again if the reports really change them.`;
            if (verb === 'create' && file.part === 'decree' && entry.decree !== 'create') return `Your form says to edit ${file.name}'s Decree, not create it: use edit.`;
        }
        return '';
    };

    return {
        ...handlers,
        check_reports: async args => check(args),
        edit: async args => {
            const paths = (Array.isArray(args?.edits) ? args.edits : []).map(edit => edit?.path);
            const refusal = guardFiles(paths, 'edit');
            if (refusal) return { ok: false, error: refusal };
            const result = await handlers.edit(args);
            for (const item of Array.isArray(result?.files) ? result.files : []) {
                const file = characterFile(item?.path);
                if (file && item?.ok !== false) mark(file.name, file.part);
            }
            return result;
        },
        create: async args => {
            const refusal = guardFiles([args?.path], 'create');
            if (refusal) return { ok: false, error: refusal };
            const result = await handlers.create(args);
            const file = characterFile(args?.path);
            if (file && result?.ok !== false) mark(file.name, file.part);
            return result;
        },
        set_bank_importance: async args => {
            if (!form) return { ok: false, error: FORM_FIRST };
            const entry = entryFor(args?.character);
            if (!entry || !entry.importance) return { ok: false, error: `Your form changes no standing for ${text(args?.character)}.` };
            if (entry.importance !== text(args?.importance).toLowerCase()) return { ok: false, error: `Your form says ${entry.name} → ${entry.importance}.` };
            const result = await handlers.set_bank_importance(args);
            if (result?.ok !== false) mark(entry.name, 'importance');
            return result;
        },
        resolve_proposals: async args => (form ? handlers.resolve_proposals?.(args) ?? { ok: true } : { ok: false, error: FORM_FIRST }),
        set_acquaintance: async args => {
            const result = await handlers.set_acquaintance?.(args) ?? { ok: false, error: 'Not available.' };
            if (result?.ok !== false) mark(text(result.character) || text(args?.character), 'past');
            return result;
        },
        await: async args => {
            if (!form) return { ok: false, error: FORM_FIRST };
            const open = [];
            for (const entry of form.characters) {
                const got = done.get(key(entry.name)) ?? new Set();
                if (entry.decree !== 'none' && !got.has('decree')) open.push(`${entry.name}: ${entry.decree} decree.md`);
                if (entry.write_bank && !(got.has('material') && got.has('spiritual'))) open.push(`${entry.name}: material.md and spiritual.md`);
                if (entry.importance && !got.has('importance')) open.push(`${entry.name}: standing → ${entry.importance}`);
                // Прошлое с пользователем у Main Cast обязательно — хотя бы «по нулям».
                if (!got.has('past') && pastMissing(entry.name)) open.push(`${entry.name}: their past with the user — set_acquaintance (first_meeting: true if they have never met)`);
            }
            // Дважды отказали — отпускаем: форма держит, а не запирает Директора навсегда.
            if (open.length && refusals < 2) {
                refusals += 1;
                return { ok: false, error: `Not yet — your form promised: ${open.join('; ')}. Do it, or fill check_reports again if it should not be done.` };
            }
            return handlers.await(args);
        },
    };
}
