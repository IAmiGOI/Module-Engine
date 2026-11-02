import * as germany from './decision-names-data/germany.js';
import * as poland from './decision-names-data/poland.js';
import * as czech from './decision-names-data/czech.js';
import * as latvia from './decision-names-data/latvia.js';
import * as china from './decision-names-data/china.js';
import * as japan from './decision-names-data/japan.js';

/**
 * Библиотека имён: пол, культура (Германия, Польша, Чехия, Латвия, Китай,
 * Япония) и сеттинг (современный/вымышленный). Современные списки — реальные
 * имена; вымышленные собираются из слогов в духе культуры. Не меньше 80 имён
 * на пол, культуру и сеттинг; выданное имя помечается в этом чате и больше не
 * повторяется.
 */

export const GENDERS = Object.freeze(['male', 'female']);
export const CULTURES = Object.freeze(['germany', 'poland', 'czech', 'latvia', 'china', 'japan']);
export const SETTINGS = Object.freeze(['modern', 'fictional']);

const MODERN = { germany, poland, czech, latvia, china, japan };

const FICTIONAL_POOLS = {
    germany: {
        male: { start: ['Ald', 'Bald', 'Bert', 'Diet', 'Eber', 'Falk', 'Gund', 'Hart', 'Helm', 'Kon', 'Luit', 'Nord', 'Ot', 'Rein', 'Sig', 'Thor', 'Ul', 'Wald', 'Wil', 'Wolf'], end: ['ric', 'win', 'mund', 'bert', 'mar', 'hard', 'wald', 'helm', 'gar', 'ulf'] },
        female: { start: ['Adel', 'Bru', 'Dag', 'Elf', 'Ger', 'Hild', 'Irme', 'Kun', 'Lieb', 'Mar', 'Noth', 'Oda', 'Rag', 'Sig', 'Swan', 'Trau', 'Ute', 'Walt', 'Zel', 'Brun'], end: ['hild', 'gard', 'lind', 'run', 'dis', 'traut', 'burg', 'heit', 'flied', 'mara'] },
    },
    poland: {
        male: { start: ['Bog', 'Dobro', 'Jar', 'Kaz', 'Mie', 'Rado', 'Stani', 'Wła', 'Zby', 'Ży'], end: ['sław', 'mir', 'bor', 'gost', 'rad', 'wit', 'gniew', 'pełk', 'ciesz', 'mysł'] },
        female: { start: ['Bog', 'Dobro', 'Jar', 'Kaz', 'Mie', 'Rado', 'Stani', 'Wła', 'Zby', 'Ży'], end: ['sława', 'mira', 'borga', 'gosta', 'rada', 'wita', 'gniewa', 'pełka', 'ciesza', 'mysła'] },
    },
    czech: {
        male: { start: ['Bohu', 'Bole', 'Jaro', 'Kazi', 'Lubo', 'Milo', 'Rado', 'Stani', 'Vrati', 'Zby'], end: ['slav', 'mil', 'bor', 'mysl', 'host', 'rad', 'vit', 'něk', 'boj', 'těch'] },
        female: { start: ['Bohu', 'Bole', 'Jaro', 'Kazi', 'Lubo', 'Milo', 'Rado', 'Stani', 'Vrati', 'Zby'], end: ['slava', 'mila', 'bora', 'mysla', 'hosta', 'rada', 'vita', 'něka', 'boja', 'těcha'] },
    },
    latvia: {
        male: { start: ['Aiz', 'Bie', 'Dai', 'Gai', 'Jau', 'Kru', 'Lau', 'Mie', 'Prie', 'Sau'], end: ['vars', 'dris', 'gurs', 'nītis', 'kals', 'zars', 'laps', 'vils', 'rijs', 'dons'] },
        female: { start: ['Aiz', 'Bie', 'Dai', 'Gai', 'Jau', 'Kru', 'Lau', 'Mie', 'Prie', 'Sau'], end: ['vara', 'drīte', 'gure', 'nīte', 'kale', 'zare', 'lape', 'vile', 'rija', 'done'] },
    },
    china: {
        male: { start: ['Xian', 'Yun', 'Jian', 'Lian', 'Ming', 'Qing', 'Tian', 'Wei', 'Zhi', 'Hao'], end: ['long', 'feng', 'shan', 'hai', 'chen', 'yu', 'bo', 'tao', 'lei', 'jun'] },
        female: { start: ['Xian', 'Yun', 'Jian', 'Lian', 'Ming', 'Qing', 'Tian', 'Wei', 'Zhi', 'Hao'], end: ['mei', 'lan', 'ying', 'xue', 'hua', 'yue', 'lin', 'jing', 'fang', 'yun'] },
    },
    japan: {
        male: { start: ['Haru', 'Kaze', 'Kiri', 'Mori', 'Natsu', 'Sora', 'Taka', 'Yama', 'Yuki', 'Hoshi'], end: ['to', 'ki', 'ro', 'ma', 'ya', 'shi', 'nari', 'hiko', 'taka', 'mura'] },
        female: { start: ['Haru', 'Kaze', 'Kiri', 'Mori', 'Natsu', 'Sora', 'Taka', 'Yama', 'Yuki', 'Hoshi'], end: ['ko', 'mi', 'na', 'yo', 'ka', 'ri', 'e', 'no', 'ha', 'saki'] },
    },
};

const SURNAME_SUFFIX = {
    germany: ['berg', 'burg', 'dorf', 'feld', 'gart', 'hain', 'hof', 'stein', 'tal', 'wald'],
    poland: ['ski', 'ska', 'wicz', 'czyk', 'owski', 'owska', 'ak', 'ek', 'icz', 'yn'],
    czech: ['ák', 'ová', 'ský', 'ská', 'ek', 'ec', 'ík', 'ice', 'ín', 'ov'],
    latvia: ['iņš', 'iņa', 'nieks', 'niece', 'kalns', 'zars', 'daris', 'sils', 'lītis', 'purs'],
    china: ['Wang', 'Li', 'Zhang', 'Chen', 'Yang', 'Huang', 'Zhao', 'Wu', 'Zhou', 'Xu'],
    japan: ['Sato', 'Suzuki', 'Takahashi', 'Tanaka', 'Watanabe', 'Ito', 'Yamamoto', 'Nakamura', 'Kobayashi', 'Kato'],
};

function unique(list) {
    return [...new Set(list.filter(Boolean))];
}

function buildFictional() {
    const out = {};
    for (const culture of CULTURES) {
        out[culture] = { male: [], female: [], surnames: [] };
        for (const gender of GENDERS) {
            const pool = FICTIONAL_POOLS[culture][gender];
            for (const start of pool.start) for (const end of pool.end) out[culture][gender].push(`${start}${end}`);
            out[culture][gender] = unique(out[culture][gender]);
        }
        const surnamePool = FICTIONAL_POOLS[culture].male.start;
        const endings = SURNAME_SUFFIX[culture];
        for (const start of surnamePool) for (const end of endings) out[culture].surnames.push(`${start}${end}`);
        out[culture].surnames = unique(out[culture].surnames);
    }
    return out;
}

export const FICTIONAL = Object.freeze(buildFictional());

function dataFor(culture, setting) {
    if (!CULTURES.includes(culture)) return null;
    if (setting === 'modern') return { male: unique(MODERN[culture].male), female: unique(MODERN[culture].female), surnames: unique(MODERN[culture].surnames) };
    if (setting === 'fictional') return FICTIONAL[culture];
    return null;
}

/** Полный список пары «имя + фамилия» для пола/культуры/сеттинга. */
export function listNames({ gender, culture, setting } = {}) {
    if (!GENDERS.includes(gender)) return [];
    const data = dataFor(culture, setting);
    if (!data) return [];
    const first = data[gender] ?? [];
    const surnames = data.surnames ?? [];
    return first.map((name, index) => ({
        name,
        surname: surnames[index % Math.max(1, surnames.length)] ?? '',
        order: culture === 'china' || culture === 'japan' ? 'surname-first' : 'given-first',
    }));
}

export function formatFullName({ name, surname, order } = {}) {
    if (!surname) return name;
    return order === 'surname-first' ? `${surname} ${name}` : `${name} ${surname}`;
}

export function nameKey({ culture, setting, gender, name, surname } = {}) {
    return `${culture}|${setting}|${gender}|${name}|${surname ?? ''}`;
}

/**
 * Выдать невыданное имя. `issued` — массив ключей; `rng` — для тестов.
 * Кончились имена — честный отказ, без повтора.
 */
export function issueName({ issued = [], gender, culture, setting, rng = Math.random } = {}) {
    const all = listNames({ gender, culture, setting });
    if (!all.length) return { ok: false, error: `I have no ${setting} ${gender} names for ${culture}.` };
    const used = new Set(Array.isArray(issued) ? issued : []);
    const free = all.filter(item => !used.has(nameKey({ culture, setting, gender, ...item })));
    if (!free.length) return { ok: false, error: `No unused ${setting} ${gender} names for ${culture} are left in this chat.` };
    const pick = free[Math.min(free.length - 1, Math.floor(Number(rng()) * free.length))];
    const key = nameKey({ culture, setting, gender, ...pick });
    return { ok: true, ...pick, full: formatFullName(pick), key, remaining: free.length - 1 };
}
