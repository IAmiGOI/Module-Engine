/**
 * Репозиторий, из которого движок обновляет сам себя. Захардкожен намеренно, а
 * не берётся из `remoteUrl`, который отдаёт ST: тот — правда о том, что
 * настроено у git локально, а нам нужна правда о том, откуда проект ДОЛЖЕН
 * приезжать. Сбитый локальный remote не должен превращать сверку в проверку
 * самого себя.
 */
export const CORE_REPO = Object.freeze({ owner: 'IAmiGOI', repo: 'Module-Engine' });
/** Музыкальный сервер владельца (tools/music-server): адрес и ключ чтения. Пустой адрес — функция выключена, в Music ничего не появляется. */
export const MUSIC_SERVER = { url: 'https://45-38-19-165.sslip.io:24817', key: '63F3JcY2lDtXIroj' };

/** Репозиторий с фонами: любой файл-картинка/видео, положенный туда, сам появляется в списке фонов ST (cores/backgrounds). */
export const BACKGROUNDS_REPO = Object.freeze({ owner: 'IAmiGOI', repo: 'Module-Engine-Backgrounds' });
