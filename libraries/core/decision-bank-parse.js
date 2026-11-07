import { MATERIAL_SECTIONS, SPIRITUAL_SECTIONS, DECREE_SECTIONS } from './decision-bank-sections.js';

/**
 * Разбор текста банка по разделам Great Bank — чистые правила, без модели.
 *
 * Новый сборщик пишет сразу по разделам:
 *
 *     ***Rem***
 *     Material 1 — Appearance
 *     - Blue hair, one horn.
 *     Spiritual 4 — Needs and goals
 *     - Wants to be seen as herself, not as her sister.
 *
 * Движок принимает и заголовок без названия части («Appearance», «Values»), и
 * нумерацию «Material 1.», «Spiritual 6:». Строки до первого заголовка уходят
 * в «Другие предметные факты» (Material 7), поэтому факт не теряется. Банк,
 * где не нашлось ни одного заголовка, — банк старого сборщика: `ready: false`,
 * и в проекциях он идёт свободным текстом (старые банки не переводим).
 */

const text = value => String(value ?? '').trim();

const BY_NAME = new Map();
for (const section of [...MATERIAL_SECTIONS, ...SPIRITUAL_SECTIONS]) {
    BY_NAME.set(section.name.toLowerCase(), section);
    BY_NAME.set(section.id.replace(/-/g, ' '), section);
}
const OTHER_MATERIAL = MATERIAL_SECTIONS[6];

const HEADER = /^\s*(?:#{1,6}\s*)?\*{0,2}\s*(material|spiritual|decree)\s*(\d{1,2})?\s*(?:[—–\-.:·]\s*)?(.*?)\*{0,2}\s*$/i;

function normalize(value) {
    return text(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function sectionFromName(value, fallbackPart = null) {
    const clean = normalize(value);
    if (!clean) return null;
    const direct = BY_NAME.get(clean);
    if (direct) return direct;
    const list = fallbackPart === 'spiritual' ? SPIRITUAL_SECTIONS : fallbackPart === 'material' ? MATERIAL_SECTIONS : [...MATERIAL_SECTIONS, ...SPIRITUAL_SECTIONS];
    return list.find(section => normalize(section.name).startsWith(clean) || clean.startsWith(normalize(section.name)))
        ?? list.find(section => normalize(section.id.replace(/-/g, ' ')) === clean)
        ?? null;
}

function headerOf(line) {
    const trimmed = text(line);
    if (!trimmed || /^\s*[-*•]\s+/.test(trimmed)) return null;
    const match = HEADER.exec(trimmed);
    if (match) {
        const part = match[1].toLowerCase();
        const no = match[2] ? Number(match[2]) : null;
        const label = text(match[3]).replace(/^\*+|\*+$/g, '').trim();
        const list = part === 'material' ? MATERIAL_SECTIONS : part === 'spiritual' ? SPIRITUAL_SECTIONS : DECREE_SECTIONS;
        const found = no === null ? sectionFromName(label, part === 'decree' ? null : part) : list.find(section => section.no === no);
        if (found) return { ...found, labelled: true };
        if (no !== null) return { ...(part === 'spiritual' ? { part: 'spiritual', no: 0 } : part === 'decree' ? { part: 'decree', no } : OTHER_MATERIAL), labelled: true };
    }
    // Заголовок без названия части: только само название раздела, отдельной короткой строкой без пояснения.
    if (trimmed.length > 48 || /[—–]/.test(trimmed)) return null;
    const found = sectionFromName(trimmed);
    return found ? { ...found, labelled: false } : null;
}

function bodyLine(line) {
    return text(line).replace(/^\s*[-*•]\s+/, '').replace(/^\s*\d+[.)]\s+/, '').trim();
}

/**
 * @returns {{ material: Record<number, string[]>, spiritual: Record<number, string[]>, decree: Record<number, string[]>, ready: boolean, identity: string }}
 */
export function parseBankSections(bankText) {
    const material = Object.fromEntries(MATERIAL_SECTIONS.map(section => [section.no, []]));
    const spiritual = Object.fromEntries([[0, []], ...SPIRITUAL_SECTIONS.map(section => [section.no, []])]);
    const decree = {};
    const rows = String(bankText ?? '').split('\n').map(line => line.replace(/\r$/, ''));
    let identity = '';
    let current = null;
    let heads = 0;
    const cart = (line, fallback) => {
        const body = bodyLine(line);
        if (!body) return;
        const target = current ?? fallback;
        if (!target || target.part === 'decree') return;
        if (target.part === 'material') material[target.no]?.push(body);
        else (spiritual[target.no] ??= []).push(body);
    };
    for (const line of rows) {
        if (!text(line)) continue;
        if (/^\W*importance\W*:/i.test(line.trim())) continue;
        const heading = headerOf(line);
        if (heading) {
            // Настоящая разметка — заголовок с названием части или с номером: по ней и решается, что банк по разделам.
            if (heading.labelled) heads += 1;
            current = heading;
            continue;
        }
        const identityMatch = /^\s*\*{3}[^*]+\*{3}\s*$/.exec(line);
        if (identityMatch && !identity && !heads) {
            identity = line.replace(/\*/g, '').trim();
            continue;
        }
        cart(line, heads ? OTHER_MATERIAL : null);
    }
    const ready = heads > 0;
    return ready ? { material, spiritual, decree, ready, identity } : { material: {}, spiritual: {}, decree: {}, ready: false, identity };
}
