import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';
import { Button, Row, Field, TextInput, TextArea, NumberInput, Toggle, Select, Badge, EmptyState } from '../../../libraries/shared/widgets.js';
import { applyRules, importStRegexScripts } from '../../../libraries/core/pm-rules.js';

const KINDS = [
    { value: 'text', label: 'Replace a phrase' }, { value: 'remove', label: 'Remove a phrase' },
    { value: 'between', label: 'Remove everything between two marks' }, { value: 'regex', label: 'Regex (advanced)' },
];
const TARGETS = [{ value: 'all', label: 'the whole prompt' }, { value: 'history', label: 'chat history only' }, { value: 'prompt', label: 'preset prompts only (not the chat)' }];
const ROLES = ['user', 'assistant', 'system'];

/** Вкладка «Text rules»: правила замены простыми словами поверх regex; меняют только исходящий промпт. Есть проверка на образце текста. */
export function createRulesTab({ state, actions, pickFile }) {
    const sample = signal('The dragon said hello.');

    const updateRule = (index, mutator) => actions.patch(preset => { const rule = preset.rules[index]; if (rule) mutator(rule); });
    const bound = (initial, apply) => { const value = signal(initial); const set = value.set; value.set = next => { set(next); apply(next); }; return value; };

    function findFields(rule, index) {
        const find = rule.find;
        const set = (key, value) => updateRule(index, r => { r.find[key] = value; });
        if (find.kind === 'between') return [
            Row(Field('From', TextInput(bound(find.from ?? '', v => set('from', v)))), Field('To', TextInput(bound(find.to ?? '', v => set('to', v))))),
            Toggle('Keep the two marks', bound(Boolean(find.keepEdges), v => set('keepEdges', v))),
        ];
        if (find.kind === 'regex') return [Row(Field('Pattern', TextInput(bound(find.pattern ?? '', v => set('pattern', v)))), Field('Flags', TextInput(bound(find.flags ?? '', v => set('flags', v)))))];
        return [Field('Phrase', TextInput(bound(find.value ?? '', v => set('value', v)))), Toggle('Whole word only', bound(Boolean(find.wholeWord), v => set('wholeWord', v))), Toggle('Match case', bound(Boolean(find.caseSensitive), v => set('caseSensitive', v)))];
    }

    function ruleView(rule, index) {
        const scope = rule.scope ?? {};
        const setScope = (key, value) => updateRule(index, r => { r.scope = { ...(r.scope ?? {}), [key]: value }; });
        const roleToggle = role => Toggle(role, bound(!(scope.roles?.length) || scope.roles.includes(role), checked => updateRule(index, r => {
            const current = new Set(r.scope?.roles?.length ? r.scope.roles : ROLES);
            if (checked) current.add(role); else current.delete(role);
            r.scope = { ...(r.scope ?? {}), roles: current.size === ROLES.length ? [] : [...current] };
        })));
        return h('div', { class: 'stme-pm-rule' },
            h('div', { class: 'stme-pm-rule-head' }, Toggle(rule.name || 'Rule', bound(rule.enabled !== false, v => updateRule(index, r => { r.enabled = v; }))),
                Row(rule.imported ? Badge('from ST') : null, Button('Remove', () => actions.edit(preset => { preset.rules.splice(index, 1); }), { variant: 'danger' }))),
            Field('Name', TextInput(bound(rule.name ?? '', v => updateRule(index, r => { r.name = v; })))),
            ...findFields(rule, index),
            rule.find.kind === 'remove' ? null : Field('Replace with (macros and $1 work)', TextInput(bound(rule.replace ?? '', v => updateRule(index, r => { r.replace = v; })))),
            h('div', { class: 'stme-pm-help' }, 'Applies to messages written by:'),
            Row(...ROLES.map(roleToggle)),
            Field('Where', Select(bound(scope.targets ?? 'all', v => setScope('targets', v)), TARGETS)),
            Row(Field('Not newer than N messages from the end', NumberInput(bound(scope.minDepth ?? '', v => setScope('minDepth', v === '' ? undefined : Number(v))), { min: 0, max: 1000 })),
                Field('Not older than N messages from the end', NumberInput(bound(scope.maxDepth ?? '', v => setScope('maxDepth', v === '' ? undefined : Number(v))), { min: 0, max: 1000 }))),
        );
    }

    function add(kind) {
        const find = kind === 'between' ? { kind, from: '<think>', to: '</think>' } : kind === 'regex' ? { kind, pattern: '', flags: 'gi' } : { kind, value: '' };
        actions.edit(preset => { preset.rules = [...(preset.rules ?? []), { id: `rule_${Date.now().toString(36)}`, name: 'New rule', enabled: true, find, replace: '', scope: { roles: [], targets: 'all' } }]; });
    }

    async function importFile() {
        const picked = await pickFile();
        if (!picked) return;
        let json;
        try { json = JSON.parse(picked.text); } catch { return; }
        const scripts = Array.isArray(json) ? json : json.scriptName !== undefined ? [json] : json.extensions?.regex_scripts ?? [];
        const rules = importStRegexScripts(scripts);
        if (rules.length) actions.edit(preset => { preset.rules = [...(preset.rules ?? []), ...rules]; });
    }

    function tree() {
        return h('div', { class: 'stme-pm-editor' }, computed(() => {
            const preset = state.preset();
            if (!preset) return EmptyState('Select a preset first.');
            const rules = preset.rules ?? [];
            const tryIt = computed(() => { state.rev(); return applyRules([{ role: 'user', content: sample(), _hid: 0 }], rules)[0].content; });
            return h('div', { class: 'stme-pm-editor' },
                h('p', { class: 'stme-pm-help' }, 'Text rules change the text that goes to the model — never your saved chat. Describe what to replace in plain words; regex is only for the advanced cases and for scripts imported from SillyTavern.'),
                Row(...KINDS.map(kind => Button(`+ ${kind.label}`, () => add(kind.value))), Button('Import ST regex scripts (file)', importFile)),
                rules.length ? rules.map(ruleView) : EmptyState('No rules yet.'),
                h('h4', {}, 'Try the rules'),
                Field('Sample text (as a user message)', TextArea(sample, { rows: 3 })),
                h('pre', { class: 'stme-pm-try' }, tryIt),
            );
        }));
    }
    return { tree };
}
