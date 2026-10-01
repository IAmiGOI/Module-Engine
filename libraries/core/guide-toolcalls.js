/**
 * Вызовы инструментов «на языке модели». Мы читаем только блоки ```action```, но многие модели вызывают инструменты своим форматом, и без разбора вся эта разметка
 * вылезает в чат, а действие не выполняется. Здесь чистые функции: родные форматы переписываются в обычные блоки ```action``` (дальше всё как у остальных действий), а
 * остатки разметки вырезаются. Поддержано:
 *  — GLM: `<tool_call>имя<arg_key>…</arg_key><arg_value>…</arg_value></tool_call>` и вид `<tool_call>имя: {json}`;
 *  — Qwen/Hermes: `<tool_call>{"name": …, "arguments": {…}}</tool_call>`; Qwen3-Coder: `<tool_call><function=имя><parameter=ключ>значение</parameter></function></tool_call>`;
 *    Qwen-Agent: `✿FUNCTION✿: имя ✿ARGS✿: {json}`; Llama: `<|python_tag|>{"name": …, "parameters": {…}}`;
 *  — DeepSeek V4/V3.2 (DSML): `<｜DSML｜tool_calls><｜DSML｜invoke name="…"><｜DSML｜parameter name="…" string="true|false">…` (в V3.2 обёртка `function_calls`,
 *    в V4.1 Flash теги пишутся с пробелами вокруг `｜`); DeepSeek V3/V3.1: `<｜tool▁call▁begin｜>имя<｜tool▁sep｜>{json}<｜tool▁call▁end｜>`.
 * Действия у нас всегда с точкой в имени (`web.read`): вызов без точки — не наше действие и просто вырезается.
 */

/** Конец JSON-объекта, начинающегося в `from` (учитывает строки и вложенность); `-1` — не закрыт. */
export function findJsonEnd(text, from) {
    let depth = 0;
    let inString = false;
    for (let index = from; index < text.length; index += 1) {
        const char = text[index];
        if (inString) { if (char === '\\') index += 1; else if (char === '"') inString = false; continue; }
        if (char === '"') inString = true;
        else if (char === '{') depth += 1;
        else if (char === '}') { depth -= 1; if (!depth) return index + 1; }
    }
    return -1;
}

const tryParse = text => { try { return JSON.parse(text); } catch { return undefined; } };
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Блок действия для движка; `null`, если это не наше действие (нет точки в имени). */
function buildActionBlock(name, params) {
    if (!/^[\w]+\.[\w.]+$/.test(String(name ?? '')) || !isPlainObject(params)) return null;
    return `\n\`\`\`action\n${JSON.stringify({ label: name, action: name, params })}\n\`\`\`\n`;
}

/** Значение параметра из разметки: JSON, если это число/булево/объект/массив/null, иначе строка. */
function readLooseValue(raw) {
    const trimmed = String(raw ?? '').trim();
    const parsed = tryParse(trimmed);
    return parsed !== undefined && (typeof parsed !== 'string') ? parsed : trimmed;
}

/** Тег DSML в любом написании (`<｜DSML｜x>`, `<｜ DSML ｜x>`, `<|DSML|x>`) приводится к одному виду `<dsml:x>`; закрывающий — `</dsml:x>`. */
function canonicalizeDsml(text) {
    return text.replace(/<\s*(\/?)\s*[｜|]\s*DSML\s*[｜|]\s*(\w+)/g, '<$1dsml:$2');
}

function convertDsml(text) {
    const source = canonicalizeDsml(text);
    if (!source.includes('<dsml:') && !source.includes('</dsml:')) return text;
    let out = source.replace(/<dsml:invoke\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/dsml:invoke\s*>/g, (_whole, name, body) => {
        const params = {};
        for (const [, key, kind, value] of body.matchAll(/<dsml:parameter\s+name\s*=\s*"([^"]+)"(?:\s+string\s*=\s*"(true|false)")?\s*>([\s\S]*?)<\/dsml:parameter\s*>/g)) {
            params[key] = kind === 'false' ? readLooseValue(value) : (kind === 'true' ? value.replace(/^\n|\n$/g, '') : readLooseValue(value));
        }
        return buildActionBlock(name, params) ?? '';
    });
    out = out.replace(/<\/?dsml:\w*[^>]*(?:>|$)/g, ''); // обёртки tool_calls / function_calls и оборванный тег до конца текста
    return out;
}

function convertDeepSeekClassic(text) {
    if (!/tool[▁_ ]call[▁_ ]begin/i.test(text)) return text;
    const begin = /<[｜|]\s*tool[▁_ ]call[▁_ ]begin\s*[｜|]>/gi;
    let out = text;
    for (;;) {
        begin.lastIndex = 0;
        const open = begin.exec(out);
        if (!open) break;
        const after = open.index + open[0].length;
        // V3: `function<｜tool▁sep｜>имя\n```json\n{…}\n```` ; V3.1: `имя<｜tool▁sep｜>{…}`
        const head = /^\s*(?:function\s*<[｜|]\s*tool[▁_ ]sep\s*[｜|]>\s*)?([\w.]+)\s*(?:<[｜|]\s*tool[▁_ ]sep\s*[｜|]>)?\s*(?:```(?:json)?\s*)?/i.exec(out.slice(after));
        const braceAt = head ? after + head[0].length : -1;
        const end = head && out[braceAt] === '{' ? findJsonEnd(out, braceAt) : -1;
        const params = end > 0 ? tryParse(out.slice(braceAt, end)) : undefined;
        const block = params ? buildActionBlock(head[1], params) : null;
        const tail = end > 0 ? /^\s*(?:```)?\s*(?:<[｜|]\s*tool[▁_ ]call[▁_ ]end\s*[｜|]>)?/i.exec(out.slice(end))[0].length : 0;
        const stop = end > 0 ? end + tail : after;
        out = out.slice(0, open.index) + (block ?? '') + out.slice(stop);
        if (!block && end <= 0) break;
    }
    return out;
}

function convertTagToolCalls(text) {
    const open = /<(?:tool_call|function_call)>/gi;
    let out = text;
    let from = 0;
    for (;;) {
        open.lastIndex = from;
        const match = open.exec(out);
        if (!match) break;
        const after = match.index + match[0].length;
        const rest = out.slice(after);
        let block = null;
        let consumed = 0;
        let handledAsForeign = false;
        // Qwen/Hermes: сразу JSON `{"name": …, "arguments": {…}}`
        const lead = /^\s*/.exec(rest)[0].length;
        if (rest[lead] === '{') {
            const end = findJsonEnd(rest, lead);
            const call = end > 0 ? tryParse(rest.slice(lead, end)) : undefined;
            if (isPlainObject(call)) {
                const args = call.arguments ?? call.parameters ?? call.args ?? {};
                block = buildActionBlock(call.name, typeof args === 'string' ? tryParse(args) : args);
                consumed = end;
                if (!block) handledAsForeign = true; // чужой инструмент (не наше действие): вызов вырезается целиком, а не по строке
            }
        }
        // Qwen3-Coder: `<function=имя><parameter=ключ>значение</parameter></function>`
        const coder = block === null ? /^\s*<function=([\w.]+)>([\s\S]*?)<\/function>/.exec(rest) : null;
        if (coder) {
            const params = {};
            for (const [, key, value] of coder[2].matchAll(/<parameter=([\w.-]+)>([\s\S]*?)<\/parameter>/g)) params[key] = readLooseValue(value);
            block = buildActionBlock(coder[1], params);
            consumed = coder[0].length;
        }
        // GLM: `имя` затем `{json}` или пары `<arg_key>…</arg_key><arg_value>…</arg_value>`
        const named = block === null && !coder ? /^\s*([\w.]+)\s*[:\n ]\s*/.exec(rest) : null;
        if (named) {
            const braceAt = named[0].length;
            const end = rest[braceAt] === '{' ? findJsonEnd(rest, braceAt) : -1;
            let params = end > 0 ? tryParse(rest.slice(braceAt, end)) : undefined;
            consumed = end;
            if (params === undefined) {
                const pairs = /^(?:\s*<arg_key>([^<]+)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>)+/.exec(rest.slice(braceAt));
                if (pairs) {
                    params = {};
                    for (const [, key, value] of pairs[0].matchAll(/<arg_key>([^<]+)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g)) params[key.trim()] = readLooseValue(value);
                    consumed = braceAt + pairs[0].length;
                }
            }
            if (params !== undefined) block = buildActionBlock(named[1], params);
        }
        if (block || handledAsForeign) {
            const tail = /^(?:\s*(?:<\/(?:arg_key|arg_value|tool_call|function_call|function|parameter)>|\$\d+\$))*/.exec(out.slice(after + consumed))[0].length;
            out = out.slice(0, match.index) + (block ?? '') + out.slice(after + consumed + tail);
            from = match.index + (block ?? '').length;
        } else {
            const lineEnd = out.indexOf('\n', after);
            out = out.slice(0, match.index) + (lineEnd < 0 ? '' : out.slice(lineEnd));
            from = match.index;
        }
    }
    return out;
}

function convertQwenAgent(text) {
    return text.replace(/✿FUNCTION✿:\s*([\w.]+)\s*✿ARGS✿:\s*(\{[\s\S]*?\})(?=\s*(?:✿|$))/g, (_whole, name, raw) => buildActionBlock(name, tryParse(raw)) ?? '').replace(/✿\w+✿:?/g, '');
}

function convertPythonTag(text) {
    return text.replace(/<\|python_tag\|>\s*(\{[\s\S]*?\})(?=\s*(?:<\||$))/g, (_whole, raw) => {
        const call = tryParse(raw);
        return isPlainObject(call) ? buildActionBlock(call.name, call.parameters ?? call.arguments ?? {}) ?? '' : '';
    });
}

/** Остатки служебной разметки: закрывающие теги вызовов, метки `$0$`, специальные токены вида `<｜end▁of▁sentence｜>` и `<|im_end|>`. */
const LEFTOVERS = /<\/?(?:tool_call|function_call|arg_key|arg_value|tool_response|function|parameter(?:=[\w.-]+)?)>|<function=[\w.]+>|\$\d+\$|<[｜|][^<>]{1,40}[｜|]>/gi;

/**
 * Реплика модели → реплика, где вызовы инструментов на языке модели переписаны в блоки ```action```, а служебная разметка вырезана. Текст без такой разметки не меняется.
 */
export function normalizeToolCalls(reply) {
    let text = String(reply ?? '');
    text = convertDsml(text);
    text = convertDeepSeekClassic(text);
    text = convertTagToolCalls(text);
    text = convertQwenAgent(text);
    text = convertPythonTag(text);
    return text.replace(LEFTOVERS, '');
}

/** Есть ли в тексте начало чужого вызова (в том числе ещё недописанное): для стриминга — это не текст для человека. */
export const STARTS_FOREIGN_CALL = /<(?:tool_call|function_call)>|<\s*[｜|]\s*(?:DSML|tool[▁_ ]calls?[▁_ ]begin)|<\|python_tag\|>|✿FUNCTION✿/i;
