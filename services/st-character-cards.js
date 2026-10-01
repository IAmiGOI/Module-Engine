/**
 * Сервис карточек персонажей ST — транспорт и ничего больше: список, чтение, создание и слияние атрибутов через родные эндпоинты SillyTavern 1.18
 * (`/api/characters/get`, `/create`, `/merge-attributes`). Что класть в карточку и как её понимать решают Библиотека и Ядро `characterCard`.
 *
 * После записи список персонажей в самом ST перечитывается: `getCharacters()` заново выбирает открытого персонажа и обновляет форму редактора,
 * иначе форма с прежними значениями перезаписала бы нашу правку при своём следующем сохранении.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function registerStCharacterCardsService(bus, { getContext, fetch: fetchImpl = globalThis.fetch?.bind(globalThis), FormDataCtor = globalThis.FormData } = {}) {
    const buildHeaders = (options = {}) => getContext()?.getRequestHeaders?.(options) ?? {};

    async function postJson(url, body) {
        const response = await fetchImpl(url, { method: 'POST', headers: { ...JSON_HEADERS, ...buildHeaders() }, body: JSON.stringify(body), cache: 'no-store' });
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        return response;
    }

    // Запись уже на диске; если перечитать не вышло, ST подтянет список при следующем действии пользователя.
    async function refreshStCharacterList() {
        try { await getContext()?.getCharacters?.(); } catch { /* см. выше */ }
    }

    function listCharacterEntries() {
        const characters = getContext()?.characters;
        return (Array.isArray(characters) ? characters : []).filter(item => item?.avatar).map(item => ({ avatar: item.avatar, name: String(item.name ?? ''), tags: Array.isArray(item.tags) ? item.tags.map(String) : [] }));
    }

    // Список ST может быть «облегчённым» (ленивая загрузка карточек), поэтому полные данные берутся с диска, а не из списка.
    async function loadCharacterCard({ avatar } = {}) {
        if (!avatar) throw new Error('Which character? The avatar file name is needed.');
        return (await postJson('/api/characters/get', { avatar_url: avatar })).json();
    }

    async function createCharacterCard({ form } = {}) {
        if (!form?.ch_name) throw new Error('The character needs a name.');
        const body = new FormDataCtor();
        for (const [key, value] of Object.entries(form)) for (const item of Array.isArray(value) ? value : [value]) body.append(key, String(item));
        const response = await fetchImpl('/api/characters/create', { method: 'POST', headers: buildHeaders({ omitContentType: true }), body, cache: 'no-store' });
        if (!response.ok) throw new Error(`/api/characters/create: HTTP ${response.status}`);
        const avatar = (await response.text()).trim();
        await refreshStCharacterList();
        return { avatar };
    }

    async function mergeCharacterAttributes({ avatar, body } = {}) {
        if (!avatar) throw new Error('Which character? The avatar file name is needed.');
        const response = await fetchImpl('/api/characters/merge-attributes', { method: 'POST', headers: { ...JSON_HEADERS, ...buildHeaders() }, body: JSON.stringify({ ...body, avatar }), cache: 'no-store' });
        if (!response.ok) {
            const detail = await response.json().catch(() => null);
            throw new Error(detail?.error ? `SillyTavern refused the card: ${detail.error}` : `/api/characters/merge-attributes: HTTP ${response.status}`);
        }
        await refreshStCharacterList();
        return true;
    }

    const unregisters = [
        bus.register('stCharacterCard.list', () => listCharacterEntries(), { loadMetric: () => 0 }),
        bus.register('stCharacterCard.load', params => loadCharacterCard(params), { loadMetric: () => 0 }),
        bus.register('stCharacterCard.create', params => createCharacterCard(params), { loadMetric: () => 0 }),
        bus.register('stCharacterCard.merge', params => mergeCharacterAttributes(params), { loadMetric: () => 0 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}
