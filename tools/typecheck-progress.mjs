// Typing progress report: how many files opted in with `// @ts-check`, and how many errors the rest would have
// if checked under the same strict settings. Dev tool only — nothing in the engine imports it.
//
//   node tools/typecheck-progress.mjs          (or: npm run typecheck:progress)
//
// Needs network on first use (npx fetches the TypeScript compiler, which is NOT a project dependency).

import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SKIP = new Set(['node_modules', '.git', 'data', '.claude', '.hermes', 'tests', 'assets']);

/** @param {string} dir @returns {string[]} */
function listSources(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        if (SKIP.has(entry.name)) return [];
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return listSources(path);
        return /\.(m?js)$/.test(entry.name) ? [path] : [];
    });
}

const files = listSources(root).map(path => relative(root, path).split(sep).join('/'));
const optedIn = files.filter(file => readFileSync(join(root, file), 'utf8').trimStart().startsWith('// @ts-check'));

// Same options as jsconfig.json, but with checkJs on for every file.
const base = JSON.parse(readFileSync(join(root, 'jsconfig.json'), 'utf8'));
const temp = mkdtempSync(join(tmpdir(), 'stme-typecheck-'));
const configPath = join(temp, 'tsconfig.json');
writeFileSync(configPath, JSON.stringify({
    ...base,
    compilerOptions: { ...base.compilerOptions, checkJs: true },
    include: [join(root, '**/*.js'), join(root, '**/*.mjs')].map(path => path.split(sep).join('/')),
    exclude: base.exclude.map((/** @type {string} */ item) => join(root, item).split(sep).join('/')),
}));

let output = '';
try {
    output = execSync(`npx -y -p typescript tsc -p "${configPath}"`, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (error) {
    // tsc exits non-zero when it finds errors — that is the normal case here.
    output = String(/** @type {{ stdout?: string }} */ (error).stdout ?? '');
} finally {
    rmSync(temp, { recursive: true, force: true });
}

/** @type {Map<string, number>} */
const perFile = new Map();
for (const line of output.split('\n')) {
    const match = /^(.+?)\(\d+,\d+\): error TS\d+/.exec(line);
    if (!match) continue;
    const file = relative(root, match[1]).split(sep).join('/') || match[1];
    perFile.set(file, (perFile.get(file) ?? 0) + 1);
}

const total = [...perFile.values()].reduce((sum, count) => sum + count, 0);
console.log(`Opted in (// @ts-check): ${optedIn.length} of ${files.length} files`);
console.log(`Errors in files that have NOT opted in yet: ${total}\n`);

const perFolder = new Map();
for (const [file, count] of perFile) {
    if (optedIn.includes(file)) continue;
    const parts = file.split('/');
    const folder = parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0];
    perFolder.set(folder, (perFolder.get(folder) ?? 0) + count);
}
console.log('By folder (most errors first):');
for (const [folder, count] of [...perFolder].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(count).padStart(5)}  ${folder}`);

const easiest = [...perFile].filter(([file]) => !optedIn.includes(file)).sort((a, b) => a[1] - b[1]).slice(0, 15);
console.log('\nEasiest next files (fewest errors):');
for (const [file, count] of easiest) console.log(`  ${String(count).padStart(5)}  ${file}`);
