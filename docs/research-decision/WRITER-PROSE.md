# Писатель — промптинг прозы (черновик)

Черновик, в код не перенесён. Основан на ходах стенда ME-sim (Писатель — `moonshotai/kimi-k2.6`) и на действующих `WRITER_SYSTEM` / `WRITER_INSCRIPTION` / `turn-modes.js` ветки Dev-Version.

Правила дома соблюдены: тексты по-английски, без примеров из сцен, без запретных списков слов, положительная формулировка, у правила — имя.

## Что лечим (наблюдения со стенда)

| Что на странице | Откуда берётся |
|---|---|
| «с интонацией человека, который годами…» — рассказчик знает биографию и намерения | рассказчику не сказано, кто он и что ему известно |
| сравнение в каждом абзаце, «something in her…», «neither X nor Y — merely Z» | единственная строка о стиле зовёт добавлять детали; ограничивающей нет |
| одна и та же обстановка каждый ход (мониторы, руки у пояса, красные ногти) | FRESH WRITING требует «новую деталь», а не «без детали» |
| 250–350 слов на три бита | `replyLength` задан как размер, а не как потолок |
| «slow, sensory narration», «give it room on the page» | строки режимов Bard и Elder описывают тон прилагательными |

## Куда что кладём

| Слой | Где стоит | Что в нём |
|---|---|---|
| **THE PAGE** | system, кешируется | постоянные правила прозы — новый раздел |
| STORY SETTINGS | сразу после system | выбор регистра и потолок длины — правка трёх строк |
| HOW THIS TURN READS | внутри Начертания | регистр этого хода — правка восьми строк режимов |
| Хвост после Начертания | у самого ответа | только то, что относится к форме Начертания; стиль отсюда уходит |

Хвост становится короче: FRESH WRITING и ACTIONS THAT CONTINUE переезжают в system.

## 1. WRITER_SYSTEM — правки

Первая строка, конец предложения: вместо `vivid, natural prose in the voice of the characters` —

```text
written as THE PAGE below describes, in the voice of the characters.
```

Из FOLLOW THE INSCRIPTION убрать три строки (их заменяет THE PAGE):
- `Never reuse sentences, gestures or phrasings from your earlier replies…`
- `You may add what makes prose alive…`
- `Do not explain a line, a gesture or a silence. Show it and move on.`

Новый раздел — между FOLLOW THE INSCRIPTION и THE USER:

```text
THE PAGE
- **The Narrator Is A Witness** — narration holds what someone standing in the scene beside the user's character takes in through the senses: what is seen and heard, what is smelled and touched, how warm or cold it is. The narrator knows nobody's past, trade, habits or intentions, and does not say what a look, a pause or a tone means. Who a person is reaches the page through what they do and say now.
- **The Thing Itself** — name what is there by its plain word: the object, the movement, the sound. A comparison belongs only where the plain word cannot carry what is seen; most replies have none. An image inside the Inscription is the Resolver's shorthand: put on the page what a witness would see of it.
- **Feeling Shows In The Body** — feeling reaches the page as what the body does and what the voice does to the words, in the manner VOICES gives for that person. The narration does not name the feeling and does not say that something lies beneath it.
- **Speech Carries It** — when people talk, their lines are the reply. Each line sounds like this person speaking aloud: their words, their length of breath, their way of leaving things out. How a line sounds is in its words and its punctuation; narration adds to a line only what the body does with it.
- **Seen Once** — what the story has already shown — the room, a face, clothes, hair, eyes, a way of standing — the reader knows. It returns to the page only when this turn changes it or someone uses it. A reply needs no description of the place to begin and none to end. A gesture that answers what the user's character just did is always new.
- **Breadth, Not Depth** — an action that carries over from earlier turns has already been shown. It comes back as what it has led to: how far it has carried them, what has changed around them, how the people and the place nearby answer it. If nothing new has come of it, a few words name it.
- **The Beats Set The Length** — each beat takes the sentences it needs to be seen clearly, and nothing is added between beats to fill the reply. A turn of two beats is a short reply. The length in STORY SETTINGS is the most a reply may run to, never a size to reach.
```

## 2. STORY SETTINGS — три строки писателя (§22)

**10. replyLength** — потолок вместо размера:

```text
short: A reply runs to a few sentences at most.
medium: A reply runs to three paragraphs at most.
long: A reply may run long when the turn has that much in it.
```

**12. prose** — регистр внутри THE PAGE, а не разрешение на орнамент:

```text
plain: Short, direct sentences; description only of what the action touches.
vivid: Where a beat happens, one exact sensory fact — a sound, a texture, a temperature — that the action touches.
literary: Longer sentences with rhythm; the exact word over the common one, and the plain word over the ornate one.
```

## 3. Режимы хода — поле `writer` (`turn-modes.js`)

Строка режима говорит, из чего сделана страница этого хода, а не каким тоном её писать.

```text
peasant: An everyday moment: a short reply of plain sentences and quick exchanges.
elder: A moment that turns on who these people are: each line and each stillness is that person's own, and nothing is added to make the moment heavier.
merchant: A deal: the terms, sums and conditions are written as the characters say them; the narration stays with what changes hands.
king: Politics: who holds what shows only in what is said, offered and withheld; the narration reports the room and takes no side.
warrior: Danger: short sentences in the order things happen — who moves, what hits, what gives way; nothing is thought over in the middle of it.
hunter: A search or stealth: the narration stays on the traces — what is found, heard or out of place — as the user's character comes upon them.
artist: A moment to be shown: the place gets its description now — what the eye meets first, then what holds it — in things with names, sizes and colours.
bard: A close, quiet moment: it is carried by small physical things between them — distance, hands, what is done with an object — and by few words.
```

Artist — единственный режим, где описание места уместно всегда: место новое, правило Seen Once его не касается.

## 4. WRITER_INSCRIPTION — хвост после Начертания

Остаётся только то, что объясняет форму Начертания:

```text
INSCRIPTION — what happens this turn:
{{inscription}}

HOW TO WRITE THE BEATS: a LINE beat is dialogue. It gives the meaning of the words; write the words themselves in quotes, in the character's own voice. When it also says how the words come out — broken off, tangled, dodging, spilling — write them coming out that way. The other beats are action: show them.
Write it as a scene. Between the lines, narration shows only what bodies do and what the place is like — never what anyone says, asks, answers, admits or promises, and never that they are about to speak or how plainly.

THE LAST SENTENCE: the reply ends on the END beat itself — a line or a gesture — and nothing follows it. Never write the word END.
```

Ушло из хвоста:
- FRESH WRITING — заменено правилом Seen Once в system;
- ACTIONS THAT CONTINUE — стало правилом Breadth, Not Depth в system;
- фразы «Earlier replies in this story did that… do not copy them» — заплатки под старую историю чата.

## Чего этот промпт не исправит

- **Образы в битах Резолвера.** Бит приходит уже с метафорой («the smile doing less work than usual»), и Писатель её пересказывает. Правило The Thing Itself это смягчает, но источник — Резолвер.
- **Три вопроса в конце хода.** Они приходят из LINE-битов, это решение Резолвера.
- **Смена лица (he / you).** В чате Эмили Писатель писал от третьего лица. Сначала проверить, какая строка `pov` реально ушла в запрос.
- **Самоподражание.** В запросе Писателя около 10 тыс. токенов, большая часть — его же прошлые ответы. В старом чате манера будет тянуться за историей; проверять на новом.

## Как проверить дёшево

Стенд хранит принятую форму каждого хода (`runs/<прогон>/turns/*.json`). Достаточно переиграть одного Писателя по сохранённым Начертаниям: три вызова Kimi на прогон, остальные роли не трогаются. Сравнивать глазами старый ответ с новым на тех же битах.
