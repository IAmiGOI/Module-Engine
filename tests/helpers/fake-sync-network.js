/**
 * Сетевые фейки для проверки Ядра синхронизации на нескольких «устройствах» в одном процессе: общая доска сигналов и общий
 * «WebRTC», через которые устройства находят друг друга и обмениваются кадрами. Доставка асинхронная (как в жизни), но без сети.
 */

const later = fn => setImmediate(fn);

/** Ждём, пока всё, что можно доставить, доставлено (несколько «тиков» — цепочки сообщений короткие). */
export async function settle(rounds = 40) {
    for (let index = 0; index < rounds; index += 1) await new Promise(resolve => setImmediate(resolve));
}

export function createFakeNetwork() {
    const topics = new Map();      // topic -> { history: [lines], subscribers: Map<id, handler> }
    const posted = [];
    let nextSubscription = 1;
    let nextPeer = 1;
    const peers = new Map();       // id -> { onOpen, onFrame, onClose, peer, open }
    const opens = [];              // с какими серверами соединения открывались каналы

    const topic = name => { if (!topics.has(name)) topics.set(name, { history: [], subscribers: new Map() }); return topics.get(name); };

    function registerOn(networkBus, { label = 'device' } = {}) {
        networkBus.register('syncSignal.publish', ({ topic: name, lines }) => {
            const room = topic(name);
            for (const line of lines) {
                posted.push({ label, topic: name, line });
                room.history.push(line);
                for (const handler of room.subscribers.values()) later(() => handler(line));
            }
            return true;
        });
        networkBus.register('syncSignal.subscribe', ({ topic: name, handler }) => {
            const id = nextSubscription; nextSubscription += 1;
            const room = topic(name);
            room.subscribers.set(id, handler);
            for (const line of room.history) later(() => handler(line));   // как ntfy `since`: доска помнит недавнее
            return { id, name };
        });
        networkBus.register('syncSignal.unsubscribe', ({ id }) => {
            for (const room of topics.values()) if (room.subscribers.delete(id)) return true;
            return false;
        });

        networkBus.register('syncPeer.open', ({ initiator, remote, onSignal, onOpen, onFrame, onClose, iceServers }) => {
            const id = nextPeer; nextPeer += 1;
            opens.push({ initiator, iceServers });
            const entry = { id, onOpen, onFrame, onClose, peer: null, open: false, label };
            peers.set(id, entry);
            if (initiator) {
                later(() => onSignal({ type: 'offer', sdp: `offer:${id}` }));
            } else {
                const initiatorEntry = peers.get(Number(String(remote.sdp).split(':')[1]));
                entry.peer = initiatorEntry;
                initiatorEntry.peer = entry;
                later(() => onSignal({ type: 'answer', sdp: `answer:${id}` }));
            }
            return { id };
        });
        networkBus.register('syncPeer.accept', ({ id }) => {
            const entry = peers.get(id);
            later(() => {
                if (!entry?.peer || entry.open) return;
                for (const side of [entry, entry.peer]) { side.open = true; side.onOpen?.(); }
            });
            return true;
        });
        networkBus.register('syncPeer.send', async ({ id, frame }) => {
            const entry = peers.get(id);
            if (!entry?.open || !entry.peer?.open) throw new Error('the channel is not open');
            const copy = typeof frame === 'string' ? frame : new Uint8Array(frame).slice();
            later(() => entry.peer?.onFrame?.(copy));
            return true;
        });
        networkBus.register('syncPeer.close', ({ id }) => {
            const entry = peers.get(id);
            if (!entry) return false;
            peers.delete(id);
            later(() => { entry.onClose?.('closed'); const other = entry.peer; if (other) { other.open = false; other.onClose?.('peer closed'); } });
            return true;
        });
    }

    /** Обрыв всех соединений (пропала сеть): обе стороны узнают о закрытии. */
    function dropAll(reason = 'dropped') {
        for (const entry of [...peers.values()]) { entry.open = false; later(() => entry.onClose?.(reason)); }
        peers.clear();
    }

    return { registerOn, dropAll, posted, topics, peers, opens };
}

/** Часы и таймеры, которыми управляет тест. */
export function createFakeClock(start = 1_800_000_000_000) {
    let time = start;
    let counter = 0;
    const timeouts = new Map();
    const intervals = new Map();
    return {
        now: () => time,
        setTimer: (fn, ms) => { counter += 1; timeouts.set(counter, { fn, at: time + ms }); return counter; },
        clearTimer: handle => { timeouts.delete(handle); },
        setRepeating: (fn, ms) => { counter += 1; intervals.set(counter, { fn, every: ms, next: time + ms }); return counter; },
        clearRepeating: handle => { intervals.delete(handle); },
        /** Продвинуть время и выстрелить всё, что должно сработать. */
        async advance(ms) {
            const target = time + ms;
            while (true) {
                const due = [
                    ...[...timeouts.entries()].map(([id, item]) => ({ id, kind: 'timeout', at: item.at })),
                    ...[...intervals.entries()].map(([id, item]) => ({ id, kind: 'interval', at: item.next })),
                ].filter(item => item.at <= target).sort((a, b) => a.at - b.at)[0];
                if (!due) break;
                time = Math.max(time, due.at);
                if (due.kind === 'timeout') { const item = timeouts.get(due.id); timeouts.delete(due.id); item.fn(); } else { const item = intervals.get(due.id); item.next += item.every; item.fn(); }
                await settle(5);
            }
            time = target;
            await settle();
        },
        pending: () => ({ timeouts: timeouts.size, intervals: intervals.size }),
    };
}
