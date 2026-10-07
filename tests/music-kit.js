/** Общие помощники тестов музыкального сервера: трек загружается В ПУЛ, а раздел и группа назначаются отдельным запросом. */

export async function uploadToPool(base, headers, { title = 'Track', ext = 'mp3', bytes = Buffer.from(title) } = {}) {
    return fetch(`${base}/api/admin/tracks?${new URLSearchParams({ title, ext })}`, { method: 'POST', headers, body: bytes });
}

export async function assign(base, headers, body) {
    return fetch(`${base}/api/admin/assignments`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

/** Загрузить в пул и сразу назначить; возвращает строку трека (`id` — трек, `assignment` — назначение) и `status` назначения. */
export async function addAssigned(base, headers, { section, group, title = 'Track', description, ext = 'mp3', bytes } = {}) {
    const up = await uploadToPool(base, headers, { title, ext, bytes });
    const track = await up.json();
    const res = await assign(base, headers, { track: track.id, section, group, description });
    return { ...track, ...(await res.json().catch(() => ({}))), id: track.id, status: res.status };
}
