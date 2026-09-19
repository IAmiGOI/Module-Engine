/**
 * Сервис прямого соединения между устройствами (WebRTC DataChannel). Единственное место, знающее про `RTCPeerConnection`. Логика
 * рукопожатия сознательно «без частичных кандидатов»: соединение собирает ВСЕ адреса (ICE) до конца и отдаёт одним сигналом — так
 * по каналу сигналов уходят два коротких сообщения (предложение и ответ), а не поток кандидатов.
 *
 *   создатель:  `open({ initiator: true, … })`  → `onSignal({ type: 'offer', sdp })`; затем `accept({ id, signal: answer })`;
 *   отвечающий: `open({ initiator: false, remote: offer, … })` → `onSignal({ type: 'answer', sdp })`.
 * Когда канал открыт — `onOpen()`, входящие кадры — `onFrame(string | ArrayBuffer)`, закрытие/сбой — `onClose(reason)`.
 * `send({ id, frame })` ждёт освобождения буфера канала (обратное давление) — так 200-мегабайтный файл не забивает память.
 *
 * Шифрование — штатное DTLS-WebRTC; подлинность собеседника обеспечивает Ядро: отпечатки DTLS едут внутри SDP, а SDP — внутри
 * конверта, зашифрованного общим секретом пары. Без секрета подменить их нельзя.
 * Стандартные STUN-серверы нужны для прохода через NAT; для «закрытых» сетей (мобильный оператор с симметричным NAT) можно указать
 * свой TURN в настройках.
 */

export const DEFAULT_ICE_SERVERS = Object.freeze([{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }]);
const GATHER_TIMEOUT_MS = 4000;
const BUFFER_HIGH = 1024 * 1024;
const BUFFER_LOW = 256 * 1024;
const CHANNEL_LABEL = 'stme-sync';

export function registerSyncPeerService(networkBus, {
    RTCPeerConnectionCtor = globalThis.RTCPeerConnection,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = handle => clearTimeout(handle),
    gatherTimeoutMs = GATHER_TIMEOUT_MS,
} = {}) {
    const peers = new Map();
    let nextId = 1;

    function waitForGathering(connection) {
        return new Promise(resolve => {
            if (connection.iceGatheringState === 'complete') { resolve(); return; }
            const timer = setTimer(done, gatherTimeoutMs);
            function done() { clearTimer(timer); connection.removeEventListener?.('icegatheringstatechange', onChange); resolve(); }
            function onChange() { if (connection.iceGatheringState === 'complete') done(); }
            connection.addEventListener('icegatheringstatechange', onChange);
        });
    }

    function wireChannel(entry, channel, { onOpen, onFrame }) {
        entry.channel = channel;
        channel.binaryType = 'arraybuffer';
        channel.bufferedAmountLowThreshold = BUFFER_LOW;
        channel.onopen = () => onOpen?.();
        channel.onmessage = event => onFrame?.(event.data);
        channel.onclose = () => entry.notifyClose('channel closed');
        channel.onerror = () => entry.notifyClose('channel error');
    }

    async function open({ initiator, remote, iceServers = DEFAULT_ICE_SERVERS, onSignal, onOpen, onFrame, onClose } = {}) {
        if (!RTCPeerConnectionCtor) throw new Error('WebRTC is not available in this browser.');
        const id = nextId; nextId += 1;
        const connection = new RTCPeerConnectionCtor({ iceServers });
        let closedNotified = false;
        const entry = {
            connection, channel: null,
            notifyClose(reason) { if (closedNotified) return; closedNotified = true; onClose?.(reason); },
        };
        peers.set(id, entry);
        connection.onconnectionstatechange = () => {
            if (['failed', 'closed', 'disconnected'].includes(connection.connectionState)) entry.notifyClose(`connection ${connection.connectionState}`);
        };

        try {
            if (initiator) {
                wireChannel(entry, connection.createDataChannel(CHANNEL_LABEL, { ordered: true }), { onOpen, onFrame });
                await connection.setLocalDescription(await connection.createOffer());
            } else {
                connection.ondatachannel = event => wireChannel(entry, event.channel, { onOpen, onFrame });
                await connection.setRemoteDescription(remote);
                await connection.setLocalDescription(await connection.createAnswer());
            }
            await waitForGathering(connection);
            const description = connection.localDescription;
            onSignal?.({ type: description.type, sdp: description.sdp });
        } catch (error) {
            close({ id });
            throw error;
        }
        return { id };
    }

    async function accept({ id, signal } = {}) {
        const entry = peers.get(id);
        if (!entry) throw new Error('syncPeer.accept: unknown peer.');
        await entry.connection.setRemoteDescription(signal);
        return true;
    }

    async function send({ id, frame } = {}) {
        const entry = peers.get(id);
        const channel = entry?.channel;
        if (!channel || channel.readyState !== 'open') throw new Error('syncPeer.send: the channel is not open.');
        if (channel.bufferedAmount > BUFFER_HIGH) {
            await new Promise((resolve, reject) => {
                const done = () => { channel.removeEventListener?.('bufferedamountlow', onLow); channel.removeEventListener?.('close', onClosed); };
                const onLow = () => { done(); resolve(); };
                const onClosed = () => { done(); reject(new Error('syncPeer.send: the channel closed while waiting.')); };
                channel.addEventListener('bufferedamountlow', onLow);
                channel.addEventListener('close', onClosed);
            });
        }
        channel.send(frame);
        return true;
    }

    function close({ id } = {}) {
        const entry = peers.get(id);
        if (!entry) return false;
        peers.delete(id);
        try { entry.channel?.close(); } catch { /* уже закрыт */ }
        try { entry.connection.close(); } catch { /* уже закрыт */ }
        entry.notifyClose('closed');
        return true;
    }

    const unregisters = [
        networkBus.register('syncPeer.open', params => open(params), { loadMetric: () => 0 }),
        networkBus.register('syncPeer.accept', params => accept(params), { loadMetric: () => 0 }),
        networkBus.register('syncPeer.send', params => send(params), { loadMetric: () => 0 }),
        networkBus.register('syncPeer.close', params => close(params), { loadMetric: () => 0 }),
    ];
    return () => { for (const id of [...peers.keys()]) close({ id }); for (const unregister of unregisters) unregister(); };
}
