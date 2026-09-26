/**
 * Прогон сверки в headless Chromium: поднимает статический сервер на корне репозитория, открывает `index.html`, ждёт отчёт и печатает
 * сводку (полный отчёт — в `--out <файл>`). Запуск: `node tools/text-layout-check/run.mjs [--fonts <url-база>] [--out report.json]`.
 * Нужен пакет `playwright` (глобальный или локальный) и Chromium; путь к браузеру — `CHROMIUM_PATH`, иначе встроенный в Playwright.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };
const extraRoots = option('--serve') ? { '/fonts/': path.resolve(option('--serve')) } : {};

const server = http.createServer((request, response) => {
    const url = decodeURIComponent(new URL(request.url, 'http://x').pathname);
    let file = path.join(root, url);
    for (const [prefix, dir] of Object.entries(extraRoots)) if (url.startsWith(prefix)) file = path.join(dir, url.slice(prefix.length));
    if (!file.startsWith(root) && !Object.values(extraRoots).some(dir => file.startsWith(dir))) { response.writeHead(403).end(); return; }
    fs.readFile(file, (error, data) => {
        if (error) { response.writeHead(404).end(); return; }
        response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(data);
    });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const query = new URLSearchParams();
if (option('--fonts')) query.set('fonts', option('--fonts'));
else if (option('--serve')) query.set('fonts', `http://127.0.0.1:${port}/fonts`);
if (option('--widths')) query.set('widths', option('--widths'));
if (option('--count')) query.set('count', option('--count'));

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
    const page = await browser.newPage({ deviceScaleFactor: Number(option('--dpr') ?? 1) });
    page.on('pageerror', error => console.error('page error:', error.message));
    await page.goto(`http://127.0.0.1:${port}/tools/text-layout-check/index.html?${query}`);
    await page.waitForFunction(() => window.__layoutReport, null, { timeout: 600000 });
    const report = await page.evaluate(() => window.__layoutReport);
    if (option('--out')) fs.writeFileSync(option('--out'), JSON.stringify(report, null, 2));
    const { mismatches, ...summary } = report;
    console.log(JSON.stringify(summary, null, 2));
    console.log(`mismatches: ${mismatches.length}`);
    for (const run of mismatches.slice(0, Number(option('--show') ?? 15))) console.log(JSON.stringify(run));
} finally {
    await browser.close();
    server.close();
}
