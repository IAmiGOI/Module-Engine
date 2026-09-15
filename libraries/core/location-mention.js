/**
 * Closed-set location-name matching for the map's narration-driven route
 * injection (ROADMAP.md, owner: "Если в ближайших 4 сообщениях упоминаются
 * локации - инжектится на @4 маршрут"). Same principle already established
 * for speaker detection — see [[feedback-speaker-detection-testing]] and
 * `libraries/core/speaker-detection.js`'s `findKnownMention()`: match
 * against a KNOWN, closed set of names (here, the map's own node names),
 * never guess a location out of open prose. No DOM/ST/network/storage.
 */

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scans `messages` (oldest-to-newest — the same order `chatHistory.messages`
 * already returns) for the MOST RECENT mention of any known location among
 * `nodes` (`{id, name}` pairs — a node with no `name` is skipped). Later
 * messages win over earlier ones; within a single message, the LATEST
 * occurrence wins over an earlier one in the same line — both match "what
 * location has the conversation most recently been talking about", not
 * "what location was mentioned first". Whole-word, case-insensitive
 * (prose may write a location name in a different case than the node's own
 * `name`). Returns the matched node's `id`, or `null` if nothing known was
 * mentioned anywhere in `messages`.
 */
export function findMostRecentLocationMention(messages, nodes) {
    const named = nodes.filter(node => node?.name);
    if (!named.length) return null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const text = String(messages[i]?.text ?? '');
        if (!text) continue;
        let best = null;
        for (const node of named) {
            const pattern = new RegExp(`\\b${escapeRegExp(node.name)}\\b`, 'ig');
            let match;
            while ((match = pattern.exec(text))) {
                if (!best || match.index > best.index) best = { id: node.id, index: match.index };
            }
        }
        if (best) return best.id;
    }
    return null;
}
