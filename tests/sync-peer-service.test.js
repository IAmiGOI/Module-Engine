import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeBuses } from '../libraries/shared/fake-buses.js';
import { registerSyncPeerService } from '../services/sync-peer.js';
import { request } from '../libraries/shared/request.js';

/** Пара «соединений» в памяти: предложение/ответ применяются друг к другу, а открытый канал соединяет два конца. */
function createFakeRtc() {
    const pending = [];
    class FakeChannel {
        constructor() { this.readyState = 'connecting'; this.bufferedAmount = 0; this.listeners = {}; this.sent = []; }
        addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
        removeEventListener(name, fn) { this.listeners[name] = (this.listeners[name] ?? []).filter(item => item !== fn); }
        emit(name) { for (const fn of this.listeners[name] ?? []) fn(); }
        send(frame) { this.sent.push(frame); this.peer?.onmessage?.({ data: frame }); }
        close() { this.readyState = 'closed'; this.onclose?.(); this.emit('close'); }
    }
    class FakeConnection {
        constructor(config) { this.config = config; this.iceGatheringState = 'complete'; this.connectionState = 'new'; this.listeners = {}; pending.push(this); }
        addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
        removeEventListener() {}
        createDataChannel(label) { this.channel = new FakeChannel(); this.channel.label = label; return this.channel; }
        async createOffer() { return { type: 'offer', sdp: 'OFFER-SDP' }; }
        async createAnswer() { return { type: 'answer', sdp: 'ANSWER-SDP' }; }
        async setLocalDescription(description) { this.localDescription = description; }
        async setRemoteDescription(description) {
            this.remoteDescription = description;
            if (description.type === 'answer') { // offerer: the channel opens
                const other = pending.find(connection => connection !== this && connection.localDescription?.type === 'answer');
                const answererChannel = new FakeChannel();
                answererChannel.readyState = 'open';
                other.ondatachannel?.({ channel: answererChannel });
                this.channel.readyState = 'open';
                this.channel.peer = answererChannel;
                answererChannel.peer = this.channel;
                this.channel.onopen?.();
                answererChannel.onopen?.();
            }
        }
        close() { this.connectionState = 'closed'; this.onconnectionstatechange?.(); }
    }
    return { FakeConnection, pending };
}

function setup() {
    const rtc = createFakeRtc();
    const buses = createFakeBuses();
    registerSyncPeerService(buses.network, { RTCPeerConnectionCtor: rtc.FakeConnection, gatherTimeoutMs: 10 });
    const call = (contract, params) => request(buses.network, contract, { params }).then(result => { if (!result.ok) throw new Error(result.error.message); return result.value; });
    return { call, rtc };
}

test('the handshake: offer out, answer back, channel opens on both ends and frames flow both ways', async () => {
    const { call } = setup();
    const events = [];
    const offerSignals = [];
    const answerSignals = [];
    const a = await call('syncPeer.open', { initiator: true, onSignal: signal => offerSignals.push(signal), onOpen: () => events.push('a-open'), onFrame: frame => events.push(`a-got:${frame}`) });
    assert.deepEqual(offerSignals, [{ type: 'offer', sdp: 'OFFER-SDP' }]);
    const b = await call('syncPeer.open', { initiator: false, remote: offerSignals[0], onSignal: signal => answerSignals.push(signal), onOpen: () => events.push('b-open'), onFrame: frame => events.push(`b-got:${frame}`) });
    assert.deepEqual(answerSignals, [{ type: 'answer', sdp: 'ANSWER-SDP' }]);
    await call('syncPeer.accept', { id: a.id, signal: answerSignals[0] });
    assert.deepEqual(events.sort(), ['a-open', 'b-open']);
    await call('syncPeer.send', { id: a.id, frame: 'ping' });
    await call('syncPeer.send', { id: b.id, frame: 'pong' });
    assert.deepEqual(events.slice(2).sort(), ['a-got:pong', 'b-got:ping']);
});

test('the connection is built with STUN servers by default and with custom ones when given', async () => {
    const { call, rtc } = setup();
    await call('syncPeer.open', { initiator: true });
    assert.match(rtc.pending[0].config.iceServers[0].urls, /^stun:/);
    await call('syncPeer.open', { initiator: true, iceServers: [{ urls: 'turn:my.turn:3478', username: 'u', credential: 'c' }] });
    assert.equal(rtc.pending[1].config.iceServers[0].username, 'u');
});

test('sending on a channel that is not open is an error, closing tells the Core once', async () => {
    const { call } = setup();
    const closes = [];
    const a = await call('syncPeer.open', { initiator: true, onClose: reason => closes.push(reason) });
    await assert.rejects(call('syncPeer.send', { id: a.id, frame: 'x' }), /not open/);
    assert.equal(await call('syncPeer.close', { id: a.id }), true);
    assert.equal(closes.length, 1);
    assert.equal(await call('syncPeer.close', { id: a.id }), false);
    await assert.rejects(call('syncPeer.accept', { id: a.id, signal: {} }), /unknown peer/);
});

test('a full outgoing buffer pauses the sender until the channel drains', async () => {
    const { call, rtc } = setup();
    const offers = [];
    const answers = [];
    const a = await call('syncPeer.open', { initiator: true, onSignal: signal => offers.push(signal) });
    await call('syncPeer.open', { initiator: false, remote: offers[0], onSignal: signal => answers.push(signal) });
    await call('syncPeer.accept', { id: a.id, signal: answers[0] });
    const channel = rtc.pending[0].channel;
    channel.bufferedAmount = 5 * 1024 * 1024;
    let finished = false;
    const sending = call('syncPeer.send', { id: a.id, frame: 'big' }).then(() => { finished = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    assert.equal(channel.sent.length, 0);
    channel.bufferedAmount = 0;
    channel.emit('bufferedamountlow');
    await sending;
    assert.equal(channel.sent.length, 1);
});

test('without WebRTC the open call fails with a readable message', async () => {
    const buses = createFakeBuses();
    registerSyncPeerService(buses.network, { RTCPeerConnectionCtor: undefined });
    const result = await request(buses.network, 'syncPeer.open', { params: { initiator: true } });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /WebRTC is not available/);
});
