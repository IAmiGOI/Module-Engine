/**
 * «Что нового» для гида (cores/guide): чистые функции. Ответ GitHub `compare` → список изменений, которые стоит показать человеку.
 * Берутся заголовки коммитов (первая строка) — их пишут понятными предложениями; слияния и служебные записи отбрасываются.
 */

const NOISE = /^(merge\b|revert\b|wip\b|fixup!|squash!)/i;
const MAX_SUBJECT = 160;

/** Ответ `GET /repos/{owner}/{repo}/compare/{old}...{new}` → `{ subjects, total }`; новее — выше, повторы убраны. */
export function parseCompare(payload) {
    const commits = Array.isArray(payload?.commits) ? payload.commits : [];
    const seen = new Set();
    const subjects = [];
    for (const item of [...commits].reverse()) {
        const subject = String(item?.commit?.message ?? '').split('\n')[0].trim().slice(0, MAX_SUBJECT);
        if (!subject || NOISE.test(subject) || seen.has(subject)) continue;
        seen.add(subject);
        subjects.push(subject);
    }
    return { subjects, total: subjects.length };
}

/** Текст реплики гида: сколько изменений и первые `limit` из них; остаток — числом. */
export function formatWhatsNew({ subjects, total }, { limit = 8 } = {}) {
    if (!total) return '';
    const shown = subjects.slice(0, limit).map(subject => `- ${subject}`).join('\n');
    const rest = total > limit ? `\n…and ${total - limit} more.` : '';
    return `I've been updated — ${total} change${total === 1 ? '' : 's'} since you last opened me:\n\n${shown}${rest}\n\nAsk me if you want any of it explained.`;
}
