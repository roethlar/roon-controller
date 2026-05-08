import { writable } from 'svelte/store';
import type { BrowseResult } from '@shared/types';
import { browse as apiBrowse } from '../api/client';

/**
 * Library-stat tiles for the welcome view (Hi-Michael-style header
 * in native Roon). Roon's public extension API exposes the totals
 * via dedicated hierarchies (`artists`, `albums`, `composers`) — a
 * single `popAll: true` browse call returns `totalCount` at level 0
 * without paginating through items.
 *
 * `tracks` isn't in the documented hierarchy list, so we try it
 * optimistically and fall back to drilling `browse → Library →
 * Tracks` if it errors. Each stat is independent: one tile failing
 * doesn't block the others — the Library page renders `—` for any
 * stat whose value is null.
 *
 * Like exploreRailStore, every browse call uses a dedicated
 * multiSessionKey so the stats fetch doesn't disturb the user's
 * main browse session.
 */

export interface WelcomeStats {
	artists: number | null;
	albums: number | null;
	tracks: number | null;
	composers: number | null;
}

export interface WelcomeStatsState extends WelcomeStats {
	loading: boolean;
	loaded: boolean;
}

const initialState: WelcomeStatsState = {
	artists: null,
	albums: null,
	tracks: null,
	composers: null,
	loading: false,
	loaded: false
};

const internalStore = writable<WelcomeStatsState>(initialState);

let resolveToken = 0;

export const welcomeStatsStore = {
	subscribe: internalStore.subscribe
};

const SESSION_KEY = 'welcome-stats';

async function fetchTotal(
	fetchFn: typeof fetch,
	hierarchy: string
): Promise<number | null> {
	try {
		const result: BrowseResult = await apiBrowse(fetchFn, {
			hierarchy,
			multiSessionKey: `${SESSION_KEY}-${hierarchy}`,
			popAll: true
		});
		return result.totalCount ?? result.count ?? null;
	} catch {
		return null;
	}
}

async function fetchTracksTotal(fetchFn: typeof fetch): Promise<number | null> {
	// Try the undocumented `tracks` hierarchy first.
	const direct = await fetchTotal(fetchFn, 'tracks');
	if (direct !== null) return direct;

	// Fall back: drill browse → Library → Tracks. Two calls instead
	// of one. Each call uses the same dedicated multiSessionKey so
	// the session stays at the right level between drills.
	try {
		const sk = `${SESSION_KEY}-tracks-fallback`;
		const root = await apiBrowse(fetchFn, {
			hierarchy: 'browse',
			multiSessionKey: sk,
			popAll: true
		});
		const library = root.items.find((it) => it.title === 'Library');
		if (!library?.itemKey) return null;

		const libContents = await apiBrowse(fetchFn, {
			hierarchy: 'browse',
			multiSessionKey: sk,
			itemKey: library.itemKey
		});
		const tracks = libContents.items.find((it) => it.title === 'Tracks');
		if (!tracks?.itemKey) return null;

		const tracksList = await apiBrowse(fetchFn, {
			hierarchy: 'browse',
			multiSessionKey: sk,
			itemKey: tracks.itemKey
		});
		return tracksList.totalCount ?? tracksList.count ?? null;
	} catch {
		return null;
	}
}

/**
 * Load all four library totals in parallel. Resolve token guards
 * against `core-status` flap producing a stale completion that
 * overwrites a newer success (same pattern as exploreRailStore).
 */
export async function loadWelcomeStats(fetchFn: typeof fetch): Promise<void> {
	const myToken = ++resolveToken;
	internalStore.update((s) => ({ ...s, loading: true }));

	const [artists, albums, composers, tracks] = await Promise.all([
		fetchTotal(fetchFn, 'artists'),
		fetchTotal(fetchFn, 'albums'),
		fetchTotal(fetchFn, 'composers'),
		fetchTracksTotal(fetchFn)
	]);

	if (myToken !== resolveToken) return;

	internalStore.set({
		artists,
		albums,
		tracks,
		composers,
		loading: false,
		loaded: true
	});
}

export function invalidateWelcomeStats(): void {
	resolveToken++;
	internalStore.set({ ...initialState });
}
