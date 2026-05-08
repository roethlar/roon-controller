import { writable } from 'svelte/store';
import type { RecentlyPlayedEntry } from '@shared/types';
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

export async function loadRecentlyPlayed(fetchFn: typeof fetch): Promise<void> {
	internalStore.update((s) => ({ ...s, loading: true }));
	try {
		const entries = await fetchRecentlyPlayed(fetchFn);
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
 */
export function appendRecentlyPlayedFromSocket(
	entry: RecentlyPlayedEntry
): void {
	internalStore.update((s) => {
		const head = s.entries[0];
		if (head && head.played_at === entry.played_at && head.zone_id === entry.zone_id) {
			return s;
		}
		const entries = [entry, ...s.entries].slice(0, CAP);
		return { ...s, entries, loaded: true };
	});
}

export function resetRecentlyPlayed(): void {
	internalStore.set({ ...initialState });
}
