/**
 * Снимает с настоящего Chromium таблицу мест переноса между парами символов и пишет её модулем `libraries/shared/text-layout/break-table.js`.
 *
 * Зачем: перенос внутри «слова» у Chrome не совпадает с учебным UAX #14 (для ASCII у него своя таблица): после `?` перенос есть почти перед
 * чем угодно (ради ссылок), после `!` перед буквой — нет, после `…`/`—` перед буквой — есть. Угадывать правила — значит расходиться с
 * браузером на краях; здесь они измеряются.
 *
 * Метод: для каждой пары (a, b) текст `ww{a}{b}www` в блоке шириной ровно по `ww{a}` (+0,5px). Если перенос между a и b разрешён, a остаётся
 * на первой строке, а b уходит на вторую. Контекст слева — буквы (`ww`), как внутри обычного слова.
 *
 * Запуск: `node tools/text-layout-check/probe-breaks.mjs` (нужен `playwright`; путь к браузеру — `CHROMIUM_PATH`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

/** Представители классов: ASCII-пунктуация целиком, буква, цифра, типографика, CJK, эмодзи. Остальные символы сводятся к ним (`break-table.js`). */
export const PROBE_CHARS = [...'!"#$%&\'()*+,-./0123456789:;<=>?@[\\]^_`{|}~', 'a', '…', '—', '–', '‐', '“', '”', '‘', '’', '«', '»', '、', '。', '「', '」', '日', '😀', '№', '°', '·', '•'];

const target = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../libraries/shared/text-layout/break-table.js');
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
    const page = await browser.newPage();
    await page.setContent('<div id="host" style="font: 15px/1.4 monospace; position: absolute"></div>');
    const version = browser.version();
    const table = await page.evaluate(chars => {
        const block = document.createElement('div');
        document.getElementById('host').append(block);
        const range = document.createRange();
        const rectOf = (node, start, length) => { range.setStart(node, start); range.setEnd(node, start + length); return range.getClientRects()[0]; };
        const rows = {};
        for (const a of chars) {
            let row = '';
            for (const b of chars) {
                block.style.display = 'inline-block';
                block.style.width = 'auto';
                block.textContent = `ww${a}`;
                const width = block.getBoundingClientRect().width;
                block.style.display = 'block';
                block.style.width = `${width + 0.5}px`;
                block.textContent = `ww${a}${b}www`;
                const node = block.firstChild;
                const first = rectOf(node, 0, 1);
                const left = rectOf(node, 2, a.length);
                const right = rectOf(node, 2 + a.length, b.length);
                if (first && left && right && Math.abs(left.top - first.top) < 5 && right.top > first.top + 5) row += b;
            }
            rows[a] = row;
        }
        return rows;
    }, PROBE_CHARS);
    const body = Object.entries(table).map(([a, row]) => `    ${JSON.stringify(a)}: ${JSON.stringify(row)},`).join('\n');
    fs.writeFileSync(target, `/**
 * СГЕНЕРИРОВАНО \`tools/text-layout-check/probe-breaks.mjs\` (${version}) — не править руками, перегенерировать.
 *
 * Для символа-представителя слева — строка символов-представителей справа, ПЕРЕД которыми Chrome разрешает перенос строки (внутри слова,
 * без пробела). Как символы сводятся к представителям — \`breaks.js\`.
 */
export const CHROME_BREAKS_AFTER = {
${body}
};
`);
    console.log(`wrote ${path.relative(process.cwd(), target)} (${Object.keys(table).length} rows, ${version})`);
} finally {
    await browser.close();
}
