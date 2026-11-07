/**
 * Маленький разбор Markdown для предпросмотра во вкладке «Files» (часть 21):
 * заголовки, абзацы, списки, цитаты, код, черта; внутри строки — **жирный**,
 * *курсив*, `код`. Только данные — окно рисует их узлами, без innerHTML.
 */

export function inlineTokens(line) {
    const out = [];
    const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\{\{\s*[a-z0-9_]+\s*\}\})/gi;
    let last = 0;
    for (const match of String(line ?? '').matchAll(re)) {
        if (match.index > last) out.push({ t: 'text', v: line.slice(last, match.index) });
        const token = match[0];
        if (token.startsWith('**')) out.push({ t: 'b', v: token.slice(2, -2) });
        else if (token.startsWith('`')) out.push({ t: 'code', v: token.slice(1, -1) });
        else if (token.startsWith('{{')) out.push({ t: 'var', v: token });
        else out.push({ t: 'i', v: token.slice(1, -1) });
        last = match.index + token.length;
    }
    if (last < String(line ?? '').length) out.push({ t: 'text', v: line.slice(last) });
    return out;
}

export function markdownBlocks(source) {
    const blocks = [];
    const lines = String(source ?? '').replace(/\r\n/g, '\n').split('\n');
    let paragraph = [];
    const flush = () => { if (paragraph.length) blocks.push({ type: 'p', inline: inlineTokens(paragraph.join(' ')) }); paragraph = []; };
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (/^```/.test(line)) {
            flush();
            const body = [];
            for (index += 1; index < lines.length && !/^```/.test(lines[index]); index += 1) body.push(lines[index]);
            blocks.push({ type: 'code', text: body.join('\n') });
            continue;
        }
        const head = /^(#{1,6})\s+(.*)$/.exec(line);
        const item = /^\s*(?:([-*])|(\d+)[.)])\s+(.*)$/.exec(line);
        if (head) { flush(); blocks.push({ type: 'h', level: head[1].length, inline: inlineTokens(head[2]) }); }
        else if (/^\s*(---|\*\*\*)\s*$/.test(line)) { flush(); blocks.push({ type: 'hr' }); }
        else if (item) { flush(); blocks.push({ type: 'li', ordered: Boolean(item[2]), mark: item[2] ?? '•', indent: line.match(/^\s*/)[0].length, inline: inlineTokens(item[3]) }); }
        else if (/^>\s?/.test(line)) { flush(); blocks.push({ type: 'quote', inline: inlineTokens(line.replace(/^>\s?/, '')) }); }
        else if (!line.trim()) flush();
        else paragraph.push(line.trim());
    }
    flush();
    return blocks;
}
