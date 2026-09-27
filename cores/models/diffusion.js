import { createDispatchQueue } from '../../libraries/core/dispatch-queue.js';
import { createPersistedList } from '../../libraries/core/persisted-list.js';
import {
    buildImageRequest, resolveImageResponse, resolveImageRequest, resolveImageFormat, decodeBase64, readImageInfo,
    supportsReferences, referencePromptNote, REFERENCE_MODES,
} from '../../libraries/core/image-provider-request.js';
import { request } from '../../libraries/shared/request.js';

/**
 * Ядро diffusion — генерация изображений (CORES.md, «Модельные Ядра»). Та же форма, что у Ядра внутренних моделей: список «воркеров»
 * (бэкендов) с персистентностью, очередь с балансировкой по загрузке (`dispatch-queue.js`), цепочка запасных бэкендов, события жизненного
 * цикла. Отличие одно, но существенное: результат — не текст, а байты, и Ядро само кладёт их в Сервис хранилища картинок, отдавая
 * заказчику только `assetId` и настоящие размеры (прочитанные из байтов). Заказчику (Модулю) не нужен ни `fetch`, ни `Blob`, ни право на сеть.
 *
 * Контракты (Шина ядер):
 * - `image.generate({ prompt, negativePrompt?, width?, height?, steps?, cfgScale?, seed?, workerId?, fallbackWorkerIds?, timeoutMs?,
 *   references? })` → `{ assetId, mime, width, height, workerId, prompt, seed, requestId, referencesUsed }`;
 * - `image.workers.get` / `image.workers.set({ workers })` — `{ id, name, format, endpoint, apiKey, model, references }`.
 *
 * Референсы — `references: [{ url?, assetId?, label? }]`, до `MAX_REFERENCES`: адрес ТОГО ЖЕ сервера (аватар ST) или картинка из
 * хранилища. Ядро само уменьшает их до 1024px JPEG (`imageScale.toDataUrl`) и отдаёт только бэкенду, который их принимает
 * (`supportsReferences`); к промпту добавляется строка с именами (`label`), чтобы модель знала, кто на какой картинке.
 * `referencesUsed` в ответе — сколько реально ушло (0 — бэкенд их не понимает).
 *
 * События: `image.generate.started` / `.finished` / `.failed` / `.retrying` — `requestId` в каждом.
 */

const PERSISTENCE_NAMESPACE = 'core.models.diffusion';
/** Генерация картинки у медленного бэкенда — десятки секунд; дольше этого ответа ждать нет смысла. */
const DEFAULT_TIMEOUT_MS = 180000;
export const MAX_REFERENCES = 4;

let requestCounter = 0;

/** Защитное чтение одного бэкенда: без `id` — не бэкенд; формат — из известных; ключ и адрес — строки. */
export function sanitizeImageWorker(worker = {}) {
    const id = String(worker.id ?? '').trim();
    if (!id) return null;
    return {
        id,
        name: String(worker.name ?? id).trim() || id,
        format: resolveImageFormat(worker.format),
        endpoint: String(worker.endpoint ?? '').trim(),
        apiKey: String(worker.apiKey ?? '').trim(),
        model: String(worker.model ?? '').trim(),
        references: REFERENCE_MODES.includes(worker.references) ? worker.references : 'auto',
    };
}

export function createDiffusionCore(host, { publish, workerWaitMs = 3000, now = () => Date.now() } = {}) {
    const dispatchQueue = createDispatchQueue();
    let workers = [];
    const publishEvent = publish ?? ((event, payload) => host.events.emit(event, payload));

    const persisted = createPersistedList(host, {
        namespace: PERSISTENCE_NAMESPACE,
        key: 'workers',
        apply: list => { workers = (Array.isArray(list) ? list : []).map(sanitizeImageWorker).filter(Boolean); },
    });

    async function configureWorkers(list) {
        await persisted.save((Array.isArray(list) ? list : []).map(sanitizeImageWorker).filter(Boolean));
        publishEvent('image.workers.changed', { count: workers.length });
    }

    async function restoreWorkers() {
        const list = await persisted.restore();
        publishEvent('image.workers.changed', { count: workers.length });
        return list;
    }

    async function http(params, timeoutMs) {
        const result = await request(host.network, 'http.request', { params, timeoutMs });
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
    }

    /** Байты картинки у бэкенда: один запрос, у совместимых с OpenAI серверов, отдающих `url`, — второй за самой картинкой. */
    async function fetchImageBytes(worker, imageRequest, timeoutMs, referenceDataUrls) {
        const providerRequest = buildImageRequest(worker, imageRequest, { referenceDataUrls });
        const response = await http(providerRequest, timeoutMs);
        if (!response.ok) {
            const detail = String(response.text ?? '').slice(0, 200).trim();
            throw new Error(`Image backend "${worker.name}" replied with HTTP ${response.status}${detail ? `: ${detail}` : ''}.`);
        }
        const resolved = resolveImageResponse(worker.format, response);
        if (resolved.kind === 'base64') return decodeBase64(resolved.data);
        const blob = resolved.kind === 'blob' ? response.blob : (await http({ url: resolved.url, method: 'GET', responseType: 'blob' }, timeoutMs)).blob;
        if (!blob) throw new Error(`Image backend "${worker.name}" returned a link that could not be downloaded.`);
        return new Uint8Array(await blob.arrayBuffer());
    }

    /** Референсы → `data:` URL (уменьшенные). Пропадающий аватар не валит генерацию: такой референс просто выпадает. */
    async function prepareReferences(list) {
        const prepared = [];
        for (const reference of (Array.isArray(list) ? list : []).slice(0, MAX_REFERENCES)) {
            let blob = null;
            if (reference?.assetId) {
                const stored = await request(host.services, 'image.get', { params: { id: String(reference.assetId) } });
                blob = stored.ok ? stored.value : null;
                if (!blob) continue;
            } else if (!reference?.url) continue;
            const scaled = await request(host.services, 'imageScale.toDataUrl', { params: blob ? { blob } : { url: String(reference.url) } });
            if (scaled.ok && typeof scaled.value === 'string') prepared.push({ dataUrl: scaled.value, label: String(reference.label ?? '').trim() });
        }
        return prepared;
    }

    async function generateWith(worker, imageRequest, requestId, timeoutMs, references = []) {
        const usable = supportsReferences(worker) ? references : [];
        const note = referencePromptNote(usable.map(reference => reference.label));
        const sent = note ? { ...imageRequest, prompt: `${imageRequest.prompt}. ${note}` } : imageRequest;
        const bytes = await fetchImageBytes(worker, sent, timeoutMs, usable.map(reference => reference.dataUrl));
        const info = readImageInfo(bytes);
        if (!info.mime.startsWith('image/')) throw new Error(`Image backend "${worker.name}" returned data that is not an image.`);
        const assetId = `diffusion:${now()}-${requestId}`;
        const stored = await request(host.services, 'image.put', { params: { id: assetId, blob: new Blob([bytes], { type: info.mime }) } });
        if (!stored.ok) throw new Error(`The generated image could not be saved: ${stored.error.message}`);
        return {
            assetId, mime: info.mime,
            width: info.width || imageRequest.width, height: info.height || imageRequest.height,
            workerId: worker.id, prompt: imageRequest.prompt, seed: imageRequest.seed, requestId, referencesUsed: usable.length,
        };
    }

    function waitForWorkersOnce(timeoutMs) {
        return new Promise(resolve => {
            let timer = null;
            const finish = () => { clearTimeout(timer); unsubscribe(); resolve(); };
            const unsubscribe = host.events.subscribe('image.workers.changed', finish);
            timer = setTimeout(finish, timeoutMs);
        });
    }

    async function generate(params = {}) {
        requestCounter += 1;
        const requestId = params.requestId ?? `img-${requestCounter}`;
        const imageRequest = resolveImageRequest(params);
        if (!imageRequest.prompt) throw new Error('image.generate: "prompt" is required.');
        const poolOf = id => workers.filter(worker => worker.id === id);
        let primary = params.workerId ? poolOf(params.workerId) : workers;
        if (!primary.length) {
            // Сразу после загрузки страницы бэкенды могут ещё восстанавливаться с диска — та же короткая выдержка, что у текстовых моделей.
            await waitForWorkersOnce(workerWaitMs);
            primary = params.workerId ? poolOf(params.workerId) : workers;
        }
        if (!primary.length) throw new Error(params.workerId ? `No image backend with id "${params.workerId}".` : 'No image backends are configured.');
        const timeoutMs = Number.isFinite(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_TIMEOUT_MS;
        const tiers = [primary, ...(params.fallbackWorkerIds ?? []).map(poolOf).filter(pool => pool.length)].map(pool => ({ workers: pool, timeoutMs }));

        // Готовим референсы, только если хоть один бэкенд цепочки их примет: уменьшение и base64 — не бесплатны.
        const references = tiers.some(tier => tier.workers.some(supportsReferences)) ? await prepareReferences(params.references) : [];

        publishEvent('image.generate.started', { requestId, workerId: params.workerId ?? null, prompt: imageRequest.prompt, references: references.length });
        let lastWorkerId = null;
        try {
            const result = await dispatchQueue.enqueueWithFallback(tiers, worker => {
                lastWorkerId = worker.id;
                return generateWith(worker, imageRequest, requestId, timeoutMs, references);
            }, {
                onAttemptFailed: ({ tierIndex, error }) => publishEvent('image.generate.retrying', {
                    requestId, failedWorkerId: lastWorkerId, reason: error.message, nextWorkerId: tiers[tierIndex + 1]?.workers?.[0]?.id ?? null,
                }),
            });
            publishEvent('image.generate.finished', { requestId, workerId: result.workerId, assetId: result.assetId });
            return result;
        } catch (error) {
            publishEvent('image.generate.failed', { requestId, error: { message: error.message } });
            throw error;
        }
    }

    const unregisters = [
        host.own.register('image.generate', params => generate(params)),
        host.own.register('image.workers.get', () => workers),
        host.own.register('image.workers.set', params => configureWorkers(params?.workers ?? [])),
    ];

    return {
        configureWorkers,
        restoreWorkers,
        unregister: () => { for (const unregister of unregisters) unregister(); },
    };
}
