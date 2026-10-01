import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToolCalls, findJsonEnd } from '../libraries/core/guide-toolcalls.js';
import { splitThinking, streamingText, streamingStage } from '../libraries/core/guide-thinking.js';
import { splitAutoActions } from '../libraries/core/guide-markup.js';

/** Действия, которые нашлись в реплике после разбора: `[{ action, params }]`. */
const actionsOf = reply => splitAutoActions(normalizeToolCalls(reply), () => true).actions;
const textOf = reply => splitAutoActions(normalizeToolCalls(reply), () => true).text;

test('DeepSeek V4 (DSML): invoke and parameters become an action; string="false" keeps JSON values (numbers, booleans, lists), string="true" keeps the raw text', () => {
    const reply = 'Let me read it.<｜DSML｜tool_calls>\n<｜DSML｜invoke name="web.page">\n<｜DSML｜parameter name="id" string="true">p1</｜DSML｜parameter>\n<｜DSML｜parameter name="section" string="false">2</｜DSML｜parameter>\n<｜DSML｜parameter name="chars" string="false">3000</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls><｜end▁of▁sentence｜>';
    assert.deepEqual(actionsOf(reply), [{ action: 'web.page', params: { id: 'p1', section: 2, chars: 3000 } }]);
    assert.equal(textOf(reply), 'Let me read it.');
});

test('DeepSeek V4.1 Flash writes the DSML tags with spaces, and V3.2 wraps them in function_calls: both are read; several calls in one block all come out', () => {
    const spaced = '<｜ DSML ｜tool_calls><｜ DSML ｜invoke name="web.read"><｜ DSML ｜parameter name="ref" string="true">anilist:1</｜ DSML ｜parameter></｜ DSML ｜invoke><｜ DSML ｜invoke name="web.wikis"><｜ DSML ｜parameter name="franchise" string="true">Mushoku Tensei</｜ DSML ｜parameter></｜ DSML ｜invoke></｜ DSML ｜tool_calls>';
    assert.deepEqual(actionsOf(spaced), [{ action: 'web.read', params: { ref: 'anilist:1' } }, { action: 'web.wikis', params: { franchise: 'Mushoku Tensei' } }]);
    const v32 = '<｜DSML｜function_calls><｜DSML｜invoke name="web.search"><｜DSML｜parameter name="query" string="true">Emilia</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜function_calls>';
    assert.deepEqual(actionsOf(v32), [{ action: 'web.search', params: { query: 'Emilia' } }]);
    const ascii = '<|DSML|tool_calls><|DSML|invoke name="web.search"><|DSML|parameter name="query" string="true">X</|DSML|parameter></|DSML|invoke></|DSML|tool_calls>';
    assert.deepEqual(actionsOf(ascii), [{ action: 'web.search', params: { query: 'X' } }]);
});

test('DeepSeek V3.1 and V3 classic calls (tool▁call▁begin, tool▁sep, json fence) are read, and no special token is left in the text', () => {
    const v31 = 'Looking.<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>web.read<｜tool▁sep｜>{"ref": "anilist:2"}<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
    assert.deepEqual(actionsOf(v31), [{ action: 'web.read', params: { ref: 'anilist:2' } }]);
    assert.equal(textOf(v31), 'Looking.');
    const v3 = '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>web.find\n```json\n{"id": "p1", "query": "tails"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
    assert.deepEqual(actionsOf(v3), [{ action: 'web.find', params: { id: 'p1', query: 'tails' } }]);
    assert.ok(!/[｜▁]/.test(normalizeToolCalls(v3).replace(/```action[\s\S]*?```/g, '')), 'no special token is left');
});

test('Qwen: the Hermes JSON form, the Qwen3-Coder XML form (<function=…><parameter=…>), the Qwen-Agent form and the Llama python tag are read', () => {
    const hermes = 'Ok.<tool_call>\n{"name": "web.read", "arguments": {"ref": "anilist:3", "n": 2}}\n</tool_call>';
    assert.deepEqual(actionsOf(hermes), [{ action: 'web.read', params: { ref: 'anilist:3', n: 2 } }]);
    const coder = '<tool_call>\n<function=web.wiki>\n<parameter=host>\nmushoku.fandom.com\n</parameter>\n<parameter=query>\nNanahoshi Shizuka\n</parameter>\n</function>\n</tool_call>';
    assert.deepEqual(actionsOf(coder), [{ action: 'web.wiki', params: { host: 'mushoku.fandom.com', query: 'Nanahoshi Shizuka' } }]);
    const agent = '✿FUNCTION✿: web.search\n✿ARGS✿: {"query": "Emilia"}\n✿RESULT✿:';
    assert.deepEqual(actionsOf(agent), [{ action: 'web.search', params: { query: 'Emilia' } }]);
    const llama = '<|python_tag|>{"name": "web.search", "parameters": {"query": "Emilia"}}<|eom_id|>';
    assert.deepEqual(actionsOf(llama), [{ action: 'web.search', params: { query: 'Emilia' } }]);
    assert.equal(textOf(hermes), 'Ok.');
});

test('GLM forms still work next to the new ones: name + arg_key/arg_value, name: {json}$0$, several in a row', () => {
    const glm = 'Look.<tool_call>web.read\n<arg_key>ref</arg_key>\n<arg_value>anilist:4</arg_value>\n</tool_call><tool_call>web.wikis: {"franchise": "X"}$1$';
    assert.deepEqual(actionsOf(glm), [{ action: 'web.read', params: { ref: 'anilist:4' } }, { action: 'web.wikis', params: { franchise: 'X' } }]);
});

test('a tool that is not one of ours (no dot in the name), an unreadable call and a model end token are cut out without a trace; ordinary text is untouched', () => {
    assert.deepEqual(actionsOf('<tool_call>\n{"name": "get_weather", "arguments": {"city": "X"}}\n</tool_call>'), []);
    assert.equal(textOf('<tool_call>\n{"name": "get_weather", "arguments": {"city": "X"}}\n</tool_call>Fine.'), 'Fine.');
    assert.equal(textOf('Hi.<｜DSML｜tool_calls><｜DSML｜invoke name="broken'), 'Hi.');
    assert.equal(normalizeToolCalls('Done.<|im_end|>'), 'Done.');
    assert.equal(normalizeToolCalls('Done.<｜end▁of▁sentence｜>'), 'Done.');
    const plain = 'Use [Label](stme:card:models) and `code` with a < b | c > d.';
    assert.equal(normalizeToolCalls(plain), plain);
});

test('through the whole pipeline: the visible text has no markup, and while the call is still being written the window shows nothing of it and says an action is being prepared', () => {
    const dsml = 'Let me read it.<｜DSML｜tool_calls><｜DSML｜invoke name="web.read"><｜DSML｜parameter name="ref" string="true">a:1</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>';
    const split = splitThinking(dsml);
    assert.ok(!/DSML/.test(split.visible.replace(/```action[\s\S]*?```/g, '')));
    for (const writing of ['Let me read it.<｜DSML｜tool_ca', 'Let me read it.<｜ DSML ｜tool_calls><｜ DSML ｜inv', 'Let me read it.<tool_call>\n{"name": "web.re', 'Let me read it.✿FUNCTION✿: web.re']) {
        assert.equal(streamingText(writing), 'Let me read it.', writing);
    }
    assert.deepEqual(streamingStage('Let me read it.<｜DSML｜tool_calls><｜DSML｜invoke name="web.re'), { label: 'Preparing an action' });
});

test('the JSON end finder respects strings and nesting', () => {
    const text = '{"a": {"b": "}"}, "c": [1, 2]} tail';
    assert.equal(text.slice(0, findJsonEnd(text, 0)), '{"a": {"b": "}"}, "c": [1, 2]}');
    assert.equal(findJsonEnd('{"a": 1', 0), -1);
});

test('a bare JSON call that the model printed without the ```action fence (as in a real chat) is run as an action instead of littering the chat; JSON inside a fence, or without a dotted action, is left alone', () => {
    const pasted = 'Let me read the main wiki page and the appearance page together\n{"label": "Read Nanahoshi wiki page", "action": "web.read", "params": {"url": "https://mushokutensei.fandom.com/wiki/Nanahoshi_Shizuka"}}\n\n{"label": "Read Nanahoshi appearance page", "action": "web.read", "params": {"url": "https://mushokutensei.fandom.com/wiki/Nanahoshi_Shizuka/Appearance"}}';
    assert.deepEqual(actionsOf(pasted), [
        { action: 'web.read', params: { url: 'https://mushokutensei.fandom.com/wiki/Nanahoshi_Shizuka' } },
        { action: 'web.read', params: { url: 'https://mushokutensei.fandom.com/wiki/Nanahoshi_Shizuka/Appearance' } },
    ]);
    assert.equal(textOf(pasted), 'Let me read the main wiki page and the appearance page together');
    const fenced = 'Here.\n```json\n{"label": "x", "action": "web.read", "params": {"url": "https://x.org"}}\n```';
    assert.equal(normalizeToolCalls(fenced), fenced, 'an example inside a fence is not a call');
    const other = 'The config is {"action": "start", "params": {"a": 1}} and {"name": "x"}.';
    assert.equal(normalizeToolCalls(other), other, 'no dotted action name — not ours');
    assert.match(normalizeToolCalls('Ok. {"action": "character.update", "params": {"avatar": "E.png", "description": "d"}}'), /```proposal\n\{"action":"character\.update","params":\{"avatar":"E\.png","description":"d"\}\}\n```/);
    assert.equal(streamingText('Let me read it.\n{"label": "Read", "action": "web.re'), 'Let me read it.', 'the half-written JSON is not shown');
});

test('a call whose fence was lost or never closed (the word "action" left in the text, or ```action with no closing ```) still runs, and the same sentence printed twice in a row is shown once', () => {
    const lost = 'Let me grab the last bit of trivia.Let me grab the last bit of trivia.action\n{"label": "Read remaining trivia", "action": "web.page", "params": {"id": "p2", "offset": 8398, "chars": 700}}';
    assert.deepEqual(actionsOf(lost), [{ action: 'web.page', params: { id: 'p2', offset: 8398, chars: 700 } }]);
    assert.equal(textOf(lost), 'Let me grab the last bit of trivia.');
    const unclosed = 'Reading it now.\n```action\n{"label": "Read", "action": "web.read", "params": {"url": "https://x.org/a"}}';
    assert.deepEqual(actionsOf(unclosed), [{ action: 'web.read', params: { url: 'https://x.org/a' } }]);
    assert.equal(textOf(unclosed), 'Reading it now.');
    const twice = 'Let me read the remaining sections of the page.Let me read the remaining sections of the page.';
    assert.equal(textOf(twice), 'Let me read the remaining sections of the page.');
    assert.equal(textOf('First line is here. Second line is here.'), 'First line is here. Second line is here.', 'different sentences are untouched');
});

test('a block that holds only the avatar parameters (no "action" key, no closing fence) is read as character.avatar and applied, instead of being printed in the chat', () => {
    const reply = 'Setting the picture.\n```proposal\n{"avatar": "Nanahoshi Shizuka.png", "url": "https://s4.anilist.co/file/anilistcdn/character/large/b137816-x.png", "focus": "center"}';
    const split = splitAutoActions(normalizeToolCalls(reply), () => false, id => id === 'character.avatar');
    assert.deepEqual(split.actions, [{ action: 'character.avatar', params: { avatar: 'Nanahoshi Shizuka.png', url: 'https://s4.anilist.co/file/anilistcdn/character/large/b137816-x.png', focus: 'center' } }]);
    assert.equal(split.text, 'Setting the picture.');
});
