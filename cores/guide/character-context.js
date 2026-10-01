import { buildCharacterView } from '../../libraries/core/guide-character.js';

/**
 * Что гид знает о карточках персонажей: список имён и, пока тема в фокусе, полные карточки — открытого сейчас персонажа и названных в переписке
 * (по полному имени). Полные тексты идут только для нескольких карточек: длинная карточка весит тысячи токенов, а гиду нужны именно те, что она правит.
 */
const MAX_LISTED = 60;
const MAX_DETAILED = 3;
const MAX_VERSIONS_SHOWN = 8;
const MIN_NAME_LENGTH_TO_MATCH = 3;

const escapeForRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const namesCardInText = (name, text) => name.length >= MIN_NAME_LENGTH_TO_MATCH && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeForRegExp(name)}([^\\p{L}\\p{N}]|$)`, 'iu').test(text);
const formatVersionDate = at => new Date(at).toISOString().slice(0, 16).replace('T', ' ');

export function createCharacterContext({ call, callService }) {
    async function listEntries() {
        const listed = await call('characterCard.list');
        return listed.ok ? listed.value ?? [] : [];
    }

    async function pickDetailed(entries, query) {
        const open = await callService('stCharacter.current');
        const picked = [];
        const openEntry = open.ok && open.value?.avatar ? entries.find(entry => entry.avatar === open.value.avatar) : null;
        if (openEntry) picked.push({ entry: openEntry, isOpen: true });
        for (const entry of entries) {
            if (picked.length >= MAX_DETAILED) break;
            if (!picked.some(item => item.entry.avatar === entry.avatar) && namesCardInText(entry.name, query)) picked.push({ entry, isOpen: false });
        }
        return picked;
    }

    async function describeDetailed({ entry, isOpen }) {
        const card = await call('characterCard.get', { avatar: entry.avatar });
        if (!card.ok) return '';
        const versions = await call('characterCard.versions', { avatar: entry.avatar });
        const versionLine = versions.ok && versions.value?.length
            ? `Saved versions of ${entry.avatar} (newest first; key — when — note): ${versions.value.slice(0, MAX_VERSIONS_SHOWN).map(version => `${version.key} — ${formatVersionDate(version.at)} — ${version.label}`).join('; ')}.`
            : `No saved versions of ${entry.avatar} yet.`;
        return `${isOpen ? '[The character open in SillyTavern right now]\n' : ''}${buildCharacterView(card.value)}\n${versionLine}`;
    }

    /** `{ lines, count }`: строки для промпта (пусто, пока тема не в фокусе) и число карточек для строки «есть ещё». */
    async function describe({ focus, query = '' }) {
        const entries = await listEntries();
        if (!focus.characters || !entries.length) return { lines: [], count: entries.length };
        const listed = entries.slice(0, MAX_LISTED).map(entry => `${entry.avatar} (“${entry.name}”)`).join('; ');
        const lines = [`Character cards (avatar file — name): ${listed}${entries.length > MAX_LISTED ? `; …and ${entries.length - MAX_LISTED} more` : ''}. Cards below are shown in full; for another character ask the user to name it.`];
        for (const picked of await pickDetailed(entries, query)) {
            const text = await describeDetailed(picked);
            if (text) lines.push(text);
        }
        return { lines, count: entries.length };
    }

    return { describe };
}
