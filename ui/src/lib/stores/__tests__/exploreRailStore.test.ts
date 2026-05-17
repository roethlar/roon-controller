import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import type { BrowseResult, BrowseItem } from '@shared/types';

const apiBrowse = vi.fn<(_fetch: unknown, opts: any) => Promise<BrowseResult>>();

vi.mock('$lib/api/client', () => ({
	browse: (...args: any[]) => apiBrowse(...(args as [unknown, any]))
}));

import {
	exploreRailStore,
	resolveExploreRail,
	invalidateExploreRail
} from '../exploreRailStore';

function listResult(over: Partial<BrowseResult> = {}): BrowseResult {
	return {
		title: over.title ?? 'Browse',
		subtitle: over.subtitle,
		level: over.level ?? 0,
		offset: over.offset ?? 0,
		count: over.count ?? (over.items?.length ?? 0),
		totalCount: over.totalCount ?? (over.items?.length ?? 0),
		items: over.items ?? []
	};
}

function makeItem(over: Partial<BrowseItem> = {}): BrowseItem {
	return {
		title: over.title ?? 'Item',
		subtitle: over.subtitle,
		itemKey: over.itemKey ?? 'k',
		hint: over.hint ?? 'list',
		imageKey: over.imageKey,
		isLoadable: over.isLoadable ?? true,
		isPlayable: over.isPlayable ?? false,
		itemType: over.itemType
	};
}

beforeEach(() => {
	apiBrowse.mockReset();
	invalidateExploreRail();
});

describe('exploreRailStore — resolveExploreRail', () => {
	it('captures level-0 list children, surfaces nested Library children, excludes Search under Library', async () => {
		// Mirrors the live capture: 5 items at level 0.
		const root = listResult({
			title: 'Explore',
			items: [
				makeItem({ title: 'Library', itemKey: 'lib' }),
				makeItem({ title: 'Playlists', itemKey: 'pl' }),
				makeItem({ title: 'My Live Radio', itemKey: 'mlr' }),
				makeItem({ title: 'Genres', itemKey: 'gen' }),
				makeItem({ title: 'Settings', itemKey: 'set' })
			]
		});
		// Library children, including Search which the rail filters out.
		const library = listResult({
			items: [
				makeItem({ title: 'Search', itemKey: 's-key' }),
				makeItem({ title: 'Artists', itemKey: 'art' }),
				makeItem({ title: 'Albums', itemKey: 'alb' }),
				makeItem({ title: 'Tracks', itemKey: 'trk' }),
				makeItem({ title: 'Composers', itemKey: 'comp' }),
				makeItem({ title: 'Tags', itemKey: 'tag' })
			]
		});
		// Playlists has 2 user playlists.
		const playlists = listResult({
			items: [makeItem({ title: 'Mix A' }), makeItem({ title: 'Mix B' })]
		});
		// My Live Radio empty container — Roon's "No Results" placeholder
		// has hint other than 'list' (matches live capture's '—' / null).
		const liveRadio = listResult({
			items: [makeItem({ title: 'No Results', hint: 'header' })]
		});
		// Genres non-empty.
		const genres = listResult({
			items: [makeItem({ title: 'Rock' }), makeItem({ title: 'Jazz' })]
		});

		// Settings is now surfaced (per 2026-05-07 user feedback) — no
		// level-0 exclusions today. Each list-hint level-0 child gets
		// a popAll + drill for empty-state detection.
		const settings = listResult({
			items: [makeItem({ title: 'Profile', subtitle: 'Michael' })]
		});
		// Order: root, popAll, lib, popAll, pl, popAll, mlr, popAll,
		// gen, popAll, set.
		apiBrowse.mockResolvedValueOnce(root);
		apiBrowse.mockResolvedValueOnce(listResult()); // popAll before lib
		apiBrowse.mockResolvedValueOnce(library);
		apiBrowse.mockResolvedValueOnce(listResult()); // popAll before pl
		apiBrowse.mockResolvedValueOnce(playlists);
		apiBrowse.mockResolvedValueOnce(listResult()); // popAll before mlr
		apiBrowse.mockResolvedValueOnce(liveRadio);
		apiBrowse.mockResolvedValueOnce(listResult()); // popAll before gen
		apiBrowse.mockResolvedValueOnce(genres);
		apiBrowse.mockResolvedValueOnce(listResult()); // popAll before set
		apiBrowse.mockResolvedValueOnce(settings);

		await resolveExploreRail(fetch);

		const state = get(exploreRailStore);
		expect(state.loading).toBe(false);
		expect(state.error).toBeNull();

		const labels = state.entries.map((e) => e.label);
		// Library expanded into its non-Search children, then top-level
		// containers (including Settings).
		expect(labels).toEqual([
			'Artists',
			'Albums',
			'Tracks',
			'Composers',
			'Tags',
			'Playlists',
			'My Live Radio',
			'Genres',
			'Settings'
		]);

		// Search still excluded from Library expansion.
		expect(labels).not.toContain('Search');

		// Library children carry the parent in labelPath.
		const albums = state.entries.find((e) => e.label === 'Albums');
		expect(albums?.labelPath).toEqual(['Library', 'Albums']);

		// Top-level entries have single-element labelPath.
		const playlistsEntry = state.entries.find((e) => e.label === 'Playlists');
		expect(playlistsEntry?.labelPath).toEqual(['Playlists']);

		// Empty-state detection: My Live Radio container had no list-hint
		// children, so it's marked muted.
		const liveRadioEntry = state.entries.find((e) => e.label === 'My Live Radio');
		expect(liveRadioEntry?.isEmpty).toBe(true);

		// Non-empty top-level container is not marked muted.
		expect(playlistsEntry?.isEmpty).toBe(false);
	});

	it('uses the dedicated multiSessionKey on every browse call', async () => {
		apiBrowse.mockResolvedValueOnce(
			listResult({ items: [makeItem({ title: 'Library', itemKey: 'lib' })] })
		);
		apiBrowse.mockResolvedValueOnce(listResult()); // popAll
		apiBrowse.mockResolvedValueOnce(listResult({ items: [] })); // empty Library

		await resolveExploreRail(fetch);

		// Every call must carry multiSessionKey: 'explore-rail-discover'
		// to avoid disturbing the user's main browse session.
		for (const call of apiBrowse.mock.calls) {
			expect(call[1]).toEqual(
				expect.objectContaining({ multiSessionKey: 'explore-rail-discover' })
			);
		}
	});

	it('records error state on failure', async () => {
		apiBrowse.mockRejectedValueOnce(new Error('Roon timed out'));
		await resolveExploreRail(fetch);

		const state = get(exploreRailStore);
		expect(state.loading).toBe(false);
		expect(state.error).toBe('Roon timed out');
		expect(state.entries).toEqual([]);
	});

	it('skips the empty-check drill for Settings entirely (no apiBrowse for it)', async () => {
		// Verified live (2026-05-17): drilling Settings via Roon's
		// public browse API consistently returns InvalidItemKey,
		// surfacing as `POST /api/browse 500` on every page load.
		// The catch block downstream handled it functionally, but
		// the 500 polluted both server journal and browser console.
		// Settings is in SKIP_DRILL_LEVEL_0 — the resolver now
		// pushes the entry without attempting the drill.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				items: [
					makeItem({ title: 'Library', itemKey: 'lib' }),
					makeItem({ title: 'Settings', itemKey: 'set' })
				]
			})
		);
		apiBrowse.mockResolvedValueOnce(listResult()); // popAll before lib
		apiBrowse.mockResolvedValueOnce(
			listResult({ items: [makeItem({ title: 'Albums', itemKey: 'alb' })] })
		); // Library drill
		// Settings should NOT generate any popAll or drill calls.

		await resolveExploreRail(fetch);

		const state = get(exploreRailStore);
		expect(state.error).toBeNull();
		const labels = state.entries.map((e) => e.label);
		expect(labels).toContain('Settings');
		expect(labels).toContain('Albums'); // Library still expanded

		// Settings entry shape: no isEmpty (never muted), no cachedKey
		// (forces label-walk on click).
		const settings = state.entries.find((e) => e.label === 'Settings');
		expect(settings?.isEmpty).toBeUndefined();
		expect(settings?.cachedKey).toBeUndefined();

		// Verify the call count: root + popAll + library drill = 3.
		// No popAll + Settings drill (would be 5 with Settings drilled).
		expect(apiBrowse).toHaveBeenCalledTimes(3);
	});

	it('still adds an entry when its child-drill fails (label-walk recovers later)', async () => {
		apiBrowse.mockResolvedValueOnce(
			listResult({
				items: [
					makeItem({ title: 'Library', itemKey: 'lib' }),
					makeItem({ title: 'Genres', itemKey: 'gen' })
				]
			})
		);
		apiBrowse.mockResolvedValueOnce(listResult()); // popAll
		apiBrowse.mockResolvedValueOnce(
			listResult({ items: [makeItem({ title: 'Albums', itemKey: 'alb' })] })
		); // Library OK
		apiBrowse.mockResolvedValueOnce(listResult()); // popAll
		apiBrowse.mockRejectedValueOnce(new Error('blip')); // Genres drill fails

		await resolveExploreRail(fetch);

		const state = get(exploreRailStore);
		expect(state.error).toBeNull();
		const labels = state.entries.map((e) => e.label);
		// Library/Albums (nested) and Genres (top-level, no isEmpty info).
		expect(labels).toEqual(['Albums', 'Genres']);
	});
});

describe('exploreRailStore — resolve token (race protection)', () => {
	it('ignores a stale failed completion that arrives after a newer succeeded one', async () => {
		// Call A: starts, awaits forever-pending root fetch (will fail later).
		// Call B: starts after A, succeeds quickly.
		// When A's failure arrives, the store must not overwrite B's success.
		let resolveA: (r: BrowseResult) => void = () => {};
		let rejectA: (e: Error) => void = () => {};
		const aRoot = new Promise<BrowseResult>((resolve, reject) => {
			resolveA = resolve;
			rejectA = reject;
		});

		// First call (A) — its root fetch is the controllable promise.
		apiBrowse.mockReturnValueOnce(aRoot);
		const callA = resolveExploreRail(fetch);

		// Second call (B) — completes immediately with one entry.
		apiBrowse.mockResolvedValueOnce(
			listResult({ items: [makeItem({ title: 'Genres', itemKey: 'g' })] })
		);
		apiBrowse.mockResolvedValueOnce(listResult()); // popAll
		apiBrowse.mockResolvedValueOnce(
			listResult({ items: [makeItem({ title: 'Rock', itemKey: 'r' })] })
		); // drill Genres (non-empty)

		await resolveExploreRail(fetch);

		// B succeeded — store should reflect it.
		const afterB = get(exploreRailStore);
		expect(afterB.error).toBeNull();
		expect(afterB.entries.map((e) => e.label)).toEqual(['Genres']);

		// Now A fails (stale completion). Must NOT clobber the store.
		rejectA(new Error('A timed out'));
		await callA;

		const final = get(exploreRailStore);
		expect(final.error).toBeNull();
		expect(final.entries.map((e) => e.label)).toEqual(['Genres']);

		// Tag-along: silence the "unused" warning for resolveA.
		void resolveA;
	});

	it('invalidate bumps the token so an in-flight resolve cannot rehydrate cleared state', async () => {
		// Start a resolve A whose root we control.
		let resolveA: (r: BrowseResult) => void = () => {};
		const aRoot = new Promise<BrowseResult>((resolve) => {
			resolveA = resolve;
		});
		apiBrowse.mockReturnValueOnce(aRoot);
		const callA = resolveExploreRail(fetch);

		// Invalidate while A is in flight.
		invalidateExploreRail();
		expect(get(exploreRailStore).entries).toEqual([]);

		// A finishes successfully — but its token is now stale.
		resolveA(listResult({ items: [makeItem({ title: 'Genres', itemKey: 'g' })] }));
		await callA;

		// Store remains cleared.
		expect(get(exploreRailStore).entries).toEqual([]);
	});
});

describe('exploreRailStore — invalidateExploreRail', () => {
	it('clears entries and error', async () => {
		apiBrowse.mockResolvedValueOnce(
			listResult({ items: [makeItem({ title: 'Genres', itemKey: 'g' })] })
		);
		apiBrowse.mockResolvedValueOnce(listResult()); // popAll
		apiBrowse.mockResolvedValueOnce(listResult()); // drill

		await resolveExploreRail(fetch);
		expect(get(exploreRailStore).entries.length).toBe(1);

		invalidateExploreRail();
		const state = get(exploreRailStore);
		expect(state.entries).toEqual([]);
		expect(state.error).toBeNull();
		expect(state.loading).toBe(false);
	});
});
