const DEFAULT_MIME_TYPE = 'application/json';

/**
 * Сервис для файлового I/O — просто логический адаптер (ARCHITECTURE.md),
 * первый реальный потребитель — Ядро бэкапа (cores/backup/index.js), которое
 * говорит только в терминах JSON-снапшотов, ничего не зная о `<a download>`
 * или File/Blob. `document`/`createBlob`/`createObjectURL`/`revokeObjectURL`
 * инжектируются (как `document` в services/dom.js), чтобы тесты никогда не
 * трогали настоящий браузер.
 *
 * Намеренно НЕ включает "открыть диалог выбора файла" — та часть требует
 * реального пользовательского клика (`<input type=file>` + `change`), это
 * забота будущего Модуля с UI поверх Ядра бэкапа, не этого Сервиса. `file.readText`
 * здесь принимает уже полученный откуда-то File/Blob и просто читает его текст.
 */
export function registerFileService(bus, {
    document: doc = globalThis.document,
    createBlob = (parts, options) => new globalThis.Blob(parts, options),
    createObjectURL = blob => globalThis.URL.createObjectURL(blob),
    revokeObjectURL = url => globalThis.URL.revokeObjectURL(url),
} = {}) {
    function downloadFile({ filename, content, mimeType = DEFAULT_MIME_TYPE }) {
        const blob = createBlob([content], { type: mimeType });
        const url = createObjectURL(blob);
        const anchor = doc.createElement('a');
        anchor.setAttribute('href', url);
        anchor.setAttribute('download', filename);
        doc.body.append(anchor);
        anchor.click();
        anchor.remove();
        revokeObjectURL(url);
        return true;
    }

    const unregisters = [
        bus.register('file.download', downloadFile, { loadMetric: () => 0 }),
        bus.register('file.readText', ({ file }) => file.text(), { loadMetric: () => 0 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}
