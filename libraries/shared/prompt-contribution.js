/**
 * Вклад модуля в промпт через Prompt Manager (контракт chat-inject нового образца).
 * Раньше каждый вкладчик правил `chat` руками (`chat.unshift/splice`); теперь, если PM берёт сборку на себя,
 * вклад объявляется `promptManager.contribute`, а место выбирает пользователь в окне PM. Если PM выключен,
 * не поддерживает текущий чат или недоступен — работает прежняя вставка (`legacy`), поведение не меняется.
 *
 *   call(contract, params) → конверт `{ ok, value }` (как у `request()` вызывающего)
 *   contribution — { id, name, role, content, defaultPlacement, stable }; пустой `content` снимает вклад
 *   legacy() — прежняя вставка в `chat`
 * Возвращает 'contributed' | 'legacy'. Никогда не бросает.
 */
export async function deliverToPrompt({ call, contribution, legacy }) {
    let takesOver = false;
    try {
        const answer = await call('promptManager.takesOver', {});
        takesOver = Boolean(answer?.ok && answer.value === true);
    } catch { takesOver = false; }
    if (!takesOver) { legacy?.(); return 'legacy'; }
    try {
        const hasContent = typeof contribution.content === 'string' && contribution.content.trim() !== '';
        const answer = hasContent ? await call('promptManager.contribute', contribution) : await call('promptManager.retract', { id: contribution.id });
        if (answer?.ok) return 'contributed';
    } catch { /* ниже — прежний путь */ }
    legacy?.();
    return 'legacy';
}
