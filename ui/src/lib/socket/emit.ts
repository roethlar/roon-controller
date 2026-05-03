import type { Socket } from 'socket.io-client';
import { pushCommandFeedback, type CommandSource } from '../stores/commandFeedbackStore';

/**
 * Standardized ack response shape that the server sends for every
 * command that supplies an ack callback. Mirrors `AckResponse<T>` in
 * `src/server/socket/index.ts`.
 */
export type AckResponse<T = undefined> =
	| { success: true; data?: T }
	| { success: false; error: string; code?: string };

export interface EmitWithAckOptions {
	/** Override the per-call timeout in ms. Default 5000. */
	timeoutMs?: number;
	/** If set, push a feedback toast on failure under this source/command. */
	feedback?: { source: CommandSource; command: string };
}

/**
 * Emit a socket event with an ack callback. Returns the parsed AckResponse.
 *
 * Failure modes that surface as `{ success: false }`:
 * - Server-reported error
 * - Timeout (no ack within `timeoutMs`)
 * - Malformed ack payload
 *
 * If `feedback` is provided, failures are also pushed to commandFeedbackStore
 * so the user sees a toast. Callers should still inspect the return value
 * if they need to take action on the result.
 */
export function emitWithAck<T = undefined>(
	socket: Socket,
	event: string,
	payload: unknown,
	options: EmitWithAckOptions = {}
): Promise<AckResponse<T>> {
	const timeoutMs = options.timeoutMs ?? 5000;

	return new Promise<AckResponse<T>>((resolve) => {
		let settled = false;
		const settle = (response: AckResponse<T>) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (!response.success && options.feedback) {
				pushCommandFeedback({
					source: options.feedback.source,
					command: options.feedback.command,
					message: response.error
				});
			}
			resolve(response);
		};

		const timer = setTimeout(() => {
			settle({ success: false, error: 'Command timed out' });
		}, timeoutMs);

		try {
			socket.emit(event, payload, (raw: unknown) => {
				settle(parseAck<T>(raw));
			});
		} catch (err) {
			settle({
				success: false,
				error: err instanceof Error ? err.message : 'Failed to send command'
			});
		}
	});
}

function parseAck<T>(raw: unknown): AckResponse<T> {
	if (raw && typeof raw === 'object' && 'success' in raw) {
		const r = raw as Record<string, unknown>;
		if (r.success === true) {
			return { success: true, data: r.data as T };
		}
		if (r.success === false && typeof r.error === 'string') {
			return {
				success: false,
				error: r.error,
				code: typeof r.code === 'string' ? r.code : undefined
			};
		}
	}
	// Tolerate older or odd ack shapes — treat as success when nothing
	// looks like an error, otherwise surface as a generic failure.
	if (raw && typeof raw === 'object' && 'error' in raw && typeof (raw as { error: unknown }).error === 'string') {
		return { success: false, error: (raw as { error: string }).error };
	}
	return { success: true };
}
