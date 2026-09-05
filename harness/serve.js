import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tiny static file server, no dependencies — serves the whole Beta/ tree
 * (not just harness/) so harness/main.js's `../cores/...`-style relative
 * imports resolve to real engine files, exactly as written. Only exists to
 * get real browser ES module semantics (relative imports need http://, not
 * file://) — not part of the engine itself.
 */
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = 8420;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    // A real redirect, not a silent rewrite: serving the harness page's bytes
    // at "/" would leave the browser resolving `main.js` against the ROOT,
    // where it doesn't exist. The page must actually live at its own path.
    if (urlPath === '/') {
        res.writeHead(302, { Location: '/harness/index.html' });
        res.end();
        return;
    }
    const filePath = path.join(root, urlPath);
    if (!filePath.startsWith(root)) { res.writeHead(403); res.end('Forbidden'); return; }
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end(`Not found: ${urlPath}`); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
        res.end(data);
    });
});

server.listen(port, () => console.log(`Beta test harness: http://localhost:${port}/`));
