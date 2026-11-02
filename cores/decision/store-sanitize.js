/** Защитное чтение записей хранилища — мусор на диске не должен ломать запуск. */
export function sanitizeRuns(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out = {};
    for (const [mesid, record] of Object.entries(value)) {
        if (!record || typeof record !== 'object') continue;
        if (!String(record.decision ?? '').trim()) continue;
        out[mesid] = { ...record, mesid: String(record.mesid ?? mesid) };
    }
    return out;
}

export function sanitizeCycles(value) {
    return (Array.isArray(value) ? value : []).filter(cycle => cycle && typeof cycle === 'object');
}
