import { writable } from 'svelte/store';
import type { RecentlyPlayedEntry } from '@shared/types';
import { recentlyPlayedDedupeKey } from '@shared/recentlyPlayed';
import { fetchRecentlyPlayed } from '../api/client';

/**
 * "Recently played on this controller" — populated by the backend
 * RecentlyPlayedService. Loaded once via REST at first mount, then
 * kept fresh via the `recently-played-inserted` socket event (a new
 * entry is unshifted; capped at the same size the backend uses).
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
 * Bumped on every clear (user-initiated or socket-broadcast). A load
 * started before a clear must NOT overwrite the post-clear empty
 * state when its response finally arrives — that would resurrect
 * pre-clear entries. Each load captures the generation at start and
 * discards its response if the generation has advanced since.
 *
 * Reset bumps it too (so a reset-then-stale-load doesn't repopulate).
 */
let clearGen = 0;

export async function loadRecentlyPlayed(fetchFn: typeof fetch): Promise<void> {
	const startGen = clearGen;
	internalStore.update((s) => ({ ...s, loading: true }));
	try {
		const entries = await fetchRecentlyPlayed(fetchFn);
		if (clearGen !== startGen) {
			// A clear (or reset) happened while this load was in flight.
			// The post-clear state is the source of truth; drop the
			// stale response so it can't resurrect deleted entries.
			internalStore.update((s) => ({ ...s, loading: false }));
			return;
		}
		internalStore.set({
			entries: entries.slice(0, CAP),
			loading: false,
			loaded: true
		});
	} catch {
		// Network or REST hiccup — leave any previously-loaded list
		// visible, just clear the loading flag. UI shows whatever
		// entries it had (possibly empty on first mount).
		internalStore.update((s) => ({ ...s, loading: false }));
	}
}

/**
 * Apply a `recently-played-inserted` socket event. Idempotent on
 * the off-chance the same entry is broadcast twice — checks the
 * current head before unshifting. Caps the list to mirror what the
 * backend persists.
 *
 * Mirrors the backend's bubble-to-front: drops any prior occurrence
 * of the same track (by shared dedupe key) before unshifting, so a
 * replayed track moves to the top instead of duplicating.
 */
export function appendRecentlyPlayedFromSocket(
	entry: RecentlyPlayedEntry
): void {
	internalStore.update((s) => {
		const key = recentlyPlayedDedupeKey(entry);
		// Idempotence guard: the exact same entry broadcast twice is a
		// no-op (return the same reference so subscribers don't re-run).
		// Must compare the dedupe key too — played_at + zone_id alone
		// would wrongly collapse two distinct tracks that changed in
		// the same millisecond in the same zone.
		const head = s.entries[0];
		if (
			head &&
			head.played_at === entry.played_at &&
			head.zone_id === entry.zone_id &&
			recentlyPlayedDedupeKey(head) === key
		) {
			return s;
		}
		const deduped = s.entries.filter((e) => recentlyPlayedDedupeKey(e) !== key);
		const entries = [entry, ...deduped].slice(0, CAP);
		return { ...s, entries, loaded: true };
	});
}

/**
 * Empty the list in response to a user-initiated clear. Distinct from
 * `resetRecentlyPlayed` (which returns to the unloaded initial state):
 * here the list is *known* empty, so `loaded` stays true and the
 * welcome view shows nothing rather than a loading state. Called both
 * by the UI's Clear action (optimistically, on REST success) and by
 * the `recently-played-cleared` socket handler — clearing an
 * already-empty list is a harmless no-op, so the two paths converge.
 */
export function clearRecentlyPlayedEntries(): void {
	clearGen++;
	internalStore.update((s) => ({ ...s, entries: [], loaded: true }));
}

export function resetRecentlyPlayed(): void {
	clearGen++;
	internalStore.set({ ...initialState });
}
