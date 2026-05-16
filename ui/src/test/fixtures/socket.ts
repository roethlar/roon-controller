import { vi } from 'vitest';

/**
 * Test double for the socket.io client used by `$lib/socket/client`.
 * Returned by `createFakeSocket()` so each test file gets its own
 * instance — call this once at module level, wire it into the
 * `vi.mock('$lib/socket/client', ...)` factory's closure, and call
 * `mockReset()` on `.emit` between tests if you assert on calls.
 *
 * Includes the `io` reconnect handle so layout / library tests that
 * subscribe to reconnect events don't crash. Components that don't
 * use `io` simply ignore it.
 */
export interface FakeSocket {
	emit: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	off: ReturnType<typeof vi.fn>;
	connected: boolean;
	io: {
		on: ReturnType<typeof vi.fn>;
		off: ReturnType<typeof vi.fn>;
	};
}

export function createFakeSocket(): FakeSocket {
	return {
		emit: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
		connected: true,
		io: { on: vi.fn(), off: vi.fn() }
	};
}
