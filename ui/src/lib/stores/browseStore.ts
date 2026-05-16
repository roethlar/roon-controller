import { writable } from 'svelte/store';
import type { BrowseItem, BrowseResult, SearchResult } from '@shared/types';

export interface BrowseState {
	current: BrowseResult | null;
	hierarchy: string;
	lastSearch: SearchResult[] | null;
	lastSearchQuery: string | null;
	searchLoading: boolean;
	searchError: string | null;
	loading: boolean;
	error: string | null;
}

const initialState: BrowseState = {
	current: null,
	hierarchy: 'browse',
	lastSearch: null,
	lastSearchQuery: null,
	searchLoading: false,
	searchError: null,
	loading: false,
	error: null
};

const internalStore = writable<BrowseState>(initialState);

export const browseStore = {
	subscribe: internalStore.subscribe
};

export function setBrowseResult(result: BrowseResult, hierarchy?: string): void {
	internalStore.update((state) => ({
		current: result,
		hierarchy: hierarchy ?? state.hierarchy,
		lastSearch: state.lastSearch,
		lastSearchQuery: state.lastSearchQuery,
		searchLoading: false,
		searchError: null,
		loading: false,
		error: null
	}));
}

/**
 * Append more items to the currently displayed browse result. Used by
 * "Load more" pagination — preserves list/title/totalCount metadata while
 * extending the items array. Duplicates (same itemKey) are skipped.
 */
export function appendBrowseItems(items: BrowseItem[]): void {
	internalStore.update((state) => {
		if (!state.current) return state;
		const existing = new Set(
			state.current.items.map((i) => i.itemKey).filter((k): k is string => Boolean(k))
		);
		const additions = items.filter((i) => !i.itemKey || !existing.has(i.itemKey));
		const merged: BrowseResult = {
			...state.current,
			items: [...state.current.items, ...additions],
			count: state.current.items.length + additions.length
		};
		return { ...state, current: merged };
	});
}

export function setSearchResults(results: SearchResult[]): void {
	internalStore.update((state) => ({
		...state,
		lastSearch: results,
		searchLoading: false,
		searchError: null,
		loading: false,
		error: null
	}));
}

export function setSearchLoading(query?: string): void {
	internalStore.update((state) => ({
		...state,
		lastSearchQuery: query ?? state.lastSearchQuery,
		searchLoading: true,
		searchError: null
	}));
}

export function setSearchError(message: string): void {
	internalStore.update((state) => ({
		...state,
		searchLoading: false,
		searchError: message
	}));
}

export function clearSearchResults(): void {
	internalStore.update((state) => ({
		...state,
		lastSearch: null,
		lastSearchQuery: null,
		searchLoading: false,
		searchError: null
	}));
}

export function setBrowseLoading(hierarchy?: string): void {
	internalStore.update((state) => ({
		...state,
		hierarchy: hierarchy ?? state.hierarchy,
		searchLoading: false,
		loading: true,
		error: null
	}));
}

/**
 * Clear the loading flag without touching `current` or `hierarchy`.
 * Used when an optimistically-set loading state needs to be undone
 * because the underlying request never went out (e.g. socket
 * disconnected before emit).
 */
export function clearBrowseLoading(): void {
	internalStore.update((state) => ({ ...state, loading: false }));
}

export function setBrowseError(message: string): void {
	internalStore.update((state) => ({
		...state,
		loading: false,
		error: message
	}));
}

/**
 * Full snapshot of BrowseState. Used by failure-rollback paths
 * (rail / play-bar navigation) that need to restore EVERY field
 * exactly as it was before an optimistic mutation.
 *
 * We capture the whole state — not just current+hierarchy+loading+
 * error — because `setBrowseLoading` clears `searchLoading` and
 * `error` as side effects, and other setters in this file have
 * similar cross-slice clears. A narrow snapshot would silently lose
 * any field that a future "set*Loading"-style helper happens to
 * clear. The full snapshot is the safe default; the cost (one
 * object copy per click) is negligible.
 *
 * Concurrency note: any unrelated mutation that lands DURING the
 * await window between snapshot and restore will be reverted.
 * Today's call sites gate concurrency via per-flow `*InFlight`
 * flags (e.g. `railNavInFlight`) so this is not a practical issue.
 * If a future call site needs to coexist with concurrent writes,
 * snapshot+restore is the wrong tool.
 */
export type BrowseStateSnapshot = BrowseState;

export function snapshotBrowseState(state: BrowseState): BrowseStateSnapshot {
	return { ...state };
}

export function restoreBrowseState(prev: BrowseStateSnapshot): void {
	internalStore.set({ ...prev });
}

export function resetBrowse(): void {
	internalStore.set(initialState);
}
