import { signal } from '../../cores/ui/reactive.js';
import { request } from '../../libraries/shared/request.js';

/**
 * Раздел музыкального сервера владельца для Music. Пользователь выбирает ТОЛЬКО раздел; треки раздела (вектор + ссылка на аудио, без имён и тегов) лежат в памяти,
 * не сохраняются и в карточке не показываются — подбор по сцене берёт их наравне со своими. Сеть — через Ядро `musicServer.*`; сбой молчит (Music играет своё).
 */
export function createServerSection(host) {
    const sections = signal([]);       // [{ id, name, tracks }] — что предложить в выборе
    const configured = signal(false);  // есть ли сервер вообще: нет — в карточке ничего не появляется
    const selected = signal('');       // id выбранного раздела или ''
    const tracks = signal([]);         // треки выбранного раздела (в форме подбора)
    const sectionName = signal('');    // как называть играющее: имени трека у пользователя нет, только раздел

    const ask = (contract, params) => request(host.cores, contract, { params });

    async function loadTracks({ force = false } = {}) {
        if (!selected.peek()) { tracks.set([]); sectionName.set(''); return; }
        const id = selected.peek();
        const result = await ask('musicServer.section', { id, force });
        if (selected.peek() !== id) return;   // пока ждали, выбрали другой — старый ответ не нужен
        const ok = result.ok && result.value?.ok;
        tracks.set(ok ? result.value.tracks : []);
        sectionName.set(ok ? result.value.name : '');
    }

    /** Список разделов с сервера. Выбранный, которого на сервере больше нет, сбрасывается. */
    async function refresh({ force = false } = {}) {
        const result = await ask('musicServer.sections', { force });
        const value = result.ok ? result.value : null;
        configured.set(Boolean(value?.configured));
        if (!value?.ok) return;
        sections.set(value.sections);
        if (selected.peek() && !value.sections.some(item => item.id === selected.peek())) selected.set('');
        await loadTracks({ force });
    }

    async function select(id) {
        selected.set(String(id ?? ''));
        await loadTracks();
    }

    return { sections, configured, selected, tracks, sectionName, refresh, select };
}
