/**
 * Чистые подписи живого состояния на кругах столпов (DEBT «Живые состояния
 * кругов»): огни Court — какие роли работают и есть ли открытый вопрос God;
 * Bank — сколько персонажей; Canon — сколько миров сохранено; Charter — есть
 * ли подключение/модель; World — сколько Молитв в очереди. Центр — имя чата и
 * RP-время/место. Функция берёт уже готовые модели адаптеров и ничего не
 * читает сама.
 */

const text = value => String(value ?? '').trim();
const arr = value => (Array.isArray(value) ? value : []);

/**
 * `pillarStates({ court, bank, canon, charter, world })` → `{ [id]: { state, call } }`.
 * `call` — «здесь ждут ответа» (круг подсвечивается тёплым, как в макете).
 */
export function pillarStates({ court = null, bank = null, canon = null, charter = null, world = null } = {}) {
    const working = arr(court?.working);
    const godasks = arr(court?.roles).find(role => role.id === 'god')?.records?.filter(record => record.ask)?.length ?? 0;
    const courtState = godasks > 0 ? 'God awaits your answer'
        : working.length ? `${working.map(capitalise).join(', ')} working`
            : 'Everyone rests';

    const characters = arr(bank?.characters).length;
    const canons = arr(canon?.constellations).filter(item => !item.unsealed).length;
    const hasModel = arr(charter?.chapters).some(chapter => arr(chapter.articles).some(article => article.text.some(piece => typeof piece === 'object')));
    const prayers = arr(world?.prayersInQueue).length;

    return {
        court: { state: courtState, call: godasks > 0 },
        bank: { state: characters ? `${characters} ${characters === 1 ? 'life' : 'lives'} kept` : 'no lives yet', call: false },
        canon: { state: canons ? `${canons} ${canons === 1 ? 'world' : 'worlds'} sealed` : 'no world sealed', call: false },
        charter: { state: hasModel ? 'the law stands' : 'no model bound', call: !hasModel },
        world: { state: prayers ? `${prayers} ${prayers === 1 ? 'prayer' : 'prayers'} waiting` : 'the world is quiet', call: prayers > 0 },
    };
}

function capitalise(value) {
    const clean = text(value);
    return clean ? clean[0].toUpperCase() + clean.slice(1) : '';
}

/** Центр пятиугольника: имя чата и RP-время/место. */
export function hubText({ name = '', rpTime = '', place = '' } = {}) {
    const sub = [rpTime ? `Day · ${rpTime}` : '', text(place)].filter(Boolean).join(' · ');
    return { name: text(name), sub };
}
