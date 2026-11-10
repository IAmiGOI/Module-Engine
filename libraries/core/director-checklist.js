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
export function withDirectorChecklist(handlers, { allowed = [], everyone = [], importanceOf = () => null } = {}) {
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
            decree: DECREE.includes(text(item?.decree)) ? text(item.decree) : 'none', importance: text(item?.importance).toLowerCase(), why: text(item?.why),
        })).filter(item => item.name);
        const outside = characters.filter(item => !pool.has(key(item.name)));
        if (outside.length) {
            return { ok: false, error: `Not named by the reports: ${outside.map(item => item.name).join(', ')}. The form holds only characters the reports touch: ${[...allowed].join(', ') || 'none'}${newDay ? ', and on a new day everyone with a Decree' : ''}. Leave the others as they are.` };
        }
        const unnamed = characters.filter(item => !item.named_by);
        if (unnamed.length) return { ok: false, error: `Say for each which report names them (named_by): ${unnamed.map(item => item.name).join(', ')}.` };
        const sameStanding = characters.filter(item => item.importance && importanceOf(item.name) === item.importance);
        if (sameStanding.length) return { ok: false, error: `Already at that standing — leave importance empty for: ${sameStanding.map(item => `${item.name} (${item.importance})`).join(', ')}.` };
        form = { newDay, characters };
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
        await: async args => {
            if (!form) return { ok: false, error: FORM_FIRST };
            const open = [];
            for (const entry of form.characters) {
                const got = done.get(key(entry.name)) ?? new Set();
                if (entry.decree !== 'none' && !got.has('decree')) open.push(`${entry.name}: ${entry.decree} decree.md`);
                if (entry.write_bank && !(got.has('material') && got.has('spiritual'))) open.push(`${entry.name}: material.md and spiritual.md`);
                if (entry.importance && !got.has('importance')) open.push(`${entry.name}: standing → ${entry.importance}`);
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
