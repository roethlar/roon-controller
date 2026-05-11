import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { emitWithAck } from '../emit';
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
