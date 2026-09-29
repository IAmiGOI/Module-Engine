/**
 * Собственная подстановка макросов Prompt Manager (решение владельца: ST-подстановку не
 * используем, синтаксис совместим с ST). Чистая функция-фабрика: один движок на одну сборку.
 *
 *   createMacroEngine({ values, macros, globals, random, seed })
 *     values  — простые значения: user, char, persona, description, personality, scenario,
 *               group, lastMessage, lastChatMessage, lastUserMessage, lastCharMessage, summary, input, model
 *     macros  — наши макросы { имя: строка | () => строка } (rp-time_year и т. п.), приоритетнее values
 *     globals — Map глобальных переменных (setglobalvar/getglobalvar), изменяется на месте
 *     random  — () => число [0,1); по умолчанию Math.random
 *     seed    — если задан, random/pick/roll детерминированы («заморозка», решение 10.2)
 *   engine.substitute(text) → текст; engine.state → { usedRandom, unresolved: [] }; engine.vars — локальные переменные.
 *
 * Неизвестные и битые макросы (`{{char}`) остаются в тексте как есть и попадают в state.unresolved.
 * Раскрытие — один проход слева направо, внутренние макросы раньше внешних, поэтому setvar/getvar
 * в одном тексте видят друг друга в порядке записи.
 */

function seededRandom(seed) {
    let h = 1779033703 ^ String(seed).length;
    for (const ch of String(seed)) { h = Math.imul(h ^ ch.charCodeAt(0), 3432918353); h = (h << 13) | (h >>> 19); }
    return () => {
        h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
        return ((h ^= h >>> 16) >>> 0) / 4294967296;
    };
}

function splitArgs(body) {
    return body.includes('::') ? body.split('::') : body.split(',');
}

function rollDice(spec, rnd) {
    const match = /^(\d*)d(\d+)([+-]\d+)?$/i.exec(spec.trim());
    if (!match) return null;
    const count = Number(match[1] || 1), sides = Number(match[2]);
    let sum = match[3] ? Number(match[3]) : 0;
    for (let i = 0; i < count; i++) sum += 1 + Math.floor(rnd() * sides);
    return String(sum);
}

export function createMacroEngine({ values = {}, macros = {}, globals = new Map(), random, seed } = {}) {
    const rnd = seed !== undefined && seed !== null ? seededRandom(seed) : (random ?? Math.random);
    const vars = new Map();
    const state = { usedRandom: false, unresolved: [] };
    const now = () => new Date();

    const numeric = value => (Number.isFinite(Number(value)) && String(value).trim() !== '' ? Number(value) : null);
    const addTo = (store, name, delta) => {
        const current = store.get(name);
        const a = numeric(current), b = numeric(delta);
        store.set(name, a !== null && b !== null ? String(a + b) : `${current ?? ''}${delta ?? ''}`);
    };

    function evaluate(raw) {
        const body = raw.trim();
        if (body.startsWith('//')) return '';
        if (body === 'trim') return '\u0000TRIM\u0000';
        if (body === 'newline') return '\n';
        const name = body.split(/::|:/)[0].trim();
        const rest = body.slice(name.length).replace(/^::?/, '');
        const args = splitArgs(rest);
        const lower = name.toLowerCase();
        switch (lower) {
            case 'setvar': vars.set(args[0]?.trim(), args.slice(1).join('::')); return '';
            case 'getvar': return vars.get(args[0]?.trim()) ?? '';
            case 'addvar': addTo(vars, args[0]?.trim(), args.slice(1).join('::')); return '';
            case 'incvar': addTo(vars, args[0]?.trim(), 1); return '';
            case 'decvar': addTo(vars, args[0]?.trim(), -1); return '';
            case 'setglobalvar': globals.set(args[0]?.trim(), args.slice(1).join('::')); return '';
            case 'getglobalvar': return globals.get(args[0]?.trim()) ?? '';
            case 'addglobalvar': addTo(globals, args[0]?.trim(), args.slice(1).join('::')); return '';
            case 'incglobalvar': addTo(globals, args[0]?.trim(), 1); return '';
            case 'decglobalvar': addTo(globals, args[0]?.trim(), -1); return '';
            case 'random': case 'pick': {
                const options = args.filter(option => option !== '');
                if (!options.length) return null;
                state.usedRandom = true;
                return options[Math.floor(rnd() * options.length)].trim();
            }
            case 'roll': { state.usedRandom = true; return rollDice(rest, rnd); }
            case 'time': return now().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            case 'date': return now().toLocaleDateString();
            case 'isotime': return now().toISOString().slice(11, 19);
            case 'isodate': return now().toISOString().slice(0, 10);
            case 'weekday': return now().toLocaleDateString('en-US', { weekday: 'long' });
            default: break;
        }
        const custom = macros[body] ?? macros[name];
        if (custom !== undefined) return typeof custom === 'function' ? String(custom()) : String(custom);
        const key = Object.keys(values).find(k => k.toLowerCase() === lower);
        return key !== undefined && values[key] !== undefined && values[key] !== null ? String(values[key]) : null;
    }

    /** Индекс `}}`, закрывающего `{{`, что стоит в позиции `open`, с учётом вложенности; -1 — не закрыт. */
    function findClose(text, open) {
        let depth = 0;
        for (let i = open; i < text.length - 1; i++) {
            if (text[i] === '{' && text[i + 1] === '{') { depth++; i++; }
            else if (text[i] === '}' && text[i + 1] === '}') { depth--; i++; if (depth === 0) return i - 1; }
        }
        return -1;
    }

    /** Один проход слева направо: внутренние макросы раскрываются раньше внешних, порядок записи сохраняется. */
    function expand(text) {
        let out = '';
        let i = 0;
        while (i < text.length) {
            const open = text.indexOf('{{', i);
            if (open < 0) { out += text.slice(i); break; }
            out += text.slice(i, open);
            const close = findClose(text, open);
            if (close < 0) { out += text.slice(open); break; }
            const body = text.slice(open + 2, close);
            if (body.trim().startsWith('//')) { i = close + 2; continue; }
            const inner = expand(body);
            const value = evaluate(inner);
            if (value === null || value === undefined) { out += `{{${inner}}}`; state.unresolved.push(inner.trim()); } else out += value;
            i = close + 2;
        }
        return out;
    }

    function substitute(text) {
        if (typeof text !== 'string' || (!text.includes('{{') && !/<(USER|BOT|CHAR)>/i.test(text))) return text;
        const out = expand(text
            .replace(/<USER>/gi, () => values.user ?? '<USER>')
            .replace(/<(BOT|CHAR)>/gi, () => values.char ?? '<BOT>'));
        return out.replace(/\n*\u0000TRIM\u0000\n*/g, '');
    }
    return { substitute, state, vars };
}
