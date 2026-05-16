import { writable } from 'svelte/store';
import type {
	RecentlyPlayedEntry,
	RecentlyPlayedInsertedPayload,
	RecentlyPlayedClearedPayload,
	RecentlyPlayedSnapshot
} from '@shared/types';
import { recentlyPlayedDedupeKey } from '@shared/recentlyPlayed';
import { fetchRecentlyPlayed } from '../api/client';

/**
 * "Recently played on this controller" — populated by the backend
 * RecentlyPlayedService. Loaded once via REST at first mount, then
 * kept fresh via socket events (`recently-played-inserted` and
 * `recently-played-cleared`), each carrying a monotonic revision.
 *
 * Out-of-order delivery (socket events vs. REST responses, or socket
 * events vs. each other) used to corrupt state in narrow races —
 * e.g. a slow DELETE response arriving after a post-clear socket
 * insert would wipe the legitimate new entry. The revision check
 * below (`if revision <= lastApplied: discard`) makes every apply
 * path idempotent against stale signals, so server, disk, and all
 * clients converge regardless of arrival order.
 *
 * Honest scope: only reflects plays that happened while this
 * controller's backend was running and subscribed to Roon. Plays
 * during downtime are missed. The welcome view labels this honestly.
 */

export interface RecentlyPlayedState {
	entries: RecentlyPlayedEntry[];
	loading: boolean;
	loaded: boolean;
}

const initialState: RecentlyPlayedState = {
	entries: [],
	loading: false,
	loaded: false
};

const internalStore = writable<RecentlyPlayedState>(initialState);

export const recentlyPlayedStore = {
	subscribe: internalStore.subscribe
};

const CAP = 50;

/**
 * The highest revision we've successfully applied. A monotonic guard
 * against stale events: anything not strictly newer is discarded.
 *
 * Reset paths (resetRecentlyPlayed, load with revision <= current)
 * also touch this — see those functions for the specific semantics.
 * A server restart resets its counter to 0; reconnect-triggered
 * `loadRecentlyPlayed` re-baselines this from the load response.
 */
let lastAppliedRevision = 0;

/**
 * Apply an authoritative snapshot if it's strictly newer than what
 * we've already applied. Used internally by load and the DELETE
 * response path; both deliver `{ entries, revision }` from the server.
 */
function applySnapshot(snapshot: RecentlyPlayedSnapshot): void {
	if (snapshot.revision <= lastAppliedRevision) return;
	lastAppliedRevision = snapshot.revision;
	internalStore.update((s) => ({
		...s,
		entries: snapshot.entries.slice(0, CAP),
		loaded: true
	}));
}

export async function loadRecentlyPlayed(fetchFn: typeof fetch): Promise<void> {
	internalStore.update((s) => ({ ...s, loading: true }));
	try {
		const snapshot = await fetchRecentlyPlayed(fetchFn);
		applySnapshot(snapshot);
		internalStore.update((s) => ({ ...s, loading: false }));
	} catch {
		// Network or REST hiccup — leave any previously-loaded list
		// visible, just clear the loading flag. UI shows whatever
		// entries it had (possibly empty on first mount).
		internalStore.update((s) => ({ ...s, loading: false }));
	}
}

/**
 * Apply a `recently-played-inserted` socket event. Discards stale
 * events (revision not strictly newer than the last applied), then
 * mirrors the backend's bubble-to-front: drops any prior occurrence
 * of the same track (by shared dedupe key) before unshifting, so a
 * replayed track moves to the top instead of duplicating.
 */
export function applyRecentlyPlayedInserted(
	payload: RecentlyPlayedInsertedPayload
): void {
	if (payload.revision <= lastAppliedRevision) return;
	lastAppliedRevision = payload.revision;
	const { entry } = payload;
	internalStore.update((s) => {
		const key = recentlyPlayedDedupeKey(entry);
		const deduped = s.entries.filter((e) => recentlyPlayedDedupeKey(e) !== key);
		const entries = [entry, ...deduped].slice(0, CAP);
		return { ...s, entries, loaded: true };
	});
}

/**
 * Apply a `recently-played-cleared` socket event. Discards stale
 * events the same way `applyRecentlyPlayedInserted` does.
 */
export function applyRecentlyPlayedCleared(
	payload: RecentlyPlayedClearedPayload
): void {
	if (payload.revision <= lastAppliedRevision) return;
	lastAppliedRevision = payload.revision;
	internalStore.update((s) => ({ ...s, entries: [], loaded: true }));
}

/**
 * Apply the authoritative snapshot returned by a DELETE response.
 * Wraps `applySnapshot` so the UI handler has a clear name for the
 * "after the user clicked Clear, here's the server's truth" path.
 */
export function applyClearResponse(snapshot: RecentlyPlayedSnapshot): void {
	applySnapshot(snapshot);
}

/**
 * Wipe local store + revision tracking. Used by tests and any future
 * full-reset path. Note: this does NOT contact the server — for a
 * user-initiated wipe use the DELETE flow.
 */
export function resetRecentlyPlayed(): void {
	lastAppliedRevision = 0;
	internalStore.set({ ...initialState });
}
