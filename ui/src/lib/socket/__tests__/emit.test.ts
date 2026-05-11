import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { emitWithAck, emitIfConnected } from '../emit';
import { commandFeedbackStore, clearCommandFeedback } from '$lib/stores/commandFeedbackStore';

function makeSocket(connected: boolean) {
	return {
		connected,
		emit: vi.fn()
	};
}

beforeEach(() => {
	clearCommandFeedback();
});

describe('emitWithAck — fail-fast when disconnected', () => {
	it('rejects synchronously without calling socket.emit when socket.connected is false', async () => {
		const socket = makeSocket(false);
		const result = await emitWithAck(
			socket as unknown as Parameters<typeof emitWithAck>[0],
			'transport:play-pause',
			{ zone_id: 'z' },
			{ feedback: { source: 'transport', command: 'transport:play-pause' } }
		);

		expect(result).toEqual({ success: false, error: 'Not connected to server' });
		// Critical: socket.io would buffer the emit and replay it on
		// reconnect. We must NOT call socket.emit at all.
		expect(socket.emit).not.toHaveBeenCalled();
	});

	it('pushes a feedback toast when disconnected and feedback is configured', async () => {
		const socket = makeSocket(false);
		await emitWithAck(
			socket as unknown as Parameters<typeof emitWithAck>[0],
			'transport:next',
			{ zone_id: 'z' },
			{ feedback: { source: 'transport', command: 'transport:next' } }
		);

		const toast = get(commandFeedbackStore);
		expect(toast?.message).toBe('Not connected to server');
		expect(toast?.source).toBe('transport');
	});

	it('still emits when the socket is connected', async () => {
		const socket = makeSocket(true);
		// Resolve the ack synchronously so the promise resolves.
		socket.emit.mockImplementation(
			(_event: string, _payload: unknown, ack: (raw: unknown) => void) => {
				ack({ success: true });
			}
		);

		const result = await emitWithAck(
			socket as unknown as Parameters<typeof emitWithAck>[0],
			'transport:play-pause',
			{ zone_id: 'z' }
		);

		expect(result.success).toBe(true);
		expect(socket.emit).toHaveBeenCalledTimes(1);
	});
});

describe('emitIfConnected — fire-and-forget emit guard', () => {
	it('skips emit and returns false when disconnected', () => {
		const socket = makeSocket(false);
		const sent = emitIfConnected(
			socket as unknown as Parameters<typeof emitIfConnected>[0],
			'browse:search',
			{ input: 'beatles' },
			{ source: 'browse', command: 'browse:search' }
		);

		expect(sent).toBe(false);
		expect(socket.emit).not.toHaveBeenCalled();
	});

	it('pushes a feedback toast on disconnected emit', () => {
		const socket = makeSocket(false);
		emitIfConnected(
			socket as unknown as Parameters<typeof emitIfConnected>[0],
			'browse:search',
			{ input: 'beatles' },
			{ source: 'browse', command: 'browse:search' }
		);
		expect(get(commandFeedbackStore)?.message).toBe('Not connected to server');
	});

	it('emits and returns true when connected', () => {
		const socket = makeSocket(true);
		const sent = emitIfConnected(
			socket as unknown as Parameters<typeof emitIfConnected>[0],
			'browse:search',
			{ input: 'beatles' }
		);
		expect(sent).toBe(true);
		expect(socket.emit).toHaveBeenCalledWith('browse:search', { input: 'beatles' });
	});

	it('does not push a feedback toast when no feedback option is given', () => {
		const socket = makeSocket(false);
		emitIfConnected(
			socket as unknown as Parameters<typeof emitIfConnected>[0],
			'browse:search',
			{ input: 'beatles' }
		);
		expect(get(commandFeedbackStore)).toBeNull();
	});
});
