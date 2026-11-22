const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { AudioPlayerStatus, StreamType, createAudioResource } = require("@discordjs/voice");
const { WebAudioConnection, decodeWebAudioOpusFrame } = require("../core/dist");
const { createTrackedAudioPlayer } = require("./helpers/audio-player");

const OPUS_PACKET = (marker) => Buffer.from([0xf8, 0xff, 0xfe, marker]);

function createFakeSocket(initialBufferedAmount = 0) {
	const listeners = new Map();
	return {
		readyState: 1,
		bufferedAmount: initialBufferedAmount,
		sent: [],
		open() {
			this.readyState = 1;
			for (const listener of listeners.get("open") ?? []) listener({});
		},
		close() {
			this.readyState = 3;
			for (const listener of listeners.get("close") ?? []) listener({});
		},
		addEventListener(type, listener) {
			const entries = listeners.get(type) ?? new Set();
			entries.add(listener);
			listeners.set(type, entries);
		},
		removeEventListener(type, listener) {
			listeners.get(type)?.delete(listener);
		},
		send(data) {
			this.sent.push(data);
		},
	};
}

const binaryFrames = (socket) => socket.sent.filter((m) => typeof m !== "string").map((m) => decodeWebAudioOpusFrame(m));
const flushMessages = (socket) =>
	socket.sent
		.filter((m) => typeof m === "string")
		.map((m) => JSON.parse(m))
		.filter((m) => m.type === "playback:flush");

/**
 * Minimal stand-in for the @discordjs/voice AudioPlayer: it tracks a state object and emits
 * stateChange exactly like the real player when play()/stop() swap resources.
 */
function createFakeAudioPlayer(initialStatus = AudioPlayerStatus.Idle) {
	const listeners = new Map();
	const player = {
		state: { status: initialStatus },
		on(type, listener) {
			const entries = listeners.get(type) ?? new Set();
			entries.add(listener);
			listeners.set(type, entries);
		},
		off(type, listener) {
			listeners.get(type)?.delete(listener);
		},
		emit(type, ...args) {
			for (const listener of listeners.get(type) ?? []) listener(...args);
		},
		subscribe(connection) {
			const subscription = {
				player,
				connection,
				unsubscribe() {
					connection.onSubscriptionRemoved(subscription);
				},
			};
			return subscription;
		},
		play(resource) {
			const oldState = player.state;
			player.state = { status: AudioPlayerStatus.Playing, resource };
			player.emit("stateChange", oldState, player.state);
		},
		stop() {
			const oldState = player.state;
			player.state = { status: AudioPlayerStatus.Idle };
			player.emit("stateChange", oldState, player.state);
		},
	};
	return player;
}

// Polls until the predicate holds: the AudioPlayer's 20ms scheduler and silence padding make fixed
// sleeps unreliable for waiting on Idle/frame delivery.
const waitFor = async (predicate, timeoutMs = 3000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && !predicate()) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(predicate(), "condition was not met in time");
};

const opusResource = (marker, count = Infinity) => {
	let produced = 0;
	const stream = new Readable({
		objectMode: true,
		read() {
			if (produced++ >= count) this.push(null);
			else this.push(OPUS_PACKET(marker));
		},
	});
	return createAudioResource(stream, { inputType: StreamType.Opus });
};

// Drains an AudioResource's play stream to EOF so `readableEnded` becomes true, mirroring what the
// AudioPlayer does when a finite track plays out naturally.
const drainToEnd = (resource) =>
	new Promise((resolve, reject) => {
		resource.playStream.on("error", reject);
		const tryRead = () => {
			const chunk = resource.playStream.read();
			if (chunk === null) {
				if (resource.playStream.readableEnded) return resolve();
				resource.playStream.once("readable", tryRead);
			} else {
				setImmediate(tryRead);
			}
		};
		tryRead();
		resource.playStream.once("end", resolve);
	});

function setup(connectionOptions = {}) {
	const player = createFakeAudioPlayer();
	const connection = new WebAudioConnection({ sessionId: "generation-test", ...connectionOptions });
	const socket = createFakeSocket();
	connection.attachSocket(socket);
	assert.ok(connection.subscribe(player));
	return { player, connection, socket };
}

test("flush drops the pending packet and every queued frame of the old generation and never sends them", () => {
	// Large byte limit: congestion is driven purely by the fake socket's bufferedAmount, so once it
	// catches up every new frame is sent immediately instead of being parked in the backlog.
	const { connection, socket } = setup({ maxBufferedBytes: 1_000_000, maxQueuedPackets: 50 });
	socket.bufferedAmount = 10_000_000; // saturated: even the first frame goes into the per-socket queue

	connection.prepareAudioPacket(OPUS_PACKET(0x01));
	connection.dispatchAudio();
	connection.prepareAudioPacket(OPUS_PACKET(0x02));
	connection.dispatchAudio();
	assert.equal(binaryFrames(socket).length, 0, "congested socket must only have queued frames");
	const generationBefore = connection.currentGeneration;

	// A packet prepared but not yet dispatched must be discarded by the generation switch.
	connection.prepareAudioPacket(OPUS_PACKET(0x03));
	connection.flush("resource-changed");

	assert.equal(connection.currentGeneration, generationBefore + 1, "flush starts a new session generation");
	connection.dispatchAudio(); // attempts to dispatch the stale prepared packet

	// Socket catches up and has room: anything still queued would be drained on this dispatch.
	socket.bufferedAmount = 0;
	connection.prepareAudioPacket(OPUS_PACKET(0x11));
	connection.dispatchAudio();

	const frames = binaryFrames(socket);
	assert.deepEqual(
		frames.map((f) => f.payload[3]),
		[0x11],
		"only the new-generation frame is delivered; old queue and stale pending packet are gone",
	);
	const flush = flushMessages(socket);
	assert.equal(flush.length, 1);
	assert.equal(flush[0].reason, "resource-changed");
	assert.equal(flush[0].generation, connection.currentGeneration, "flush message carries the new generation");
	connection.destroy();
});

test("the new resource restarts at sequence 0 / timestamp 0 and both run continuously without holes", () => {
	const { connection, socket } = setup();

	for (let i = 0; i < 5; i++) {
		connection.prepareAudioPacket(OPUS_PACKET(i + 1));
		connection.dispatchAudio();
	}
	let frames = binaryFrames(socket);
	assert.deepEqual(
		frames.map((f) => f.sequence),
		[0, 1, 2, 3, 4],
	);
	assert.deepEqual(
		frames.map((f) => f.timestampUs),
		[0n, 20_000n, 40_000n, 60_000n, 80_000n],
	);

	const generationBefore = connection.currentGeneration;
	connection.flush("resource-changed");
	assert.equal(connection.currentGeneration, generationBefore + 1);

	for (let i = 0; i < 4; i++) {
		connection.prepareAudioPacket(OPUS_PACKET(0x20 + i));
		connection.dispatchAudio();
	}
	frames = binaryFrames(socket);
	const newFrames = frames.slice(5);
	assert.deepEqual(
		newFrames.map((f) => f.sequence),
		[0, 1, 2, 3],
		"sequence is re-aligned to 0 after the flush and increments continuously",
	);
	assert.deepEqual(
		newFrames.map((f) => f.timestampUs),
		[0n, 20_000n, 40_000n, 60_000n],
		"microsecond timestamps restart at 0 and advance by one 20ms frame each",
	);
	for (let i = 1; i < newFrames.length; i++) {
		assert.equal(newFrames[i].sequence, newFrames[i - 1].sequence + 1, "no sequence hole inside the new generation");
		assert.equal(newFrames[i].timestampUs - newFrames[i - 1].timestampUs, 20_000n, "no timestamp hole inside the new generation");
	}
	connection.destroy();
});

test("a packet prepared before the flush is discarded with the old generation and never reaches a socket", () => {
	const { connection, socket } = setup();

	connection.prepareAudioPacket(OPUS_PACKET(0x01));
	connection.flush("seek");
	connection.dispatchAudio(); // flush already invalidated the prepared packet of the old generation

	assert.equal(binaryFrames(socket).length, 0, "old-generation prepared packet must not be sent after flush");

	connection.prepareAudioPacket(OPUS_PACKET(0x02));
	connection.dispatchAudio();
	const frames = binaryFrames(socket);
	assert.equal(frames.length, 1);
	assert.equal(frames[0].sequence, 0, "first new-generation frame uses the re-aligned sequence");
	assert.equal(frames[0].payload[3], 0x02);
	connection.destroy();
});

test("slow sockets keep their own backlog and drop statistics; flush only clears queues, not counters", () => {
	const onDropCalls = [];
	const { connection, socket } = setup({
		maxBufferedBytes: 10,
		maxQueuedPackets: 2,
		dropPolicy: "drop-newest",
		onDrop: (stats) => onDropCalls.push(stats),
	});
	const baselineGeneration = connection.currentGeneration;
	socket.bufferedAmount = 10_000_000; // absolutely saturated: even the first frame must go to the queue

	const droppedEvents = [];
	connection.on("drop", (event) => droppedEvents.push(event));

	// Queue capacity is 2; the third packet triggers drop-newest, the fourth another drop.
	for (let i = 0; i < 4; i++) {
		connection.prepareAudioPacket(OPUS_PACKET(i));
		connection.dispatchAudio();
	}

	let stats = connection.getStats();
	assert.equal(stats.droppedPackets, 2, "drop-newest must accumulate dropped packet statistics");
	assert.equal(stats.droppedBytes, OPUS_PACKET(0).length * 2, "dropped byte statistics accumulate too");
	assert.equal(onDropCalls.length, 2, "onDrop callback fires per dropped packet");
	assert.equal(droppedEvents.length, 2, "drop events fire per dropped packet");
	assert.equal(droppedEvents[0].generation, baselineGeneration);

	const beforeFlush = connection.getStats();
	connection.flush("resource-changed");
	stats = connection.getStats();
	assert.equal(stats.droppedPackets, beforeFlush.droppedPackets, "flushing queues must not erase drop statistics");
	assert.equal(stats.droppedBytes, beforeFlush.droppedBytes);
	assert.equal(connection.currentGeneration, baselineGeneration + 1);

	// New generation frames go into the now-empty queue independently and start dropping again on their own.
	socket.bufferedAmount = 500;
	for (let i = 0; i < 3; i++) {
		connection.prepareAudioPacket(OPUS_PACKET(0x40 + i));
		connection.dispatchAudio();
	}
	stats = connection.getStats();
	assert.equal(stats.droppedPackets, 3, "post-flush backpressure keeps accumulating on the same slow socket");
	assert.equal(droppedEvents.at(-1).generation, baselineGeneration + 1, "post-flush drops are attributed to the new generation");
	connection.destroy();
});

test("per-socket queues and drains are independent when listeners run at different speeds", () => {
	// Realistic byte limit: a healthy socket sends immediately; only the saturated one accumulates a backlog.
	const connection = new WebAudioConnection({
		sessionId: "independent-sockets",
		maxBufferedBytes: 1_000_000,
		maxQueuedPackets: 50,
	});
	connection.subscribe(createFakeAudioPlayer());

	const slow = createFakeSocket(10_000_000); // permanently congested
	const fast = createFakeSocket(0);
	connection.attachSocket(slow);
	connection.attachSocket(fast);

	for (let i = 0; i < 5; i++) {
		connection.prepareAudioPacket(OPUS_PACKET(i));
		connection.dispatchAudio();
	}

	const fastFrames = binaryFrames(fast);
	assert.equal(fastFrames.length, 5, "the fast socket receives every frame immediately");
	assert.deepEqual(
		fastFrames.map((f) => f.sequence),
		[0, 1, 2, 3, 4],
	);
	assert.equal(binaryFrames(slow).length, 0, "the slow socket's frames stay in its own queue");

	// Slow listener catches up: its backlog drains on the next dispatch without affecting the fast one.
	slow.bufferedAmount = 0;
	connection.prepareAudioPacket(OPUS_PACKET(0x7f));
	connection.dispatchAudio();

	assert.deepEqual(
		binaryFrames(slow).map((f) => f.payload[3]),
		[0, 1, 2, 3, 4, 0x7f],
		"the slow socket eventually delivers its whole queued generation in order",
	);
	assert.equal(binaryFrames(fast).length, 6, "the fast socket keeps receiving independently");
	assert.equal(connection.getStats().droppedPackets, 0, "no drops while both queues stay within their limits");
	connection.destroy();
});

test("drop-oldest and disconnect policies keep working per slow socket after a generation switch", () => {
	const connection = new WebAudioConnection({
		sessionId: "policies",
		maxBufferedBytes: 10,
		maxQueuedPackets: 2,
		dropPolicy: "drop-oldest",
	});
	const slow = createFakeSocket(500);
	connection.attachSocket(slow);
	connection.subscribe(createFakeAudioPlayer());

	for (let i = 0; i < 3; i++) {
		connection.prepareAudioPacket(OPUS_PACKET(i));
		connection.dispatchAudio();
	}
	assert.equal(connection.getStats().droppedPackets, 1, "drop-oldest evicts one packet when the queue is full");

	connection.flush("resource-changed");
	for (let i = 0; i < 3; i++) {
		connection.prepareAudioPacket(OPUS_PACKET(0x30 + i));
		connection.dispatchAudio();
	}
	assert.equal(connection.getStats().droppedPackets, 2, "drop-oldest still applies independently in the new generation");

	// disconnect policy: a saturated socket is closed and detached instead of growing its queue.
	const disconnecting = new WebAudioConnection({
		sessionId: "disconnect-policy",
		maxBufferedBytes: 10,
		maxQueuedPackets: 1,
		dropPolicy: "disconnect",
	});
	const doomed = createFakeSocket(500);
	disconnecting.attachSocket(doomed);
	disconnecting.subscribe(createFakeAudioPlayer());
	disconnecting.prepareAudioPacket(OPUS_PACKET(1));
	disconnecting.dispatchAudio();
	disconnecting.prepareAudioPacket(OPUS_PACKET(2));
	disconnecting.dispatchAudio();
	assert.equal(doomed.readyState, 3, "disconnect policy closes the listener that is too slow");
	assert.equal(disconnecting.getStats().droppedPackets, 1, "the disconnect drop is counted");
	disconnecting.destroy();
	connection.destroy();
});

test("natural play-out to EOF does not flush, but a non-Idle resource replacement and an abrupt stop do", async () => {
	const { player, connection, socket } = setup();

	// Non-Idle -> Idle with a fully consumed stream: natural end, tail must be preserved.
	const endedResource = opusResource(0xaa, 3);
	await drainToEnd(endedResource);
	assert.equal(endedResource.playStream.readableEnded, true);
	player.play(endedResource);
	player.stop();
	assert.equal(flushMessages(socket).length, 0, "natural EOF must not flush");

	// Non-Idle -> Idle with a live stream: abrupt stop.
	const liveResource = opusResource(0xbb);
	player.play(liveResource);
	player.stop();
	assert.equal(flushMessages(socket).length, 1, "abrupt stop of a live stream must flush");
	assert.equal(flushMessages(socket)[0].reason, "stopped");

	// Non-Idle -> different resource: skip/seek rebuild.
	const first = opusResource(0xcc);
	const second = opusResource(0xdd);
	player.play(first);
	player.play(second);
	const flushes = flushMessages(socket);
	assert.equal(flushes.length, 2);
	assert.equal(flushes[1].reason, "resource-changed");

	// Idle -> Playing never flushes (nothing old to discard).
	player.stop();
	const flushCount = flushMessages(socket).length;
	player.play(opusResource(0xee));
	assert.equal(flushMessages(socket).length, flushCount, "starting from Idle must not flush");
	connection.destroy();
});

test("the real AudioPlayer triggers one flush on a live skip and none on a natural end-to-Idle transition", async () => {
	const player = createTrackedAudioPlayer();
	const connection = new WebAudioConnection({ sessionId: "real-player-generation" });
	const socket = createFakeSocket();
	connection.attachSocket(socket);
	connection.subscribe(player);

	player.play(opusResource(0xaa, 4));
	await waitFor(() => player.state.status === AudioPlayerStatus.Idle);
	assert.equal(flushMessages(socket).length, 0, "the real player must not flush on natural EOF");

	player.play(opusResource(0xbb));
	await waitFor(() => binaryFrames(socket).some((f) => f.payload[3] === 0xbb));
	player.play(opusResource(0xcc)); // non-Idle resource replacement
	await waitFor(() => flushMessages(socket).length === 1);
	const flushes = flushMessages(socket);
	assert.equal(flushes[0].reason, "resource-changed");

	const frames = binaryFrames(socket);
	assert.ok(frames.length > 0, "the first track dispatched frames before the skip");
	const flushIndex = socket.sent.findIndex((m) => typeof m === "string" && JSON.parse(m).type === "playback:flush");
	// Wait until at least one binary frame has been delivered after the flush message, then snapshot.
	await waitFor(() => socket.sent.slice(flushIndex + 1).some((m) => typeof m !== "string"));
	// Frames delivered after the flush message must all belong to the new generation (sequence restarted).
	const sentAfterFlush = socket.sent
		.slice(flushIndex + 1)
		.filter((m) => typeof m !== "string")
		.map((m) => decodeWebAudioOpusFrame(m));
	assert.equal(sentAfterFlush[0].sequence, 0, "first frame after the flush restarts the sequence");
	assert.deepEqual(
		sentAfterFlush.map((f) => f.sequence),
		sentAfterFlush.map((_, i) => i),
		"post-flush sequences are gap-free from the re-aligned value",
	);
	connection.destroy();
});

test("destroy prevents any further frame or flush from being sent", () => {
	const { connection, socket } = setup();
	connection.prepareAudioPacket(OPUS_PACKET(0x01));
	connection.dispatchAudio();
	const sentBeforeDestroy = socket.sent.length;
	assert.ok(sentBeforeDestroy > 0);

	connection.destroy();

	connection.flush("resource-changed");
	connection.prepareAudioPacket(OPUS_PACKET(0x02));
	connection.dispatchAudio();
	assert.equal(socket.sent.length, sentBeforeDestroy, "no frame or flush message may be sent after destroy");
	assert.equal(
		socket.sent.some((m) => typeof m === "string" && JSON.parse(m).type === "playback:flush"),
		false,
	);

	// A late player state change must not resurrect any output either.
	const player = createFakeAudioPlayer(AudioPlayerStatus.Playing);
	const conn2 = new WebAudioConnection({ sessionId: "destroy-guard" });
	const socket2 = createFakeSocket();
	conn2.attachSocket(socket2);
	conn2.subscribe(player);
	conn2.destroy();
	player.play(opusResource(0x55));
	player.stop();
	assert.equal(socket2.sent.filter((m) => typeof m === "string" && JSON.parse(m).type === "playback:flush").length, 0);
});
