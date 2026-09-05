/**
 * A tiny, hand-rolled language for macro programs — NOT JavaScript, no `eval`/
 * `Function` anywhere. Ported near-verbatim from Alpha's modules/macros/language.js
 * (already a pure, host-independent file there — no ST/DOM/network calls, so the
 * whole thing carries over as a Библиотека unchanged in shape). Safety comes from
 * what the grammar can express at all: `window`/`document`/`fetch`/other modules
 * are not blocked, they're simply inexpressible — there is no call syntax except
 * the two built-ins below.
 *
 *   set X to 5
 *   set shield to get "vitalsTracker:shield"
 *   if X > 5 then
 *       set status to "OK"
 *   else
 *       set status to "Critical"
 *   end
 *   save X as "last_x"
 *   return status
 *
 * `get`/`save` are injected callbacks (see `run()`), and — unlike Alpha, where
 * they hit an in-memory bus synchronously — cores/macros/index.js resolves
 * every `get` this program could possibly need BEFORE calling `run()`
 * (via `collectGetKeys()` below) and collects every `save()` call to flush
 * AFTER `run()` returns, so this interpreter itself stays fully synchronous
 * and needs zero changes for that async backing store.
 */

export const DEFAULT_TIME_LIMIT_MS = 50;
// A loop-iteration backstop, independent of the time-limit clock check — guards the
// pathological case where Date.now() itself somehow doesn't advance between checks
// (a frozen/mocked clock in a hosting environment, e.g.). In ordinary use the time
// limit fires first, comfortably before this is ever reached.
const MAX_LOOP_ITERATIONS = 100000;

export class MacroSyntaxError extends Error {
    constructor(message, line) { super(message); this.name = 'MacroSyntaxError'; this.line = line; }
}
export class MacroRuntimeError extends Error {
    constructor(message, line) { super(message); this.name = 'MacroRuntimeError'; this.line = line; }
}
export class MacroTimeoutError extends Error {
    constructor(message) { super(message); this.name = 'MacroTimeoutError'; }
}

const KEYWORDS = new Set([
    'set', 'to', 'if', 'then', 'else', 'end', 'repeat', 'times', 'while',
    'save', 'as', 'return', 'get', 'and', 'or', 'not', 'is', 'mod', 'true', 'false',
]);

/** Turns source text into a flat token stream. Only throws MacroSyntaxError. */
export function tokenize(source) {
    const text = String(source ?? '');
    const tokens = [];
    let i = 0;
    let line = 1;
    const push = (type, value) => tokens.push({ type, value, line });

    while (i < text.length) {
        const ch = text[i];
        if (ch === '\n') { push('NEWLINE', '\n'); line++; i++; continue; }
        if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
        if (ch === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
        if (ch === '"') {
            let j = i + 1;
            let value = '';
            while (j < text.length && text[j] !== '"') {
                if (text[j] === '\\' && j + 1 < text.length) { value += text[j + 1]; j += 2; }
                else { value += text[j]; j++; }
            }
            if (text[j] !== '"') throw new MacroSyntaxError(`Unterminated string starting on line ${line}.`, line);
            push('STRING', value);
            i = j + 1;
            continue;
        }
        if (/[0-9]/.test(ch)) {
            let j = i;
            while (j < text.length && /[0-9]/.test(text[j])) j++;
            if (text[j] === '.' && /[0-9]/.test(text[j + 1] ?? '')) { j++; while (j < text.length && /[0-9]/.test(text[j])) j++; }
            push('NUMBER', Number(text.slice(i, j)));
            i = j;
            continue;
        }
        if (/[a-zA-Z_]/.test(ch)) {
            let j = i;
            while (j < text.length && /[a-zA-Z0-9_]/.test(text[j])) j++;
            const word = text.slice(i, j);
            const lower = word.toLowerCase();
            push(KEYWORDS.has(lower) ? 'KEYWORD' : 'IDENT', KEYWORDS.has(lower) ? lower : word);
            i = j;
            continue;
        }
        if (ch === '>' && text[i + 1] === '=') { push('SYMBOL', '>='); i += 2; continue; }
        if (ch === '<' && text[i + 1] === '=') { push('SYMBOL', '<='); i += 2; continue; }
        if ('+-*/()><'.includes(ch)) { push('SYMBOL', ch); i++; continue; }
        throw new MacroSyntaxError(`Unexpected character "${ch}" on line ${line}.`, line);
    }
    push('EOF', null);
    return tokens;
}

class TokenCursor {
    constructor(tokens) { this.tokens = tokens; this.pos = 0; }
    peek(offset = 0) { return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]; }
    at(type, value) { const t = this.peek(); return t.type === type && (value === undefined || t.value === value); }
    atKeyword(word) { return this.at('KEYWORD', word); }
    advance() { return this.tokens[this.pos++]; }
    expect(type, value, message) {
        if (!this.at(type, value)) throw new MacroSyntaxError(message ?? `Expected "${value ?? type}" on line ${this.peek().line}, found "${this.peek().value ?? this.peek().type}".`, this.peek().line);
        return this.advance();
    }
    skipNewlines() { while (this.at('NEWLINE')) this.advance(); }
}

/** Turns a token stream into an AST (`{ type: 'Program', statements }`). Only throws MacroSyntaxError. */
export function parse(tokens) {
    const c = new TokenCursor(tokens);

    function parseBlock(terminatorWords) {
        c.skipNewlines();
        const statements = [];
        while (!terminatorWords.some(word => c.atKeyword(word)) && !c.at('EOF')) {
            statements.push(parseStatement());
            c.skipNewlines();
        }
        return statements;
    }

    function parseStatement() {
        if (c.atKeyword('set')) return parseSet();
        if (c.atKeyword('if')) return parseIf();
        if (c.atKeyword('repeat')) return parseRepeat();
        if (c.atKeyword('while')) return parseWhile();
        if (c.atKeyword('save')) return parseSave();
        if (c.atKeyword('return')) return parseReturn();
        throw new MacroSyntaxError(`Expected a statement (set/if/repeat/while/save/return) on line ${c.peek().line}, found "${c.peek().value ?? c.peek().type}".`, c.peek().line);
    }

    function parseSet() {
        const line = c.advance().line; // 'set'
        const name = c.expect('IDENT', undefined, `Expected a variable name after "set" on line ${line}.`).value;
        c.expect('KEYWORD', 'to', `Expected "to" after "set ${name}" on line ${line}.`);
        return { type: 'Set', name, value: parseExpr(), line };
    }

    function parseIf() {
        const line = c.advance().line; // 'if'
        const test = parseExpr();
        c.expect('KEYWORD', 'then', `Expected "then" after the "if" condition on line ${line}.`);
        const consequent = parseBlock(['else', 'end']);
        let alternate = [];
        if (c.atKeyword('else')) { c.advance(); alternate = parseBlock(['end']); }
        c.expect('KEYWORD', 'end', `Expected "end" to close the "if" started on line ${line}.`);
        return { type: 'If', test, consequent, alternate, line };
    }

    function parseRepeat() {
        const line = c.advance().line; // 'repeat'
        const count = parseExpr();
        c.expect('KEYWORD', 'times', `Expected "times" after the repeat count on line ${line}.`);
        const body = parseBlock(['end']);
        c.expect('KEYWORD', 'end', `Expected "end" to close the "repeat" started on line ${line}.`);
        return { type: 'Repeat', count, body, line };
    }

    function parseWhile() {
        const line = c.advance().line; // 'while'
        const test = parseExpr();
        const body = parseBlock(['end']);
        c.expect('KEYWORD', 'end', `Expected "end" to close the "while" started on line ${line}.`);
        return { type: 'While', test, body, line };
    }

    function parseSave() {
        const line = c.advance().line; // 'save'
        const value = parseExpr();
        c.expect('KEYWORD', 'as', `Expected "as" after the value to save on line ${line}.`);
        const key = c.expect('STRING', undefined, `Expected a quoted key after "as" on line ${line}.`).value;
        return { type: 'Save', value, key, line };
    }

    function parseReturn() {
        const line = c.advance().line; // 'return'
        return { type: 'Return', value: parseExpr(), line };
    }

    function parseExpr() { return parseOr(); }
    function parseOr() {
        let left = parseAnd();
        while (c.atKeyword('or')) { const line = c.advance().line; left = { type: 'Logical', op: 'or', left, right: parseAnd(), line }; }
        return left;
    }
    function parseAnd() {
        let left = parseCmp();
        while (c.atKeyword('and')) { const line = c.advance().line; left = { type: 'Logical', op: 'and', left, right: parseCmp(), line }; }
        return left;
    }
    function parseCmp() {
        const left = parseAdd();
        if (c.atKeyword('is')) {
            const line = c.advance().line;
            let op = 'is';
            if (c.atKeyword('not')) { c.advance(); op = 'is not'; }
            return { type: 'Compare', op, left, right: parseAdd(), line };
        }
        if (c.at('SYMBOL', '>') || c.at('SYMBOL', '<') || c.at('SYMBOL', '>=') || c.at('SYMBOL', '<=')) {
            const opToken = c.advance();
            return { type: 'Compare', op: opToken.value, left, right: parseAdd(), line: opToken.line };
        }
        return left;
    }
    function parseAdd() {
        let left = parseMul();
        while (c.at('SYMBOL', '+') || c.at('SYMBOL', '-')) {
            const opToken = c.advance();
            left = { type: 'Binary', op: opToken.value, left, right: parseMul(), line: opToken.line };
        }
        return left;
    }
    function parseMul() {
        let left = parseUnary();
        while (c.at('SYMBOL', '*') || c.at('SYMBOL', '/') || c.atKeyword('mod')) {
            const opToken = c.advance();
            left = { type: 'Binary', op: opToken.value, left, right: parseUnary(), line: opToken.line };
        }
        return left;
    }
    function parseUnary() {
        if (c.atKeyword('not')) { const line = c.advance().line; return { type: 'Not', value: parseUnary(), line }; }
        if (c.at('SYMBOL', '-')) { const line = c.advance().line; return { type: 'Negate', value: parseUnary(), line }; }
        return parsePrimary();
    }
    function parsePrimary() {
        const token = c.peek();
        if (token.type === 'NUMBER') { c.advance(); return { type: 'Number', value: token.value, line: token.line }; }
        if (token.type === 'STRING') { c.advance(); return { type: 'String', value: token.value, line: token.line }; }
        if (c.atKeyword('true')) { c.advance(); return { type: 'Boolean', value: true, line: token.line }; }
        if (c.atKeyword('false')) { c.advance(); return { type: 'Boolean', value: false, line: token.line }; }
        if (c.atKeyword('get')) {
            c.advance();
            const key = c.expect('STRING', undefined, `Expected a quoted key after "get" on line ${token.line}.`).value;
            return { type: 'Get', key, line: token.line };
        }
        if (token.type === 'IDENT') { c.advance(); return { type: 'Var', name: token.value, line: token.line }; }
        if (c.at('SYMBOL', '(')) {
            c.advance();
            const expr = parseExpr();
            c.expect('SYMBOL', ')', `Expected ")" on line ${token.line}.`);
            return expr;
        }
        throw new MacroSyntaxError(`Unexpected "${token.value ?? token.type}" on line ${token.line}.`, token.line);
    }

    const statements = parseBlock([]);
    c.expect('EOF', undefined, `Unexpected "${c.peek().value}" on line ${c.peek().line} — did you forget an "end"?`);
    return { type: 'Program', statements };
}

function isNumeric(value) {
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'string' && value.trim() !== '') return Number.isFinite(Number(value));
    return false;
}
function toNumber(value) { return Number(value); }
function toDisplay(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return String(value);
}
function truthy(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') return value.length > 0;
    return Boolean(value);
}
function looseEquals(a, b) {
    if (isNumeric(a) && isNumeric(b)) return toNumber(a) === toNumber(b);
    return toDisplay(a) === toDisplay(b);
}

/**
 * Runs a parsed program. `get(key)`/`save(key, value)` are injected by the
 * caller, both SYNCHRONOUS — see this file's own top doc-comment for how
 * cores/macros/index.js reconciles that with its own async backing store.
 * Throws MacroRuntimeError/MacroTimeoutError; never returns a "partial"
 * result on failure — use `execute()` below for a result object that never
 * throws.
 */
export function run(ast, { get = () => undefined, save = () => {}, timeLimitMs = DEFAULT_TIME_LIMIT_MS } = {}) {
    const vars = Object.create(null);
    const startedAt = Date.now();
    const checkTime = () => {
        if (Date.now() - startedAt > timeLimitMs) throw new MacroTimeoutError(`Macro exceeded its ${timeLimitMs}ms time limit.`);
    };

    function evalExpr(node) {
        switch (node.type) {
            case 'Number': case 'String': case 'Boolean': return node.value;
            case 'Var': return Object.prototype.hasOwnProperty.call(vars, node.name) ? vars[node.name] : '';
            case 'Get': return get(node.key);
            case 'Negate': {
                const value = evalExpr(node.value);
                if (!isNumeric(value)) throw new MacroRuntimeError(`Line ${node.line}: cannot use "-" on a non-numeric value.`, node.line);
                return -toNumber(value);
            }
            case 'Not': return !truthy(evalExpr(node.value));
            case 'Logical': {
                const left = truthy(evalExpr(node.left));
                if (node.op === 'and') return left ? truthy(evalExpr(node.right)) : false;
                return left ? true : truthy(evalExpr(node.right));
            }
            case 'Compare': {
                const left = evalExpr(node.left);
                const right = evalExpr(node.right);
                if (node.op === 'is') return looseEquals(left, right);
                if (node.op === 'is not') return !looseEquals(left, right);
                if (!isNumeric(left) || !isNumeric(right)) throw new MacroRuntimeError(`Line ${node.line}: "${node.op}" needs two numbers.`, node.line);
                const a = toNumber(left); const b = toNumber(right);
                if (node.op === '>') return a > b;
                if (node.op === '<') return a < b;
                if (node.op === '>=') return a >= b;
                return a <= b; // '<='
            }
            case 'Binary': {
                const left = evalExpr(node.left);
                const right = evalExpr(node.right);
                if (node.op === '+') {
                    if (isNumeric(left) && isNumeric(right)) return toNumber(left) + toNumber(right);
                    return toDisplay(left) + toDisplay(right);
                }
                if (!isNumeric(left) || !isNumeric(right)) throw new MacroRuntimeError(`Line ${node.line}: "${node.op}" needs two numbers.`, node.line);
                const a = toNumber(left); const b = toNumber(right);
                if (node.op === '-') return a - b;
                if (node.op === '*') return a * b;
                if (b === 0) throw new MacroRuntimeError(`Line ${node.line}: division by zero.`, node.line);
                return node.op === 'mod' ? a % b : a / b;
            }
            default: throw new MacroRuntimeError(`Line ${node.line}: cannot evaluate "${node.type}".`, node.line);
        }
    }

    // Returns { type: 'return', value } if a `return` fired inside this block, else null.
    function execBlock(statements) {
        for (const statement of statements) {
            checkTime();
            const result = execStatement(statement);
            if (result) return result;
        }
        return null;
    }

    function execStatement(node) {
        switch (node.type) {
            case 'Set': vars[node.name] = evalExpr(node.value); return null;
            case 'Save': save(node.key, evalExpr(node.value)); return null;
            case 'Return': return { type: 'return', value: evalExpr(node.value) };
            case 'If': return truthy(evalExpr(node.test)) ? execBlock(node.consequent) : execBlock(node.alternate);
            case 'Repeat': {
                const countValue = evalExpr(node.count);
                if (!isNumeric(countValue)) throw new MacroRuntimeError(`Line ${node.line}: "repeat" needs a number.`, node.line);
                const count = Math.max(0, Math.floor(toNumber(countValue)));
                for (let i = 0; i < count; i++) {
                    if (i >= MAX_LOOP_ITERATIONS) throw new MacroRuntimeError(`Line ${node.line}: "repeat" exceeded ${MAX_LOOP_ITERATIONS} iterations.`, node.line);
                    checkTime();
                    const result = execBlock(node.body);
                    if (result) return result;
                }
                return null;
            }
            case 'While': {
                let iterations = 0;
                while (truthy(evalExpr(node.test))) {
                    if (++iterations > MAX_LOOP_ITERATIONS) throw new MacroRuntimeError(`Line ${node.line}: "while" exceeded ${MAX_LOOP_ITERATIONS} iterations.`, node.line);
                    checkTime();
                    const result = execBlock(node.body);
                    if (result) return result;
                }
                return null;
            }
            default: throw new MacroRuntimeError(`Line ${node.line}: cannot execute "${node.type}".`, node.line);
        }
    }

    const result = execBlock(ast.statements);
    return result ? toDisplay(result.value) : '';
}

/** tokenize -> parse -> run, normalized to a result that never throws. */
export function execute(source, options = {}) {
    try {
        const value = run(parse(tokenize(source)), options);
        return { ok: true, value };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
}

function visitExpr(node, keys) {
    if (!node) return;
    switch (node.type) {
        case 'Get': keys.push(node.key); return;
        case 'Negate': case 'Not': visitExpr(node.value, keys); return;
        case 'Logical': case 'Compare': case 'Binary': visitExpr(node.left, keys); visitExpr(node.right, keys); return;
        default: return; // Number/String/Boolean/Var — leaves, nothing to collect
    }
}

function visitStatements(statements, keys) {
    for (const statement of statements) {
        switch (statement.type) {
            case 'Set': case 'Save': case 'Return': visitExpr(statement.value, keys); break;
            case 'If': visitExpr(statement.test, keys); visitStatements(statement.consequent, keys); visitStatements(statement.alternate, keys); break;
            case 'Repeat': visitExpr(statement.count, keys); visitStatements(statement.body, keys); break;
            case 'While': visitExpr(statement.test, keys); visitStatements(statement.body, keys); break;
        }
    }
}

/**
 * Every string literal a `get "..."` expression reads anywhere in this
 * program — including inside if/repeat/while bodies and nested expressions
 * — without running it. Used by cores/macros/index.js to PRE-FETCH every
 * value a program could possibly need (via `tracking.value`/
 * `storage.chatMemory.get`) before `run()` is ever called — see this file's
 * own top doc-comment.
 */
export function collectGetKeys(ast) {
    const keys = [];
    visitStatements(ast.statements, keys);
    return keys;
}
