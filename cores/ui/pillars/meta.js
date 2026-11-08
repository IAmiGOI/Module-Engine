/**
 * Пять столпов меню: порядок по кругу, заголовок и подпись вида. Углы —
 * те же, что в утверждённом макете (`docs/research-decision/mockups/five-pillars.html`):
 * Court сверху, дальше по часовой стрелке.
 */
export const PILLARS = Object.freeze([
    { id: 'court', angle: -90, title: 'The Court', lead: 'Five voices at work, and what waits for you.', call: true },
    { id: 'bank', angle: -18, title: 'The Great Bank', lead: 'Five lives kept, and every change to them.' },
    { id: 'world', angle: 54, title: 'The World', lead: 'What God wrote, and what the world has learned.' },
    { id: 'charter', angle: 126, title: 'The Charter', lead: 'The laws this engine keeps.' },
    { id: 'canon', angle: 198, title: 'The Canon', lead: 'Worlds sealed for another story.' },
]);

export const PILLAR_IDS = Object.freeze(PILLARS.map(pillar => pillar.id));

export function pillarMeta(id) {
    return PILLARS.find(pillar => pillar.id === id) ?? null;
}
