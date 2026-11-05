/**
 * Сохранённые наборы настроек игры (часть 14) — чистые функции над массивом
 * `{ id, name, values }`. Хранятся глобально рядом с `settings.gameDefaults`,
 * до восьми штук. Игрок сохраняет свой Custom под именем, применяет его в
 * другом чате и явно обновляет — правка опции сохранённый набор не трогает.
 */
import { GAME_OPTIONS, clampGameSettings } from './game-settings.js';

export const MAX_GAME_MIXES = 8;
const NAME_MAX = 40;
const ID_MAX = 48;

const cleanName = value => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, NAME_MAX);
const cleanId = value => String(value ?? '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, ID_MAX);

function cleanMix(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const name = cleanName(value.name);
    const id = cleanId(value.id);
    if (!name || !id || !value.values || typeof value.values !== 'object' || Array.isArray(value.values)) return null;
    return { id, name, values: clampGameSettings(value.values) };
}

/** Мусор на диске не ломает окно: без id/имени/набора запись отбрасывается, лишние — обрезаются. */
export function clampGameMixes(value) {
    const out = [];
    const ids = new Set();
    for (const item of Array.isArray(value) ? value : []) {
        const mix = cleanMix(item);
        if (!mix || ids.has(mix.id)) continue;
        ids.add(mix.id);
        out.push(mix);
        if (out.length >= MAX_GAME_MIXES) break;
    }
    return out;
}

export function findGameMix(mixes, id) {
    return clampGameMixes(mixes).find(mix => mix.id === String(id ?? '')) ?? null;
}

/** Совпадение текущего набора с сохранённым — для подсветки плитки. */
export function matchGameMix(mixes, values) {
    const clean = clampGameSettings(values);
    return clampGameMixes(mixes).find(mix => GAME_OPTIONS.every(option => mix.values[option.id] === clean[option.id])) ?? null;
}

/** Идентификатор нового набора: стабильный префикс + счётчик, без сети и времени. */
export function nextGameMixId(mixes, seed = '') {
    const taken = new Set(clampGameMixes(mixes).map(mix => mix.id));
    const base = `mix_${cleanId(seed) || 'saved'}`.slice(0, ID_MAX);
    if (!taken.has(base)) return base;
    for (let index = 2; index < 1000; index += 1) {
        const id = `${base}_${index}`.slice(0, ID_MAX);
        if (!taken.has(id)) return id;
    }
    return `${base}_${Date.now().toString(36)}`.slice(0, ID_MAX);
}

export function addGameMix(mixes, { id = '', name = '', values = {} } = {}) {
    const list = clampGameMixes(mixes);
    const clean = cleanName(name);
    if (!clean) return { ok: false, error: 'A mix needs a name.' };
    if (list.length >= MAX_GAME_MIXES) return { ok: false, error: `At most ${MAX_GAME_MIXES} mixes can be saved.` };
    const requested = cleanId(id);
    const mixId = requested && !list.some(mix => mix.id === requested) ? requested : nextGameMixId(list, requested || name);
    const mix = { id: mixId, name: clean, values: clampGameSettings(values) };
    return { ok: true, mixes: [...list, mix], mix };
}

export function renameGameMix(mixes, id, name) {
    const list = clampGameMixes(mixes);
    const clean = cleanName(name);
    if (!clean) return { ok: false, error: 'A mix needs a name.' };
    if (!list.some(mix => mix.id === String(id ?? ''))) return { ok: false, error: 'No such mix.' };
    return { ok: true, mixes: list.map(mix => (mix.id === String(id) ? { ...mix, name: clean } : mix)) };
}

export function removeGameMix(mixes, id) {
    const list = clampGameMixes(mixes);
    if (!list.some(mix => mix.id === String(id ?? ''))) return { ok: false, error: 'No such mix.' };
    return { ok: true, mixes: list.filter(mix => mix.id !== String(id)) };
}

/** Обновить сохранённый набор текущим — только явной кнопкой. */
export function updateGameMix(mixes, id, values) {
    const list = clampGameMixes(mixes);
    if (!list.some(mix => mix.id === String(id ?? ''))) return { ok: false, error: 'No such mix.' };
    return { ok: true, mixes: list.map(mix => (mix.id === String(id) ? { ...mix, values: clampGameSettings(values) } : mix)) };
}
