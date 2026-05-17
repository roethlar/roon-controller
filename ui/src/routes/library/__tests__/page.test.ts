import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { get } from 'svelte/store';
import type { BrowseResult, BrowseItem } from '@shared/types';

// ---------------- Mocks ----------------
//
// The Library page is a wide integration: it pulls in the API client,
// the socket client, several stores, and the Search component. We mock
// the network surfaces (REST + socket) so tests stay deterministic and
// fast, and let the real stores run.

const apiBrowse = vi.fn<(_fetch: unknown, opts: any) => Promise<BrowseResult>>();
const apiBrowseLoad = vi.fn<(_fetch: unknown, opts: any) => Promise<BrowseResult>>();
const apiClearRecentlyPlayed = vi.fn<(_fetch: unknown) => Promise<import('@shared/types').RecentlyPlayedSnapshot>>();

vi.mock('$lib/api/client', () => ({
	browse: (...args: any[]) => apiBrowse(...(args as [unknown, any])),
	browseLoad: (...args: any[]) => apiBrowseLoad(...(args as [unknown, any])),
	clearRecentlyPlayed: (...args: any[]) => apiClearRecentlyPlayed(...(args as [unknown]))
}));

import { createFakeSocket } from '../../../test/fixtures/socket';
const fakeSocket = createFakeSocket();
vi.mock('$lib/socket/client', () => ({
	getSocket: () => fakeSocket,
	disconnectSocket: vi.fn()
}));

// $app/navigation isn't used by Library directly, but the Search child
// component imports nothing from it. Provide a stub anyway so any
// transitive import resolves.
vi.mock('$app/navigation', () => ({
	goto: vi.fn()
}));

// Import after mocks so the page picks them up.
import LibraryPage from '../+page.svelte';
import { browseHistoryStore, resetHistory, pushHistory, popHistory } from '$lib/stores/browseHistoryStore';
import {
	browseStore,
	resetBrowse,
	setBrowseResult,
	setSearchLoading,
	setSearchResults
} from '$lib/stores/browseStore';
import { setSelectedZone } from '$lib/stores/selectedZoneStore';

// ---------------- Helpers ----------------

import { listResult, makeItem, makeSearchResult } from '../../../test/fixtures/browse';

beforeEach(() => {
	apiBrowse.mockReset();
	apiBrowseLoad.mockReset();
	apiClearRecentlyPlayed.mockReset();
	fakeSocket.emit.mockReset();
	// Restore the connected flag — disconnect-path tests flip this to
	// false, and an assertion failure before the test's own restore
	// would otherwise leak the disconnected state into later tests.
	fakeSocket.connected = true;
	resetBrowse();
	resetHistory();
	setSelectedZone('');
	// Default: any apiBrowse call returns an empty browse root.
	apiBrowse.mockResolvedValue(listResult({ level: 0 }));
	apiClearRecentlyPlayed.mockResolvedValue({ entries: [], revision: 1_000_000, epoch: 1 });
});

// ---------------- Tests ----------------

describe('Library page — mount restore', () => {
	it('with empty history, does NOT pop to root and renders the welcome view', async () => {
		// The Explore rail in the layout sidebar already shows the
		// browse-root entries; popping to root in the right pane would
		// just duplicate them. With empty history, restoreBrowse skips
		// the popAll entirely and the page renders a welcome placeholder.
		// (The welcome view also kicks off library-stats fetches via
		// dedicated multiSessionKeys; those shouldn't be confused with
		// any browse-navigation call.)
		render(LibraryPage);
		await tick();

		const navCalls = apiBrowse.mock.calls.filter(
			([, opts]) => !opts.multiSessionKey?.startsWith('welcome-stats')
		);
		expect(navCalls).toHaveLength(0);
		// Welcome view is rendered (label "Artists" appears in stat tiles
		// — match the "Pick something from Explore" hint instead).
		expect(screen.getByText(/Pick something from/i)).toBeInTheDocument();
	});

	it('with browse-rooted history, pops to root then walks each step', async () => {
		pushHistory({ hierarchy: 'browse', itemKey: 'k1' });
		pushHistory({ hierarchy: 'browse', itemKey: 'k2' });

		// Three calls expected: popAll + step1 + step2.
		apiBrowse.mockResolvedValueOnce(listResult({ level: 0 }));
		apiBrowse.mockResolvedValueOnce(listResult({ level: 1 }));
		apiBrowse.mockResolvedValueOnce(listResult({ level: 2 }));

		render(LibraryPage);

		await waitFor(() => {
			expect(apiBrowse).toHaveBeenCalledTimes(3);
		});

		expect(apiBrowse.mock.calls[0][1]).toEqual(
			expect.objectContaining({ hierarchy: 'browse', popAll: true })
		);
		expect(apiBrowse.mock.calls[1][1]).toEqual(
			expect.objectContaining({ hierarchy: 'browse', itemKey: 'k1' })
		);
		expect(apiBrowse.mock.calls[2][1]).toEqual(
			expect.objectContaining({ hierarchy: 'browse', itemKey: 'k2' })
		);
	});

	it('with search-rooted history + saved query, re-seeds search root and clears stale drill steps', async () => {
		pushHistory(
			{ hierarchy: 'search', itemKey: 's1', multiSessionKey: 'library-search' },
			'beatles'
		);

		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				title: 'Search',
				items: [makeItem({ title: 'Artists', itemKey: 'fresh-artists' })]
			})
		); // re-seed

		render(LibraryPage);

		await waitFor(() => {
			expect(apiBrowse).toHaveBeenCalledTimes(1);
		});

		expect(apiBrowse.mock.calls[0][1]).toEqual(
			expect.objectContaining({
				hierarchy: 'search',
				input: 'beatles',
				popAll: true,
				multiSessionKey: 'library-search'
			})
		);
		expect(apiBrowse.mock.calls.some(([, opts]) => opts.itemKey === 's1')).toBe(false);
		expect(await screen.findByText('Artists')).toBeInTheDocument();
		expect(get(browseHistoryStore).history).toEqual([]);
	});

	it('with search-rooted history but no saved query, falls back to browse root and clears history', async () => {
		// pushHistory without a searchQuery on a fresh store leaves
		// `searchQuery: null` while still pushing a search-hierarchy step
		// — exactly the corrupted state restoreBrowse is supposed to
		// detect. (Writing sessionStorage directly here would not work
		// because browseHistoryStore reads persisted state at module
		// init, before any test body runs.)
		pushHistory({ hierarchy: 'search', itemKey: 's1', multiSessionKey: 'library-search' });
		expect(get(browseHistoryStore).searchQuery).toBe(null);

		render(LibraryPage);

		await waitFor(() => {
			expect(apiBrowse).toHaveBeenCalledTimes(1);
		});
		expect(apiBrowse.mock.calls[0][1]).toEqual(
			expect.objectContaining({ hierarchy: 'browse', popAll: true })
		);
		// History was cleared as part of the fallback.
		expect(get(browseHistoryStore).history).toEqual([]);
	});

	it('forwards the selected zone into both the popAll and the replay step', async () => {
		setSelectedZone('zone-living-room');
		// Saved step has no zoneId of its own — restoreBrowse must inject
		// the active selection so the Roon session lands on the right
		// zone-or-output context for the replay.
		pushHistory({ hierarchy: 'browse', itemKey: 'albums' });

		apiBrowse.mockResolvedValueOnce(listResult({ level: 0 }));
		apiBrowse.mockResolvedValueOnce(listResult({ level: 1 }));

		render(LibraryPage);
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(2));

		// popAll call
		expect(apiBrowse.mock.calls[0][1]).toEqual(
			expect.objectContaining({ hierarchy: 'browse', popAll: true, zoneId: 'zone-living-room' })
		);
		// replay step
		expect(apiBrowse.mock.calls[1][1]).toEqual(
			expect.objectContaining({ hierarchy: 'browse', itemKey: 'albums', zoneId: 'zone-living-room' })
		);
	});

	it('renders the items returned by the restore', async () => {
		// Push a history anchor so restoreBrowse runs the popAll + walk
		// path (empty history would render welcome instead).
		pushHistory({ hierarchy: 'browse', itemKey: 'anchor' });
		apiBrowse.mockResolvedValueOnce(listResult({ level: 0 })); // popAll
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [
					makeItem({ title: 'Albums', itemKey: 'albums' }),
					makeItem({ title: 'Artists', itemKey: 'artists' })
				]
			})
		); // walk

		render(LibraryPage);

		expect(await screen.findByText('Albums')).toBeInTheDocument();
		expect(await screen.findByText('Artists')).toBeInTheDocument();
	});

	describe('search-rooted history with breadcrumbs', () => {
		// Re-walks a deep search drill after re-seed by matching saved
		// breadcrumbs against the freshly-loaded results at each level.
		// Persisted itemKeys are stale (Roon mints new ones on every search
		// re-seed), so each successful drill must use the FRESH key from
		// the just-loaded result list — not the persisted one.

		it('replays a one-step search drill via breadcrumb match using the FRESH itemKey', async () => {
			pushHistory(
				{ hierarchy: 'search', itemKey: 'stale-album-key', multiSessionKey: 'library-search' },
				'beatles',
				{ title: 'Abbey Road', subtitle: 'The Beatles', itemType: 'album' }
			);

			// 1st apiBrowse: re-seed search; returns the same album under a
			// fresh itemKey.
			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 0,
					title: 'Search',
					items: [
						makeItem({
							title: 'Abbey Road',
							subtitle: 'The Beatles',
							itemKey: 'fresh-album-key',
							itemType: 'album'
						}),
						makeItem({
							title: 'Other Album',
							subtitle: 'The Beatles',
							itemKey: 'fresh-other-key',
							itemType: 'album'
						})
					]
				})
			);
			// 2nd apiBrowse: drill into the album (after breadcrumb match).
			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 1,
					title: 'Abbey Road',
					items: [makeItem({ title: '1. Come Together', itemKey: 't1', hint: 'action_list' })]
				})
			);

			render(LibraryPage);
			await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(2));

			// Re-seed used the saved query.
			expect(apiBrowse.mock.calls[0][1]).toEqual(
				expect.objectContaining({ hierarchy: 'search', input: 'beatles', popAll: true })
			);
			// Drill used the FRESH itemKey, not the persisted stale one.
			expect(apiBrowse.mock.calls[1][1]).toEqual(
				expect.objectContaining({ itemKey: 'fresh-album-key' })
			);
			expect(
				apiBrowse.mock.calls.some(([, opts]) => opts.itemKey === 'stale-album-key')
			).toBe(false);

			// Persisted history was rewritten with the fresh itemKey so a
			// later Forward (after Back) doesn't send Roon stale keys.
			await tick();
			const persisted = get(browseHistoryStore).history;
			expect(persisted).toHaveLength(1);
			expect(persisted[0].itemKey).toBe('fresh-album-key');
		});

		it('walks two drill levels in sequence', async () => {
			pushHistory(
				{ hierarchy: 'search', itemKey: 'stale-album-key', multiSessionKey: 'library-search' },
				'beatles',
				{ title: 'Abbey Road', subtitle: 'The Beatles', itemType: 'album' }
			);
			pushHistory(
				{ hierarchy: 'search', itemKey: 'stale-track-key', multiSessionKey: 'library-search' },
				'beatles',
				{ title: '1. Come Together', itemType: 'track' }
			);

			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 0,
					items: [
						makeItem({
							title: 'Abbey Road',
							subtitle: 'The Beatles',
							itemKey: 'fresh-album-key',
							itemType: 'album'
						})
					]
				})
			);
			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 1,
					items: [
						makeItem({
							title: '1. Come Together',
							itemKey: 'fresh-track-key',
							itemType: 'track',
							hint: 'action_list'
						})
					]
				})
			);
			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 2,
					items: [makeItem({ title: 'Play Now', itemKey: 'pn', hint: 'action' })]
				})
			);

			render(LibraryPage);
			await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(3));

			expect(apiBrowse.mock.calls[1][1]).toEqual(
				expect.objectContaining({ itemKey: 'fresh-album-key' })
			);
			expect(apiBrowse.mock.calls[2][1]).toEqual(
				expect.objectContaining({ itemKey: 'fresh-track-key' })
			);

			await tick();
			const persisted = get(browseHistoryStore).history;
			expect(persisted.map((s) => s.itemKey)).toEqual(['fresh-album-key', 'fresh-track-key']);
		});

		it('stops walking when a breadcrumb no longer matches any current item', async () => {
			pushHistory(
				{ hierarchy: 'search', itemKey: 'stale-album-key', multiSessionKey: 'library-search' },
				'beatles',
				{ title: 'Abbey Road', subtitle: 'The Beatles', itemType: 'album' }
			);

			// Re-seed returns a different album — breadcrumb won't match.
			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 0,
					items: [
						makeItem({
							title: 'Let It Be',
							subtitle: 'The Beatles',
							itemKey: 'fresh-let-it-be',
							itemType: 'album'
						})
					]
				})
			);

			render(LibraryPage);
			await tick();
			// 

			// No drill call, history truncated, feedback toast pushed.
			expect(apiBrowse).toHaveBeenCalledTimes(1);
			expect(get(browseHistoryStore).history).toEqual([]);
			const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
			expect(get(commandFeedbackStore)?.message).toMatch(/Abbey Road.*no longer/);
		});

		it('stops at the deepest matched step when a later breadcrumb fails', async () => {
			pushHistory(
				{ hierarchy: 'search', itemKey: 'stale-a', multiSessionKey: 'library-search' },
				'beatles',
				{ title: 'Abbey Road', subtitle: 'The Beatles', itemType: 'album' }
			);
			pushHistory(
				{ hierarchy: 'search', itemKey: 'stale-t', multiSessionKey: 'library-search' },
				'beatles',
				{ title: '1. Come Together', itemType: 'track' }
			);

			// Re-seed returns Abbey Road (first breadcrumb matches).
			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 0,
					items: [
						makeItem({
							title: 'Abbey Road',
							subtitle: 'The Beatles',
							itemKey: 'fresh-a',
							itemType: 'album'
						})
					]
				})
			);
			// Drill into album returns DIFFERENT tracks (second breadcrumb fails).
			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 1,
					items: [
						makeItem({
							title: '1. Something Else',
							itemKey: 'wrong-track',
							itemType: 'track',
							hint: 'action_list'
						})
					]
				})
			);

			render(LibraryPage);
			await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(2));
			await tick();

			// History truncated to just the album (the deepest successful step).
			const persisted = get(browseHistoryStore).history;
			expect(persisted).toHaveLength(1);
			expect(persisted[0].itemKey).toBe('fresh-a');
			const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
			expect(get(commandFeedbackStore)?.message).toMatch(/Come Together.*no longer/);
		});

		it('legacy steps without breadcrumb stop replay (no remap possible)', async () => {
			// pushHistory with no breadcrumb — represents a step persisted
			// before the v3 schema (sanitized in by the store but with no
			// way to recover its key).
			pushHistory(
				{ hierarchy: 'search', itemKey: 'stale', multiSessionKey: 'library-search' },
				'beatles'
			);

			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 0,
					items: [makeItem({ title: 'Anything', itemKey: 'fresh' })]
				})
			);

			render(LibraryPage);
			await tick();
			//

			// Stops at search root, history cleared, toast surfaced.
			expect(apiBrowse).toHaveBeenCalledTimes(1);
			expect(get(browseHistoryStore).history).toEqual([]);
			const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
			expect(get(commandFeedbackStore)?.message).toMatch(/breadcrumb/);
		});

		it('matches breadcrumb across singular/plural and case differences in itemType', async () => {
			// Persisted breadcrumb has the singular `'album'` (e.g. from
			// the play-bar resolver storing the expected type, or from a
			// prior session that recorded a different casing). Live
			// search returns the same album with `itemType: 'Albums'`.
			// Match should still succeed.
			pushHistory(
				{ hierarchy: 'search', itemKey: 'stale-album-key', multiSessionKey: 'library-search' },
				'abbey road',
				{ title: 'Abbey Road', subtitle: 'The Beatles', itemType: 'album' }
			);

			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 0,
					items: [
						makeItem({
							title: 'Abbey Road',
							subtitle: 'The Beatles',
							itemKey: 'fresh-album-key',
							itemType: 'Albums' // ← capitalized plural
						})
					]
				})
			);
			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 1,
					items: [makeItem({ title: 'Come Together', itemKey: 't1', hint: 'action_list' })]
				})
			);

			render(LibraryPage);
			await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(2));

			// Drill used the FRESH itemKey — the normalizer accepted the
			// plural/case variant during the breadcrumb compare.
			expect(apiBrowse.mock.calls[1][1]).toEqual(
				expect.objectContaining({ itemKey: 'fresh-album-key' })
			);
		});
	});
});

describe('Library page — navigation actions', () => {
	it('clicking a list item emits browse:browse with the item key and records history', async () => {
		// Bypass mount restore — page renders these items directly.
		setBrowseResult(
			listResult({
				level: 0,
				items: [makeItem({ title: 'Albums', itemKey: 'albums' })]
			}),
			'browse'
		);

		render(LibraryPage);
		const albums = await screen.findByText('Albums');
		albums.closest('button')?.click();
		await tick();

		expect(fakeSocket.emit).toHaveBeenCalledWith(
			'browse:browse',
			expect.objectContaining({ hierarchy: 'browse', itemKey: 'albums' })
		);
		expect(get(browseHistoryStore).history.map((s) => s.itemKey)).toEqual(['albums']);
	});

	it('clicking a search result re-seeds search and browses the fresh item key', async () => {
		render(LibraryPage);
		await tick();

		setSearchLoading('tori amos');
		setSearchResults([
			makeSearchResult({
				resultType: 'album',
				itemType: 'album',
				title: 'Little Earthquakes',
				subtitle: 'Tori Amos',
				itemKey: 'old-search-key'
			})
		]);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Little Earthquakes',
						subtitle: 'Tori Amos',
						itemType: 'album',
						itemKey: 'fresh-search-key'
					})
				]
			})
		);
		await tick();

		screen.getByText('Little Earthquakes').closest('button')?.click();

		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(1));
		expect(apiBrowse.mock.calls[0][1]).toEqual(
			expect.objectContaining({
				hierarchy: 'search',
				input: 'tori amos',
				popAll: true,
				multiSessionKey: 'library-search'
			})
		);
		await waitFor(() => {
			expect(fakeSocket.emit).toHaveBeenCalledWith(
				'browse:browse',
				expect.objectContaining({
					hierarchy: 'search',
					itemKey: 'fresh-search-key',
					multiSessionKey: 'library-search'
				})
			);
		});
		expect(fakeSocket.emit).not.toHaveBeenCalledWith(
			'browse:browse',
			expect.objectContaining({ itemKey: 'old-search-key' })
		);
		expect(get(browseHistoryStore).history.map((s) => s.itemKey)).toEqual(['fresh-search-key']);
	});

	it('search track quickPlay re-seeds search before action lookup', async () => {
		setSelectedZone('zone-living-room');
		render(LibraryPage);
		await tick();

		setSearchLoading('tori amos');
		setSearchResults([
			makeSearchResult({
				resultType: 'track',
				itemType: 'track',
				title: 'Cornflake Girl',
				subtitle: 'Tori Amos',
				itemKey: 'old-track-key',
				hint: 'action_list'
			})
		]);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Cornflake Girl',
						subtitle: 'Tori Amos',
						itemType: 'track',
						itemKey: 'fresh-track-key',
						hint: 'action_list'
					})
				]
			})
		);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [makeItem({ title: 'Play Now', itemKey: 'play-now-key', hint: 'action', isPlayable: true })]
			})
		);
		apiBrowse.mockResolvedValueOnce(listResult({ level: 1 }));
		await tick();

		screen.getByText('Cornflake Girl').closest('button')?.click();

		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(3));
		expect(apiBrowse.mock.calls[1][1]).toEqual(
			expect.objectContaining({
				hierarchy: 'search',
				itemKey: 'fresh-track-key',
				zoneId: 'zone-living-room',
				multiSessionKey: 'library-search'
			})
		);
		expect(apiBrowse.mock.calls[1][1]).not.toEqual(
			expect.objectContaining({ itemKey: 'old-track-key' })
		);
	});

	it('navigates non-track action_list search results instead of quick-playing them', async () => {
		render(LibraryPage);
		await tick();

		setSearchLoading('tori amos');
		setSearchResults([
			makeSearchResult({
				resultType: 'album',
				itemType: 'album',
				title: 'Boys for Pele',
				subtitle: 'Tori Amos',
				itemKey: 'old-album-key',
				hint: 'action_list'
			})
		]);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Boys for Pele',
						subtitle: 'Tori Amos',
						itemType: 'album',
						itemKey: 'fresh-album-key',
						hint: 'action_list'
					})
				]
			})
		);
		await tick();

		screen.getByText('Boys for Pele').closest('button')?.click();

		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(1));
		await waitFor(() => {
			expect(fakeSocket.emit).toHaveBeenCalledWith(
				'browse:browse',
				expect.objectContaining({
					hierarchy: 'search',
					itemKey: 'fresh-album-key',
					multiSessionKey: 'library-search'
				})
			);
		});
	});

	it('navigates a track search result that is NOT an action_list (no quickPlay)', async () => {
		// handleSearchResultClick only quick-plays tracks with
		// hint === 'action_list'. A track result with a different
		// hint must drill via navigateSearchResult instead — and
		// because Search renders every result type through ItemGrid
		// (a plain card, no "Play" button), the click affordance
		// doesn't misrepresent the action.
		render(LibraryPage);
		await tick();

		setSearchLoading('tori amos');
		setSearchResults([
			makeSearchResult({
				resultType: 'track',
				itemType: 'track',
				title: 'Winter',
				subtitle: 'Tori Amos',
				itemKey: 'old-track-key',
				hint: 'list'
			})
		]);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Winter',
						subtitle: 'Tori Amos',
						itemType: 'track',
						itemKey: 'fresh-track-key',
						hint: 'list'
					})
				]
			})
		);
		await tick();

		screen.getByText('Winter').closest('button')?.click();

		// One apiBrowse call — the navigateSearchResult re-seed/freshen.
		// quickPlay would have chained an action-list lookup (2+ calls).
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(1));
		await waitFor(() => {
			expect(fakeSocket.emit).toHaveBeenCalledWith(
				'browse:browse',
				expect.objectContaining({
					hierarchy: 'search',
					itemKey: 'fresh-track-key',
					multiSessionKey: 'library-search'
				})
			);
		});
	});

	it('Home (browseNavStore.home) resets history and renders the welcome view', async () => {
		// Seed prior history so we can confirm it gets cleared.
		pushHistory({ hierarchy: 'browse', itemKey: 'deep' });
		apiBrowse.mockResolvedValueOnce(listResult({ level: 0 })); // mount popAll
		apiBrowse.mockResolvedValueOnce(listResult({ level: 1 })); // mount step

		render(LibraryPage);
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(2));

		// Home no longer pops the Roon browse root (the rail already
		// shows it). Resets history + clears browseStore so the welcome
		// view renders.
		const { browseNavStore } = await import('$lib/stores/browseNavStore');
		const nav = get(browseNavStore);

		const emitCountBefore = fakeSocket.emit.mock.calls.length;
		nav.home();
		await tick();

		// History cleared, no browse:browse emitted, welcome renders.
		expect(get(browseHistoryStore).history).toEqual([]);
		expect(get(browseHistoryStore).forward).toEqual([]);
		expect(fakeSocket.emit.mock.calls.length).toBe(emitCountBefore);
		expect(screen.getByText(/Pick something from/i)).toBeInTheDocument();
	});

	it('Back (browseNavStore.back) calls browse:pop and moves the step to forward', async () => {
		render(LibraryPage);
		await tick();

		// Simulate the user clicking into one item so there's something
		// to back out of.
		pushHistory({ hierarchy: 'browse', itemKey: 'albums' });

		const { browseNavStore } = await import('$lib/stores/browseNavStore');
		const nav = get(browseNavStore);
		nav.back();
		await tick();

		expect(fakeSocket.emit).toHaveBeenCalledWith(
			'browse:pop',
			expect.objectContaining({ hierarchy: expect.any(String) })
		);
		const state = get(browseHistoryStore);
		expect(state.history).toEqual([]);
		expect(state.forward.map((s) => s.itemKey)).toEqual(['albums']);
	});

	it('searchLoading hides the result panel and shows the loading text', async () => {
		render(LibraryPage);
		await tick();

		// Direct loading toggle covers what setBrowseLoading does on the
		// browse panel — the Library page's results-panel switches to the
		// "Loading library data..." copy.
		const { setBrowseLoading } = await import('$lib/stores/browseStore');
		setBrowseLoading('browse');
		await tick();

		expect(await screen.findByText(/loading library data/i)).toBeInTheDocument();
	});

	it('disconnected click on a search result preserves prior browse hierarchy and history', async () => {
		// Reproduces R6 finding #1: a search-result click resets
		// history and commits hierarchy='search' before the actual
		// browse emit. If the socket is disconnected when the emit
		// would fire, prior browse history must NOT be cleared and
		// hierarchy must NOT switch — otherwise subsequent clicks
		// send browse-session itemKeys against the search session.

		// Mount first so restoreBrowse runs against empty history
		// (early-return). Then set up "prior browse state" via direct
		// store mutations — avoids racing the mount restore.
		render(LibraryPage);
		await tick();

		pushHistory({ hierarchy: 'browse', itemKey: 'albums-key' }, undefined, {
			title: 'Albums'
		});
		setBrowseResult(
			listResult({
				level: 1,
				items: [makeItem({ title: 'Some Album', itemKey: 'album-1' })]
			}),
			'browse'
		);

		// Stage a search result + disconnect.
		setSearchLoading('beatles');
		setSearchResults([
			makeSearchResult({
				resultType: 'album',
				itemType: 'album',
				title: 'Abbey Road',
				subtitle: 'The Beatles',
				itemKey: 'fresh-search-key'
			})
		]);
		// Re-seed-search REST call (still works even with socket
		// disconnected — different transport).
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Abbey Road',
						subtitle: 'The Beatles',
						itemKey: 'fresh-search-key',
						itemType: 'album'
					})
				]
			})
		);

		fakeSocket.connected = false;
		await tick();

		const tile = await screen.findByText('Abbey Road');
		tile.closest('button')?.click();
		// Wait until the navigateSearchResult async chain has reached
		// the post-freshen readiness check (clears loading on the
		// disconnected path). Polling on loading=false is sturdier
		// than counting ticks across the await chain.
		await waitFor(() => {
			expect(apiBrowse).toHaveBeenCalledTimes(1);
			expect(get(browseStore).loading).toBe(false);
		});

		// browse:browse emit was skipped (readiness check rejected).
		expect(fakeSocket.emit).not.toHaveBeenCalledWith(
			'browse:browse',
			expect.anything()
		);

		// Prior browse history preserved — not reset.
		expect(get(browseHistoryStore).history.map((s) => s.itemKey)).toEqual([
			'albums-key'
		]);

		// Hierarchy did NOT switch to 'search'.
		expect(get(browseStore).hierarchy).toBe('browse');

		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message).toMatch(/Not connected/i);
	});

	it('disconnected search-track quickPlay fallback preserves existing history and emits nothing', async () => {
		// R8 finding #1: quickPlay's no-play-action fallback runs
		// `if (options.resetSearch) resetHistory()` BEFORE the fallback
		// browse(). With resetSearch=true (search-track click) and a
		// socket that drops between the REST action lookup and the
		// fallback emit, the old code wiped the prior history while
		// browse() bailed on its own readiness check — losing user
		// state for navigation that never happened.

		// Mount, then seed prior browse history + a search result.
		render(LibraryPage);
		await tick();

		pushHistory({ hierarchy: 'browse', itemKey: 'albums-key' }, undefined, {
			title: 'Albums'
		});
		setSelectedZone('zone-a');
		setSearchLoading('tori amos');
		setSearchResults([
			makeSearchResult({
				resultType: 'track',
				itemType: 'track',
				title: 'Cornflake Girl',
				subtitle: 'Tori Amos',
				itemKey: 'stale-track-key',
				hint: 'action_list'
			})
		]);
		// freshenSearchItem REST call → fresh track itemKey.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Cornflake Girl',
						subtitle: 'Tori Amos',
						itemType: 'track',
						itemKey: 'fresh-track-key',
						hint: 'action_list'
					})
				]
			})
		);
		// Action lookup returns no playable action → fallback path.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [makeItem({ title: 'Metadata only', itemKey: 'm', hint: 'list', isPlayable: false })]
			})
		);

		fakeSocket.connected = false;
		await tick();

		screen.getByText('Cornflake Girl').closest('button')?.click();

		// Wait for both REST calls (freshen + action lookup) to land.
		await waitFor(() => {
			expect(apiBrowse).toHaveBeenCalledTimes(2);
		});

		// Fallback emit was skipped (readiness check rejected).
		expect(fakeSocket.emit).not.toHaveBeenCalledWith(
			'browse:browse',
			expect.anything()
		);
		// Prior history preserved — resetHistory did NOT run.
		expect(get(browseHistoryStore).history.map((s) => s.itemKey)).toEqual([
			'albums-key'
		]);

		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message).toMatch(/Not connected/i);
	});

	it('clicking a list item while disconnected clears loading and does NOT record history', async () => {
		// Simulate the socket dropping (object exists, .connected = false).
		// emitIfConnected's path: skip emit, push feedback toast, return
		// false. browse() must clear the optimistic loading flag and
		// skip pushHistory so the user doesn't end up with a ghost
		// history entry for navigation that never happened.
		fakeSocket.connected = false;

		setBrowseResult(
			listResult({
				level: 0,
				items: [makeItem({ title: 'Albums', itemKey: 'albums' })]
			}),
			'browse'
		);

		render(LibraryPage);
		const albums = await screen.findByText('Albums');
		albums.closest('button')?.click();
		await tick();

		// emit was never called (disconnected guard).
		expect(fakeSocket.emit).not.toHaveBeenCalledWith(
			'browse:browse',
			expect.anything()
		);

		// browseStore is no longer in loading state.
		expect(get(browseStore).loading).toBe(false);

		// History was NOT mutated — no ghost entry.
		expect(get(browseHistoryStore).history).toEqual([]);

		// Feedback toast surfaced the disconnect.
		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message).toMatch(/Not connected/i);
	});

	it('disconnected Back with empty history + non-empty forward does NOT pull stale forward into history', async () => {
		// Reproduces R6 finding #2 (now-resolved by the readiness-first
		// pattern in pop()): if Back is somehow triggered while history
		// is empty (defensive — nav store usually disables the button)
		// and forward has a stale entry, the disconnected click must
		// not "rollback" by popping that stale forward into history.
		//
		// Set up: empty history, populated forward stack. We push +
		// pop to land in this state.
		pushHistory({ hierarchy: 'browse', itemKey: 'k1' }, undefined, { title: 'A' });
		popHistory(); // moves k1 from history → forward
		expect(get(browseHistoryStore).history).toEqual([]);
		expect(get(browseHistoryStore).forward.map((s) => s.itemKey)).toEqual(['k1']);

		fakeSocket.connected = false;
		render(LibraryPage);
		await tick();

		// Drive Back directly via the nav store — simulates the
		// "somehow triggered" path.
		const { browseNavStore } = await import('$lib/stores/browseNavStore');
		const nav = get(browseNavStore);
		nav.back();
		await tick();

		// Connection check rejected the click before any mutation.
		expect(fakeSocket.emit).not.toHaveBeenCalledWith(
			'browse:pop',
			expect.anything()
		);
		// History still empty, forward stack untouched (stale entry
		// did NOT get promoted into history).
		expect(get(browseHistoryStore).history).toEqual([]);
		expect(get(browseHistoryStore).forward.map((s) => s.itemKey)).toEqual(['k1']);
	});

	it('disconnected Forward with non-empty forward stack preserves both stacks and emits nothing', async () => {
		// R7 finding #1: forward() must not move an entry from the
		// forward stack to history if the emit will be rejected. The
		// readiness check has to run BEFORE popForward(), otherwise a
		// disconnected click leaves a ghost history entry pointing at
		// a destination the user never reached.
		//
		// Set up: empty history, populated forward stack (push + pop
		// puts the entry on the forward side).
		pushHistory({ hierarchy: 'browse', itemKey: 'fwd-key' }, undefined, { title: 'Forward Target' });
		popHistory();
		expect(get(browseHistoryStore).history).toEqual([]);
		expect(get(browseHistoryStore).forward.map((s) => s.itemKey)).toEqual(['fwd-key']);

		fakeSocket.connected = false;
		render(LibraryPage);
		await tick();

		// Drive Forward through the nav store the same way the play
		// bar's Forward button does.
		const { browseNavStore } = await import('$lib/stores/browseNavStore');
		get(browseNavStore).forward();
		await tick();

		// Readiness check rejected the click — no emit issued.
		expect(fakeSocket.emit).not.toHaveBeenCalledWith(
			'browse:browse',
			expect.anything()
		);
		// Both stacks unchanged — the forward entry was NOT promoted
		// into history.
		expect(get(browseHistoryStore).history).toEqual([]);
		expect(get(browseHistoryStore).forward.map((s) => s.itemKey)).toEqual(['fwd-key']);
	});
});

describe('Library page — quickPlay', () => {
	function setUpRoot(items: BrowseItem[] = []) {
		// The Library page no longer pops to root on empty-history mount
		// (renders welcome instead). Bypass the mount restore by setting
		// the browse result directly — `apiBrowse` then starts at index
		// [0] for whatever the test's first user action emits.
		setBrowseResult(listResult({ level: 0, items }), 'browse');
	}

	it('looks up the action list, executes the play action, then pops the album view back', async () => {
		const track = makeItem({ title: 'Play Album', itemKey: 'track-key', hint: 'action_list' });
		setUpRoot([track]);
		// Action-list lookup returns Play Now as a playable action.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [makeItem({ title: 'Play Now', itemKey: 'play-now-key', hint: 'action', isPlayable: true })]
			})
		);
		// Execute call returns nothing meaningful — quickPlay ignores its result.
		apiBrowse.mockResolvedValueOnce(listResult({ level: 1 }));

		setSelectedZone('zone-living-room');
		render(LibraryPage);
		const btn = await screen.findByRole('button', { name: 'Play Album' });
		btn.click();

		// Wait for the action lookup + execute calls.
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(2));

		expect(apiBrowse.mock.calls[0][1]).toEqual(
			expect.objectContaining({
				hierarchy: 'browse',
				itemKey: 'track-key',
				zoneId: 'zone-living-room'
			})
		);
		expect(apiBrowse.mock.calls[1][1]).toEqual(
			expect.objectContaining({
				hierarchy: 'browse',
				itemKey: 'play-now-key',
				zoneId: 'zone-living-room'
			})
		);
		// In browse hierarchy, quickPlay restores the album view via socket pop.
		await waitFor(() => {
			expect(fakeSocket.emit).toHaveBeenCalledWith(
				'browse:pop',
				expect.objectContaining({ hierarchy: expect.any(String) })
			);
		});
	});

	it('falls back to navigate when no play action is found', async () => {
		const track = makeItem({ title: 'Play Album', itemKey: 'track-key', hint: 'action_list' });
		setUpRoot([track]);
		// Action lookup returns no playable action — only loadable items.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [makeItem({ title: 'Some metadata', itemKey: 'meta', hint: 'list', isPlayable: false })]
			})
		);

		setSelectedZone('zone-living-room');
		render(LibraryPage);
		const btn = await screen.findByRole('button', { name: 'Play Album' });
		btn.click();
		await tick();
		// 

		// Fallback path emits browse:browse via socket and records history.
		expect(fakeSocket.emit).toHaveBeenCalledWith(
			'browse:browse',
			expect.objectContaining({ itemKey: 'track-key' })
		);
		expect(get(browseHistoryStore).history.map((s) => s.itemKey)).toEqual(['track-key']);
	});

	it('falls back to action-menu navigation when the album resolver finds no match', async () => {
		const playWork = makeItem({ title: 'Play Work', itemKey: 'play-work-key', hint: 'action_list' });
		const albumRef = makeItem({
			title: 'On Ocean to Ocean by Tori Amos',
			subtitle: 'Tori Amos',
			itemKey: 'album-ref-key',
			hint: 'action_list'
		});
		setUpRoot([playWork, albumRef]);
		// Resolver search returns no album match — fallback path triggers.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [makeItem({ title: 'Unrelated', itemType: 'album', itemKey: 'other' })]
			})
		);

		// Leave zone unselected. If this path accidentally uses quickPlay,
		// it will bail before emitting because quickPlay requires a zone.
		setSelectedZone('');
		render(LibraryPage);
		const btn = await screen.findByRole('button', { name: 'On Ocean to Ocean by Tori Amos' });
		btn.click();
		await tick();
		// 

		// Sole apiBrowse call is the resolver search.
		expect(apiBrowse.mock.calls[0][1]).toEqual(
			expect.objectContaining({ hierarchy: 'search', input: 'On Ocean to Ocean' })
		);
		// Resolver missed; falls back to navigate(item) → emits browse:browse
		// with the contextual row's own itemKey, opening Roon's action menu.
		expect(fakeSocket.emit).toHaveBeenCalledWith(
			'browse:browse',
			expect.objectContaining({ hierarchy: 'browse', itemKey: 'album-ref-key' })
		);
		expect(get(browseHistoryStore).history.map((s) => s.itemKey)).toEqual(['album-ref-key']);
	});

	it('disconnected "album by artist" fallback clears loading and emits nothing', async () => {
		// R7 finding #2: resolveAlbumOrNavigate sets loading up front
		// (so the spinner appears while the resolver search runs).
		// When the resolver misses, it falls back to navigate(item) →
		// browse(). If the socket is disconnected at that point, browse()
		// bails on the readiness check without ever clearing the
		// loading flag — leaving the pane stuck on "Loading library
		// data…". Verify the fallback clears loading explicitly.
		const albumRef = makeItem({
			title: 'On Ocean to Ocean by Tori Amos',
			subtitle: 'Tori Amos',
			itemKey: 'album-ref-key',
			hint: 'action_list'
		});
		setUpRoot([albumRef]);
		// Resolver search returns no album match — fallback path triggers.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [makeItem({ title: 'Unrelated', itemType: 'album', itemKey: 'other' })]
			})
		);

		fakeSocket.connected = false;
		setSelectedZone('zone-a');
		render(LibraryPage);
		const btn = await screen.findByRole('button', { name: 'On Ocean to Ocean by Tori Amos' });
		btn.click();

		// Wait until the resolver chain has reached the fallback path
		// and cleared loading. Polling on loading=false is sturdier
		// than counting ticks across the await chain.
		await waitFor(() => {
			expect(apiBrowse).toHaveBeenCalledTimes(1);
			expect(get(browseStore).loading).toBe(false);
		});

		// Resolver search ran (HTTP, not socket — so it executed
		// despite the disconnect).
		expect(apiBrowse.mock.calls[0][1]).toEqual(
			expect.objectContaining({ hierarchy: 'search', input: 'On Ocean to Ocean' })
		);
		// browse:browse emit was skipped (readiness check rejected
		// the fallback navigate).
		expect(fakeSocket.emit).not.toHaveBeenCalledWith(
			'browse:browse',
			expect.anything()
		);
		// No ghost history entry from the failed fallback.
		expect(get(browseHistoryStore).history).toEqual([]);

		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message).toMatch(/Not connected/i);
	});

	it('jumps to the resolved album when the search match is a real album result', async () => {
		const albumRef = makeItem({
			title: 'On Ocean to Ocean by Tori Amos',
			itemKey: 'stale-context-key',
			hint: 'action_list'
		});
		setUpRoot([albumRef]);
		// Resolver search returns the album under a fresh search itemKey.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'On Ocean to Ocean',
						subtitle: 'Tori Amos',
						itemKey: 'fresh-album-key',
						itemType: 'album'
					})
				]
			})
		);

		setSelectedZone('zone-a');
		render(LibraryPage);
		const btn = await screen.findByRole('button', { name: 'On Ocean to Ocean by Tori Amos' });
		btn.click();
		await tick();
		// 

		// Resolver re-seeded the main search session with the album title.
		expect(apiBrowse.mock.calls[0][1]).toEqual(
			expect.objectContaining({
				hierarchy: 'search',
				input: 'On Ocean to Ocean',
				multiSessionKey: 'library-search'
			})
		);
		// Navigation goes through search hierarchy with the FRESH key.
		expect(fakeSocket.emit).toHaveBeenCalledWith(
			'browse:browse',
			expect.objectContaining({ hierarchy: 'search', itemKey: 'fresh-album-key' })
		);
		// History records the album step with its breadcrumb (so a future
		// remount can re-walk via breadcrumb).
		const persisted = get(browseHistoryStore).history;
		expect(persisted).toHaveLength(1);
		expect(persisted[0].itemKey).toBe('fresh-album-key');
		expect(persisted[0].breadcrumb).toEqual(
			expect.objectContaining({ title: 'On Ocean to Ocean', subtitle: 'Tori Amos', itemType: 'album' })
		);
	});

	it('rejects an album match whose subtitle does not contain the parsed artist', async () => {
		// Same album title, different artist — must not be confused.
		const albumRef = makeItem({
			title: 'Greatest Hits by Tori Amos',
			itemKey: 'stale',
			hint: 'action_list'
		});
		setUpRoot([albumRef]);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Greatest Hits',
						subtitle: 'Queen',
						itemKey: 'wrong-album',
						itemType: 'album'
					})
				]
			})
		);

		setSelectedZone('zone-a');
		render(LibraryPage);
		const btn = await screen.findByRole('button', { name: 'Greatest Hits by Tori Amos' });
		btn.click();
		await tick();
		// 

		// Wrong-artist match was rejected → fallback to navigate(item).
		expect(fakeSocket.emit).toHaveBeenCalledWith(
			'browse:browse',
			expect.objectContaining({ hierarchy: 'browse', itemKey: 'stale' })
		);
	});

	it('skips the resolver entirely for non-parseable titles (no "by")', async () => {
		const row = makeItem({
			title: 'Some Bonus Track',
			itemKey: 'bonus-key',
			hint: 'action_list'
		});
		setUpRoot([row]);

		setSelectedZone('zone-a');
		render(LibraryPage);
		const btn = await screen.findByRole('button', { name: 'Some Bonus Track' });
		btn.click();
		await tick();

		// Title isn't parseable — resolver skipped, no apiBrowse.
		expect(apiBrowse).not.toHaveBeenCalled();
		expect(fakeSocket.emit).toHaveBeenCalledWith(
			'browse:browse',
			expect.objectContaining({ itemKey: 'bonus-key' })
		);
	});

	it('pushes a feedback toast and skips REST calls when no zone is selected', async () => {
		const track = makeItem({ title: 'Play Album', itemKey: 'track-key', hint: 'action_list' });
		setUpRoot([track]);

		setSelectedZone('');
		render(LibraryPage);
		await tick();

		const btn = await screen.findByRole('button', { name: 'Play Album' });
		btn.click();
		await tick();

		// No apiBrowse calls — quickPlay bails before REST due to no zone.
		expect(apiBrowse).not.toHaveBeenCalled();

		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message).toMatch(/select a zone/i);
	});

	it('does not pop the album view after quickPlay from a search result', async () => {
		setSelectedZone('zone-living-room');
		render(LibraryPage);
		await tick();

		setSearchLoading('beatles');
		setSearchResults([
			makeSearchResult({
				resultType: 'track',
				itemType: 'track',
				title: 'Play Album',
				subtitle: 'The Beatles',
				itemKey: 'old-track-key',
				hint: 'action_list'
			})
		]);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Play Album',
						subtitle: 'The Beatles',
						itemType: 'track',
						itemKey: 'fresh-track-key',
						hint: 'action_list'
					})
				]
			})
		);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [makeItem({ title: 'Play Now', itemKey: 'pn', hint: 'action', isPlayable: true })]
			})
		);
		apiBrowse.mockResolvedValueOnce(listResult({ level: 1 }));

		await tick();
		screen.getByText('Play Album').closest('button')?.click();
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(3));
		await tick();

		// Should NOT have emitted browse:pop — search context doesn't restore.
		const popCalls = fakeSocket.emit.mock.calls.filter(([ev]) => ev === 'browse:pop');
		expect(popCalls).toHaveLength(0);
	});

	it('pushes a feedback toast when the action lookup REST call fails', async () => {
		const track = makeItem({ title: 'Play Album', itemKey: 'track-key', hint: 'action_list' });
		setUpRoot([track]);
		apiBrowse.mockRejectedValueOnce(new Error('Roon timed out'));

		setSelectedZone('zone-living-room');
		render(LibraryPage);
		const btn = await screen.findByRole('button', { name: 'Play Album' });
		btn.click();
		await tick();
		// 

		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message).toMatch(/Roon timed out/);
	});

	it('quick-plays explicit "Play …" rows even when Roon supplies a non-track itemType', async () => {
		// Regression for the C-5 follow-up: shouldQuickPlayActionList must
		// not block on a non-track itemType when the title is an explicit
		// play action. Roon may label `Play Work` with itemType `work` or
		// `action`; either should still trigger the action lookup +
		// Play Now flow, not fall through to navigate().
		const playWork = makeItem({
			title: 'Play Work',
			itemKey: 'work-key',
			hint: 'action_list',
			itemType: 'work'
		});
		setUpRoot([playWork]);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [
					makeItem({ title: 'Play Now', itemKey: 'pn', hint: 'action', isPlayable: true })
				]
			})
		);
		apiBrowse.mockResolvedValueOnce(listResult({ level: 1 }));

		setSelectedZone('zone-living-room');
		render(LibraryPage);
		const btn = await screen.findByRole('button', { name: 'Play Work' });
		btn.click();

		// 2 calls = action lookup + Play Now execute. If the regression
		// resurfaced, no apiBrowse would fire and `browse:browse` would
		// emit instead.
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(2));
		expect(apiBrowse.mock.calls[0][1]).toEqual(
			expect.objectContaining({ itemKey: 'work-key' })
		);
		expect(apiBrowse.mock.calls[1][1]).toEqual(
			expect.objectContaining({ itemKey: 'pn' })
		);
	});
});

describe('Library page — alphabetic jump bar', () => {
	function makeBrowseList(letters: string[]): BrowseItem[] {
		return letters.map((letter, i) =>
			makeItem({ title: `${letter}-Title-${i}`, itemKey: `k${i}`, hint: 'list' })
		);
	}

	beforeEach(() => {
		// jsdom doesn't implement scrollIntoView; stub it on the prototype
		// so the jump-bar handler doesn't throw.
		(Element.prototype as any).scrollIntoView = vi.fn();
	});

	it('renders a jump bar with one button per unique first letter (above 20-item threshold)', async () => {
		// 21 items spanning A-D so jumpLetters fires (threshold is >20)
		// and there are multiple distinct letters to verify.
		const items: BrowseItem[] = [];
		for (let i = 0; i < 6; i++) items.push(makeItem({ title: `A item ${i}`, itemKey: `a${i}` }));
		for (let i = 0; i < 6; i++) items.push(makeItem({ title: `B item ${i}`, itemKey: `b${i}` }));
		for (let i = 0; i < 6; i++) items.push(makeItem({ title: `C item ${i}`, itemKey: `c${i}` }));
		for (let i = 0; i < 3; i++) items.push(makeItem({ title: `D item ${i}`, itemKey: `d${i}` }));
		// Force level >= 2 so isContentList renders the grid path.
		setBrowseResult(listResult({ level: 2, items }), 'browse');

		render(LibraryPage);
		await tick();

		const jumpBar = await screen.findByLabelText(/alphabetic index/i);
		const letterButtons = jumpBar.querySelectorAll('button.jump-letter');
		const labels = Array.from(letterButtons).map((b) => b.textContent?.trim());
		expect(labels).toEqual(['A', 'B', 'C', 'D']);
	});

	it('does not render a jump bar for short lists (≤20 items)', async () => {
		const items = Array.from({ length: 10 }, (_, i) =>
			makeItem({ title: `Item ${i}`, itemKey: `k${i}` })
		);
		setBrowseResult(listResult({ level: 2, items }), 'browse');

		render(LibraryPage);
		await tick();

		expect(screen.queryByLabelText(/alphabetic index/i)).toBeNull();
	});

	it('clicking a letter scrolls to the section anchor when it is loaded', async () => {
		const items: BrowseItem[] = [];
		for (let i = 0; i < 6; i++) items.push(makeItem({ title: `A${i}`, itemKey: `a${i}` }));
		for (let i = 0; i < 6; i++) items.push(makeItem({ title: `B${i}`, itemKey: `b${i}` }));
		for (let i = 0; i < 9; i++) items.push(makeItem({ title: `C${i}`, itemKey: `c${i}` }));
		setBrowseResult(listResult({ level: 2, items }), 'browse');

		render(LibraryPage);
		await tick();

		const bButton = screen.getAllByRole('button').find((b) => b.textContent?.trim() === 'B');
		expect(bButton).toBeDefined();

		const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView');
		bButton!.click();
		// The handler is async — wait a microtask for the scroll call.
		await tick();
		await Promise.resolve();
		expect(scrollSpy).toHaveBeenCalled();
	});

	it('renders a Load more bar when loaded items < totalCount', async () => {
		const items = Array.from({ length: 21 }, (_, i) =>
			makeItem({ title: `Item ${i}`, itemKey: `k${i}` })
		);
		setBrowseResult(
			listResult({ level: 2, items, totalCount: 30, count: 30 }),
			'browse'
		);

		render(LibraryPage);
		await tick();

		expect(await screen.findByText(/showing 21 of 30/i)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /load more/i })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /load all/i })).toBeInTheDocument();
	});

	it('"Load more" calls apiBrowseLoad with the right offset/count and appends items', async () => {
		const initial = Array.from({ length: 21 }, (_, i) =>
			makeItem({ title: `Item ${i}`, itemKey: `k${i}` })
		);
		setBrowseResult(
			listResult({ level: 2, items: initial, totalCount: 100, count: 100 }),
			'browse'
		);
		const more = Array.from({ length: 79 }, (_, i) =>
			makeItem({ title: `Extra ${i}`, itemKey: `extra${i}` })
		);
		apiBrowseLoad.mockResolvedValueOnce(listResult({ level: 2, items: more.slice(0, 79) }));

		render(LibraryPage);
		await tick();

		screen.getByRole('button', { name: /^load more$/i }).click();
		await waitFor(() => expect(apiBrowseLoad).toHaveBeenCalled());

		expect(apiBrowseLoad.mock.calls[0][1]).toEqual(
			expect.objectContaining({
				hierarchy: 'browse',
				offset: 21,
				// "Load more" caps each batch at 100; remaining (79) is smaller, so count = 79.
				count: 79
			})
		);

		// Verify the appended items actually reach the DOM. Without this
		// assertion, a regression that removed the `appendBrowseItems(...)`
		// call after the fetch would still pass the args check above.
		expect(await screen.findByText('Extra 78')).toBeInTheDocument();
		// And the "Showing X of Y" footer should disappear once everything
		// is loaded (21 + 79 = 100, matches totalCount).
		await waitFor(() => {
			expect(screen.queryByText(/showing \d+ of \d+/i)).toBeNull();
		});
	});
});

describe('Library page — restore robustness', () => {
	it('records but does not crash when a replay step fails', async () => {
		pushHistory({ hierarchy: 'browse', itemKey: 'good' });
		pushHistory({ hierarchy: 'browse', itemKey: 'stale' });

		apiBrowse.mockResolvedValueOnce(listResult({ level: 0 })); // popAll
		apiBrowse.mockResolvedValueOnce(listResult({ level: 1 })); // good step
		apiBrowse.mockRejectedValueOnce(new Error('item_key not found')); // stale step

		render(LibraryPage);
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(3));

		// The page should not be in an error-banner state — it just stops
		// at the deepest successful step. The browseStore should hold the
		// last successful result (level 1), not the failed one.
		await tick();
		const current = get(browseStore).current;
		expect(current?.level).toBe(1);
	});

	it('walks browse-rooted history via breadcrumb when persisted itemKeys are stale (Roon Core restart)', async () => {
		// Persisted itemKeys minted before the Core restart are now
		// stale — drilling them returns "[BrowseService] browse failed".
		// Breadcrumb-walk path finds the same items by title against
		// the freshly-loaded results at each level.
		pushHistory(
			{ hierarchy: 'browse', itemKey: 'stale-library' },
			undefined,
			{ title: 'Library' }
		);
		pushHistory(
			{ hierarchy: 'browse', itemKey: 'stale-albums' },
			undefined,
			{ title: 'Albums' }
		);

		// popAll returns fresh root.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [makeItem({ title: 'Library', itemKey: 'fresh-library' })]
			})
		);
		// Fresh-library drill returns Library children incl. Albums.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [makeItem({ title: 'Albums', itemKey: 'fresh-albums' })]
			})
		);
		// Fresh-albums drill returns the album grid.
		apiBrowse.mockResolvedValueOnce(
			listResult({ level: 2, items: [makeItem({ title: 'Some Album' })] })
		);

		render(LibraryPage);
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(3));
		await tick();

		// Walk used FRESH keys, never stale ones.
		expect(apiBrowse.mock.calls[1][1]).toEqual(
			expect.objectContaining({ itemKey: 'fresh-library' })
		);
		expect(apiBrowse.mock.calls[2][1]).toEqual(
			expect.objectContaining({ itemKey: 'fresh-albums' })
		);
		expect(
			apiBrowse.mock.calls.some(
				([, opts]) =>
					opts.itemKey === 'stale-library' || opts.itemKey === 'stale-albums'
			)
		).toBe(false);

		// Persisted history rewritten with fresh keys.
		const persisted = get(browseHistoryStore).history;
		expect(persisted.map((s) => s.itemKey)).toEqual(['fresh-library', 'fresh-albums']);
	});

	it('clears history and shows welcome when even the first browse-rooted step fails', async () => {
		// Stale itemKey, no breadcrumb (legacy entry), and the raw
		// drill fails. Result: history wiped, browseStore reset, page
		// renders welcome instead of the rail-mirror at level 0.
		pushHistory({ hierarchy: 'browse', itemKey: 'totally-stale' });

		apiBrowse.mockResolvedValueOnce(listResult({ level: 0 })); // popAll
		apiBrowse.mockRejectedValueOnce(new Error('item_key not found')); // stale step

		render(LibraryPage);
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(2));
		await tick();

		expect(get(browseHistoryStore).history).toEqual([]);
		expect(get(browseStore).current).toBeNull();
		expect(screen.getByText(/Pick something from/i)).toBeInTheDocument();
	});
});

describe('Library page — track-list classification', () => {
	function setUpRoot(items: BrowseItem[]) {
		// Bypass the mount restore (which now renders welcome on empty
		// history) and inject the test result directly.
		setBrowseResult(listResult({ level: 2, items }), 'browse');
	}

	it('renders itemType=track items as a track list even without numeric prefixes', async () => {
		// Classical movements with no leading digit. Pre-itemType code
		// classified these as page actions because the regex saw no digit.
		const items = [
			makeItem({
				title: 'Allegro',
				itemKey: 't1',
				hint: 'action_list',
				itemType: 'track'
			}),
			makeItem({
				title: 'Andante',
				itemKey: 't2',
				hint: 'action_list',
				itemType: 'track'
			}),
			makeItem({
				title: 'Play Album',
				itemKey: 'pa',
				hint: 'action_list'
			})
		];
		setUpRoot(items);

		render(LibraryPage);
		await tick();
		// 

		// Tracks rendered in an <ol class="track-list">
		const trackList = document.querySelector('ol.track-list');
		expect(trackList).not.toBeNull();
		expect(trackList!.querySelectorAll('li.track-row')).toHaveLength(2);

		// "Play Album" rendered as a page action pill, not a track.
		expect(screen.getByRole('button', { name: 'Play Album' })).toBeTruthy();
		expect(screen.queryByText('Allegro')).toBeTruthy();
	});

	it('falls back to leading-digit regex when items omit itemType', async () => {
		// Legacy fixture: action_list rows whose only signal of "track-ness"
		// is a numbered title. The fallback path must still render them in
		// the track list.
		const items = [
			makeItem({ title: '1. First Song', itemKey: 't1', hint: 'action_list' }),
			makeItem({ title: '2. Second Song', itemKey: 't2', hint: 'action_list' }),
			makeItem({ title: 'Play Album', itemKey: 'pa', hint: 'action_list' })
		];
		setUpRoot(items);

		render(LibraryPage);
		await tick();
		// 

		const trackList = document.querySelector('ol.track-list');
		expect(trackList).not.toBeNull();
		expect(trackList!.querySelectorAll('li.track-row')).toHaveLength(2);
		expect(screen.getByRole('button', { name: 'Play Album' })).toBeTruthy();
	});

	it('does NOT treat a Work page (action_list-only, no tracks) as a track list', async () => {
		// Live regression: Composers → Tori Amos → 29 Years returns a Work
		// page where every item is action_list but none is a real track.
		// The contextual nav row "On Ocean to Ocean by Tori Amos" must not
		// be force-numbered into a track row.
		const items = [
			makeItem({
				title: 'Play Work',
				itemKey: 'pw',
				hint: 'action_list'
			}),
			makeItem({
				title: 'On Ocean to Ocean by Tori Amos',
				itemKey: 'al',
				hint: 'action_list'
			})
		];
		setUpRoot(items);

		render(LibraryPage);
		await tick();
		// 

		// No track list rendered; both items are page actions.
		expect(document.querySelector('ol.track-list')).toBeNull();
		expect(screen.getByRole('button', { name: 'Play Work' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'On Ocean to Ocean by Tori Amos' })).toBeTruthy();
	});

	it('classifies itemType case-insensitively (Track / TRACKS still render as tracks)', async () => {
		// Defensive: BrowseService passes Roon's `item_type` through raw,
		// and `inferSearchType` already lowercases for comparison. Mirror
		// that style so a non-canonical casing doesn't silently demote a
		// track row into a pill button.
		const items = [
			makeItem({
				title: 'First Movement',
				itemKey: 't1',
				hint: 'action_list',
				itemType: 'Track'
			}),
			makeItem({
				title: 'Second Movement',
				itemKey: 't2',
				hint: 'action_list',
				itemType: 'TRACKS'
			})
		];
		setUpRoot(items);

		render(LibraryPage);
		await tick();
		// 

		const trackList = document.querySelector('ol.track-list');
		expect(trackList).not.toBeNull();
		expect(trackList!.querySelectorAll('li.track-row')).toHaveLength(2);
	});

	it('infers a track list from a large pure-action_list page even when items have no itemType and no leading digit', async () => {
		// Live shape from Library/Tracks and playlist contents: 100s of
		// action_list rows with no itemType and non-numeric titles. Prior
		// classifier left every row in pageActions with an empty <ol>;
		// inferred-mode now puts every row in trackItems.
		const items: BrowseItem[] = [
			'Bohemian Rhapsody',
			'Something',
			'Hey Jude',
			'Imagine',
			'Yesterday',
			'Let It Be',
			'Come Together'
		].map((title, i) =>
			makeItem({
				title,
				itemKey: `t${i}`,
				hint: 'action_list',
				subtitle: 'Some Artist'
			})
		);
		setUpRoot(items);

		render(LibraryPage);
		await tick();

		// Track list rendered with all 7 rows, no page-action pills.
		const trackList = document.querySelector('ol.track-list');
		expect(trackList).not.toBeNull();
		expect(trackList!.querySelectorAll('li.track-row')).toHaveLength(7);
		expect(document.querySelector('.page-actions')).toBeNull();
	});

	it('itemType wins over leading-digit regex (numbered title with non-track itemType is a page action)', async () => {
		// Hypothetical: a page action with a numbered label like "1 hour
		// continuous mix" that Roon flags as a non-track item. Pre-refactor
		// the regex would have promoted it into the track list.
		const items = [
			makeItem({
				title: '1. Track One',
				itemKey: 't1',
				hint: 'action_list',
				itemType: 'track'
			}),
			makeItem({
				title: '1 Hour Continuous Mix',
				itemKey: 'mix',
				hint: 'action_list',
				itemType: 'action'
			})
		];
		setUpRoot(items);

		render(LibraryPage);
		await tick();
		// 

		const trackList = document.querySelector('ol.track-list');
		expect(trackList).not.toBeNull();
		expect(trackList!.querySelectorAll('li.track-row')).toHaveLength(1);
		// The non-track itemType row is a page action, not a track row.
		expect(screen.getByRole('button', { name: '1 Hour Continuous Mix' })).toBeTruthy();
	});
});

describe('Library page — Recently Played tile click', () => {
	const RECENT = {
		title: 'Hey Jude',
		artist: 'The Beatles',
		album: '1',
		duration: 431,
		image_key: 'img-x',
		zone_id: 'zone-a',
		zone_name: 'Living Room',
		played_at: '2026-05-08T00:00:00.000Z'
	};

	beforeEach(async () => {
		const { resetRecentlyPlayed, applyRecentlyPlayedInserted } = await import(
			'$lib/stores/recentlyPlayedStore'
		);
		resetRecentlyPlayed();
		applyRecentlyPlayedInserted({ entry: RECENT, revision: 1, epoch: 1 });
	});

	it('shows a feedback toast and skips REST when no zone is selected', async () => {
		setSelectedZone('');
		render(LibraryPage);
		await tick();

		const tile = await screen.findByRole('button', {
			name: /Play 'Hey Jude'/i
		});
		tile.click();
		await tick();

		// Filter out the welcome-stats fetches; the click path should
		// not have triggered any nav-related apiBrowse calls.
		const navCalls = apiBrowse.mock.calls.filter(
			([, opts]) => !opts.multiSessionKey?.startsWith('welcome-stats')
		);
		expect(navCalls).toHaveLength(0);

		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message).toMatch(/select a zone/i);
	});

	it('searches for the title, matches by track + artist, and runs quickPlay', async () => {
		setSelectedZone('zone-a');

		// Search returns the track under a fresh search itemKey.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Hey Jude',
						subtitle: 'The Beatles',
						itemKey: 'fresh-track-key',
						itemType: 'track',
						hint: 'action_list'
					})
				]
			})
		);
		// quickPlay action-list lookup → finds Play Now.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [
					makeItem({ title: 'Play Now', itemKey: 'pn', hint: 'action', isPlayable: true })
				]
			})
		);
		// Execute Play Now.
		apiBrowse.mockResolvedValueOnce(listResult({ level: 1 }));

		render(LibraryPage);
		await tick();

		const tile = await screen.findByRole('button', { name: /Play 'Hey Jude'/i });
		tile.click();

		await waitFor(() => {
			const navCalls = apiBrowse.mock.calls.filter(
				([, opts]) => !opts.multiSessionKey?.startsWith('welcome-stats')
			);
			expect(navCalls).toHaveLength(3);
		});

		const navCalls = apiBrowse.mock.calls.filter(
			([, opts]) => !opts.multiSessionKey?.startsWith('welcome-stats')
		);
		// First nav call: search the title in main search session.
		expect(navCalls[0][1]).toEqual(
			expect.objectContaining({
				hierarchy: 'search',
				input: 'Hey Jude',
				multiSessionKey: 'library-search'
			})
		);
		// Second: drill the matched fresh itemKey for its action list.
		expect(navCalls[1][1]).toEqual(
			expect.objectContaining({ hierarchy: 'search', itemKey: 'fresh-track-key' })
		);
		// Third: execute Play Now.
		expect(navCalls[2][1]).toEqual(
			expect.objectContaining({ itemKey: 'pn' })
		);
	});

	it('preserves prior search-panel state on no-match (does not relabel old results)', async () => {
		// R9 finding: handleRecentlyPlayedClick must not touch
		// browseStore's search panel state. The function re-seeds
		// Roon's server-side search session with the title, but
		// lastSearch / lastSearchQuery / searchLoading are user-facing
		// state for the Search UI — clobbering lastSearchQuery while
		// leaving stale lastSearch in place would mislabel the prior
		// "beatles" results as results for "Hey Jude".
		setSelectedZone('zone-a');

		// Seed prior search state — the user previously searched
		// "beatles" and the panel is showing those results.
		setSearchLoading('beatles');
		const priorResults = [
			makeSearchResult({
				resultType: 'album',
				itemType: 'album',
				title: 'Abbey Road',
				subtitle: 'The Beatles',
				itemKey: 'prior-album-key'
			})
		];
		setSearchResults(priorResults);

		// Recently Played click resolver: search returns nothing matching.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Different Track',
						subtitle: 'Other Artist',
						itemKey: 'wrong',
						itemType: 'track',
						hint: 'action_list'
					})
				]
			})
		);

		render(LibraryPage);
		await tick();

		const tile = await screen.findByRole('button', { name: /Play 'Hey Jude'/i });
		tile.click();
		await tick();

		await waitFor(async () => {
			const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
			expect(get(commandFeedbackStore)?.message).toMatch(/Couldn't find "Hey Jude"/);
		});

		// No quickPlay drill calls fired.
		const navCalls = apiBrowse.mock.calls.filter(
			([, opts]) => !opts.multiSessionKey?.startsWith('welcome-stats')
		);
		expect(navCalls).toHaveLength(1); // just the search seed

		// Prior search panel state preserved exactly.
		const store = get(browseStore);
		expect(store.lastSearchQuery).toBe('beatles');
		expect(store.lastSearch).toBe(priorResults);
		// setSearchResults above sets searchLoading=false. Recently
		// Played must not flip it back to true.
		expect(store.searchLoading).toBe(false);
	});

	it('matched track with no play action: toast + no fallback browse + prior search preserved', async () => {
		// R10 finding: quickPlay's no-play-action fallback would
		// browse to an action menu and call pushHistory under the
		// current $browseStore.lastSearchQuery. After R9 that query
		// is deliberately preserved as the user's prior visible
		// search (e.g. "beatles"), so a Recently Played fallback
		// would land in history labeled with the wrong query and
		// let a future restore re-seed the wrong search session.
		// playOnly:true makes the no-play-action path a feedback
		// toast instead, preserving search state and avoiding the
		// corrupt history entry.
		setSelectedZone('zone-a');

		// Prior search state visible.
		setSearchLoading('beatles');
		const priorResults = [
			makeSearchResult({
				resultType: 'album',
				itemType: 'album',
				title: 'Abbey Road',
				subtitle: 'The Beatles',
				itemKey: 'prior-album-key'
			})
		];
		setSearchResults(priorResults);

		// Search returns a matching track.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Hey Jude',
						subtitle: 'The Beatles',
						itemKey: 'fresh-track-key',
						itemType: 'track',
						hint: 'action_list'
					})
				]
			})
		);
		// Action-list lookup returns no playable action.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [
					makeItem({ title: 'Metadata', itemKey: 'meta', hint: 'list', isPlayable: false })
				]
			})
		);

		render(LibraryPage);
		await tick();

		const tile = await screen.findByRole('button', { name: /Play 'Hey Jude'/i });
		tile.click();

		// Wait for both REST calls (search seed + action lookup).
		await waitFor(() => {
			const navCalls = apiBrowse.mock.calls.filter(
				([, opts]) => !opts.multiSessionKey?.startsWith('welcome-stats')
			);
			expect(navCalls).toHaveLength(2);
		});

		// No fallback browse:browse emit — history was not recorded.
		expect(fakeSocket.emit).not.toHaveBeenCalledWith(
			'browse:browse',
			expect.anything()
		);
		expect(get(browseHistoryStore).history).toEqual([]);

		// Prior search panel state preserved exactly.
		const store = get(browseStore);
		expect(store.lastSearchQuery).toBe('beatles');
		expect(store.lastSearch).toBe(priorResults);
		expect(store.searchLoading).toBe(false);

		// Toast surfaced the failure.
		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message).toMatch(/Couldn't play "Hey Jude"/);
	});

	it('preserves prior search-panel state on successful quickPlay (does not relabel old results)', async () => {
		// R9 finding (success path): even a successful Recently Played
		// match → Play Now must not touch the search panel state.
		setSelectedZone('zone-a');

		// Seed prior search state.
		setSearchLoading('beatles');
		const priorResults = [
			makeSearchResult({
				resultType: 'album',
				itemType: 'album',
				title: 'Abbey Road',
				subtitle: 'The Beatles',
				itemKey: 'prior-album-key'
			})
		];
		setSearchResults(priorResults);

		// Search returns a matching track.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Hey Jude',
						subtitle: 'The Beatles',
						itemKey: 'fresh-track-key',
						itemType: 'track',
						hint: 'action_list'
					})
				]
			})
		);
		// quickPlay action-list lookup → Play Now found.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [makeItem({ title: 'Play Now', itemKey: 'pn', hint: 'action', isPlayable: true })]
			})
		);
		// Execute Play Now.
		apiBrowse.mockResolvedValueOnce(listResult({ level: 1 }));

		render(LibraryPage);
		await tick();

		const tile = await screen.findByRole('button', { name: /Play 'Hey Jude'/i });
		tile.click();

		// Wait until the full chain has run.
		await waitFor(() => {
			const navCalls = apiBrowse.mock.calls.filter(
				([, opts]) => !opts.multiSessionKey?.startsWith('welcome-stats')
			);
			expect(navCalls).toHaveLength(3);
		});

		// Prior search panel state preserved exactly — Play Now did
		// not relabel the user's "beatles" results as "Hey Jude".
		const store = get(browseStore);
		expect(store.lastSearchQuery).toBe('beatles');
		expect(store.lastSearch).toBe(priorResults);
		// setSearchResults above sets searchLoading=false. Recently
		// Played must not flip it back to true.
		expect(store.searchLoading).toBe(false);
	});

	it('rejects matches whose subtitle does not contain the recorded artist', async () => {
		setSelectedZone('zone-a');

		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Hey Jude',
						subtitle: 'A Different Cover Artist',
						itemKey: 'wrong',
						itemType: 'track',
						hint: 'action_list'
					})
				]
			})
		);

		render(LibraryPage);
		await tick();

		const tile = await screen.findByRole('button', { name: /Play 'Hey Jude'/i });
		tile.click();
		await tick();

		await waitFor(async () => {
			const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
			expect(get(commandFeedbackStore)?.message).toMatch(/Couldn't find/);
		});
	});

	it('Clear button issues DELETE and applies the empty response', async () => {
		// The server returns its post-drain entries. In the common
		// case (no concurrent now-playing during clear), that's [].
		render(LibraryPage);
		await tick();

		expect(screen.queryByRole('button', { name: /Play 'Hey Jude'/i })).not.toBeNull();

		const clearBtn = await screen.findByRole('button', { name: 'Clear' });
		clearBtn.click();

		await waitFor(() => {
			expect(apiClearRecentlyPlayed).toHaveBeenCalledTimes(1);
		});

		const { recentlyPlayedStore } = await import('$lib/stores/recentlyPlayedStore');
		await waitFor(() => {
			expect(get(recentlyPlayedStore).entries).toEqual([]);
		});
		expect(screen.queryByRole('button', { name: /Play 'Hey Jude'/i })).toBeNull();
	});

	it('Clear button: stale DELETE response is discarded if a newer socket insert arrived first (revision guard)', async () => {
		// The race: a post-clear now-playing event fires after the
		// server snapshotted the DELETE response. The socket insert
		// (revision N+1) reaches the client first; the slower HTTP
		// response (revision N, the older snapshot) arrives later.
		// Revision filtering ensures the response is discarded so it
		// doesn't wipe the legitimate post-snapshot insert.
		let resolveDelete!: (snapshot: import('@shared/types').RecentlyPlayedSnapshot) => void;
		apiClearRecentlyPlayed.mockImplementationOnce(
			() => new Promise((r) => (resolveDelete = r))
		);

		render(LibraryPage);
		await tick();

		const clearBtn = await screen.findByRole('button', { name: 'Clear' });
		clearBtn.click();
		await tick();
		expect(apiClearRecentlyPlayed).toHaveBeenCalledTimes(1);

		// Simulate a post-clear socket insert arriving mid-flight at a
		// higher revision than the (still pending) DELETE response.
		const { applyRecentlyPlayedInserted, recentlyPlayedStore } = await import(
			'$lib/stores/recentlyPlayedStore'
		);
		const newTrack: import('@shared/types').RecentlyPlayedEntry = {
			title: 'NewTrack',
			artist: 'Live Artist',
			album: 'Live Album',
			duration: 200,
			image_key: 'img-n',
			zone_id: 'zone-a',
			zone_name: 'Living Room',
			played_at: '2026-05-16T08:00:00.000Z'
		};
		applyRecentlyPlayedInserted({ entry: newTrack, revision: 100, epoch: 1 });
		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual([
			'NewTrack',
			'Hey Jude'
		]);

		// Now the slower HTTP response resolves with the (now stale)
		// snapshot — revision 99 < 100, so it's discarded. If it
		// weren't, the store would get wiped to [].
		resolveDelete({ entries: [], revision: 99, epoch: 1 });

		// Give the await chain a chance to complete; nothing should
		// change because the response was discarded as stale.
		await new Promise((r) => setTimeout(r, 10));
		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual([
			'NewTrack',
			'Hey Jude'
		]);
	});

	it('Clear button applies post-drain entries from the DELETE response', async () => {
		// If a now-playing event landed during the server's clear
		// window, clear() drains it onto the empty list before
		// resolving — getEntries() then returns the drained insert.
		// The UI applies the response unconditionally, so the
		// initiator's view matches server/disk regardless of whether
		// the socket events arrived first, last, or were dropped.
		const drainedEntry: import('@shared/types').RecentlyPlayedEntry = {
			title: 'Drained Mid-Clear',
			artist: 'Some Artist',
			album: 'Some Album',
			duration: 200,
			image_key: 'img-d',
			zone_id: 'zone-a',
			zone_name: 'Living Room',
			played_at: '2026-05-15T12:00:00.000Z'
		};
		apiClearRecentlyPlayed.mockResolvedValueOnce({
			entries: [drainedEntry],
			revision: 999_999,
			epoch: 1
		});

		render(LibraryPage);
		await tick();

		const clearBtn = await screen.findByRole('button', { name: 'Clear' });
		clearBtn.click();

		await waitFor(() => {
			expect(apiClearRecentlyPlayed).toHaveBeenCalledTimes(1);
		});

		const { recentlyPlayedStore } = await import('$lib/stores/recentlyPlayedStore');
		await waitFor(() => {
			expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual([
				'Drained Mid-Clear'
			]);
		});
	});

	it('Clear button surfaces a feedback toast when the DELETE fails', async () => {
		apiClearRecentlyPlayed.mockRejectedValueOnce(new Error('network down'));
		render(LibraryPage);
		await tick();

		const clearBtn = await screen.findByRole('button', { name: 'Clear' });
		clearBtn.click();

		await waitFor(async () => {
			const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
			expect(get(commandFeedbackStore)?.message).toMatch(/Couldn't clear recently played/);
		});
		// List left intact — the failed clear didn't touch the store.
		const { recentlyPlayedStore } = await import('$lib/stores/recentlyPlayedStore');
		expect(get(recentlyPlayedStore).entries).toHaveLength(1);
	});
});

describe('Library page — album chips (PR2 album-page polish)', () => {
	function albumPageResult(subtitle: string | undefined) {
		// Build a level-2 track list (6 action_list rows with `track`
		// itemType) so `isTrackList` is true and `isAlbumPage` returns
		// true. Subtitle drives chip extraction.
		const trackRows: BrowseItem[] = [];
		for (let i = 1; i <= 6; i++) {
			trackRows.push(
				makeItem({
					title: `${i}. Track ${i}`,
					itemKey: `t${i}`,
					hint: 'action_list',
					itemType: 'track'
				})
			);
		}
		return listResult({
			level: 2,
			title: 'Under the Pink',
			subtitle,
			items: trackRows
		});
	}

	it('renders year + format chips on an album page with subtitle "Artist · 1994 · FLAC"', async () => {
		setBrowseResult(albumPageResult('Tori Amos · 1994 · FLAC'), 'browse');

		render(LibraryPage);
		await tick();

		const chips = await screen.findByLabelText('Album metadata');
		expect(chips.textContent).toContain('1994');
		expect(chips.textContent).toContain('FLAC');
	});

	it('renders nothing when subtitle is just an artist name (no year, no format)', async () => {
		setBrowseResult(albumPageResult('Tori Amos'), 'browse');
		render(LibraryPage);
		await tick();

		expect(screen.queryByLabelText('Album metadata')).toBeNull();
	});

	it('does not render chips on non-album pages (level 0–1, artist listings, etc.)', async () => {
		// Level 0 navigation menu with subtitle that LOOKS like an
		// album subtitle ("Tori Amos · 1994"). isAlbumPage gates on
		// level ≥ 2 AND isTrackList — neither is true here.
		setBrowseResult(
			listResult({
				level: 0,
				title: 'Library',
				subtitle: 'Tori Amos · 1994',
				items: [makeItem({ title: 'Albums', itemKey: 'albums' })]
			}),
			'browse'
		);
		render(LibraryPage);
		await tick();

		expect(screen.queryByLabelText('Album metadata')).toBeNull();
	});

	it('renders only the year chip when subtitle has a year but no format tag', async () => {
		setBrowseResult(albumPageResult('Tori Amos · 1994'), 'browse');
		render(LibraryPage);
		await tick();

		const chips = await screen.findByLabelText('Album metadata');
		expect(chips.textContent).toContain('1994');
		// No format tag present.
		expect(chips.textContent).not.toMatch(/FLAC|MQA|DSD|Hi-Res/);
	});

	it('P1 reopen: "Search for this artist" link text is the artist portion only, not the raw chip-laden subtitle', async () => {
		setBrowseResult(albumPageResult('Tori Amos · 1994 · FLAC'), 'browse');
		render(LibraryPage);
		await tick();

		// The artist-link button reads "Tori Amos", not the full
		// subtitle. The previous behavior set the button label (and
		// search query) to the full string. Find by visible text
		// (the button's text content is the accessible name).
		const link = await screen.findByRole('button', { name: 'Tori Amos' });
		expect(link.textContent?.trim()).toBe('Tori Amos');
		expect(link.textContent?.trim()).not.toContain('1994');
		expect(link.textContent?.trim()).not.toContain('FLAC');
	});

	it('playlist contents: subtitle "453 tracks" renders as static text, not as a search-this-artist button', async () => {
		// Live regression: a large playlist hits isTrackList=true via
		// the size threshold (inferredAllTracks=true). Roon's subtitle
		// on the page is "N tracks · duration" — metadata, NOT an
		// artist. The prior code rendered any non-empty subtitle as a
		// clickable button that called searchArtist("453 tracks"),
		// which routed through the search hierarchy and returned
		// "no results". Fix: gate the artist-link on isAlbumPage
		// (which excludes inferredAllTracks), fall through to static
		// text.
		const trackRows: BrowseItem[] = [];
		for (let i = 1; i <= 10; i++) {
			trackRows.push(
				makeItem({
					title: `Song Title ${i}`, // no number prefix, no itemType
					itemKey: `t${i}`,
					hint: 'action_list'
				})
			);
		}
		setBrowseResult(
			listResult({
				level: 2,
				title: 'My Playlist',
				subtitle: '453 tracks',
				items: trackRows
			}),
			'browse'
		);
		render(LibraryPage);
		await tick();

		// "453 tracks" appears as static text inside the album-header
		// region, not as a button.
		expect(screen.queryByRole('button', { name: '453 tracks' })).toBeNull();
		// And the page IS classified as a track list (inferredAllTracks
		// path); the subtitle is rendered as the static fallback.
		expect(screen.getByText('453 tracks')).toBeInTheDocument();
	});

	it('non-tracklist page: subtitle like "12 albums" renders as static text, not as a search button', async () => {
		// E.g. an artist page that shows their albums. Subtitle is
		// informational metadata. Prior code made any non-empty
		// subtitle on a non-tracklist page into a clickable
		// "search this artist" button, which would search Roon for
		// "12 albums" — wrong.
		setBrowseResult(
			listResult({
				level: 1,
				title: 'Tori Amos',
				subtitle: '12 albums',
				items: [makeItem({ title: 'Under the Pink', itemKey: 'a1' })]
			}),
			'browse'
		);
		render(LibraryPage);
		await tick();

		expect(screen.queryByRole('button', { name: '12 albums' })).toBeNull();
		expect(screen.getByText('12 albums')).toBeInTheDocument();
	});

	it('P2 reopen: no chips render on a non-album track list (Library/Tracks-style inferred-all-tracks page)', async () => {
		// Same shape as albumPageResult — level 2, every row is an
		// action_list — but NO `itemType: track` AND no numeric-
		// prefix titles (which would trigger the title-regex
		// fallback in isTrackItem). isTrackList kicks in via the
		// size heuristic alone → inferredAllTracks becomes true →
		// isAlbumPage returns false → no chips.
		const trackRows: BrowseItem[] = [];
		for (let i = 1; i <= 6; i++) {
			trackRows.push(
				makeItem({
					title: `Some Track ${i}`, // No numeric prefix → not flagged by isTrackItem regex
					itemKey: `t${i}`,
					hint: 'action_list'
					// no itemType
				})
			);
		}
		setBrowseResult(
			listResult({
				level: 2,
				title: 'Tracks',
				subtitle: '12345 tracks · 2024',
				items: trackRows
			}),
			'browse'
		);

		render(LibraryPage);
		await tick();
		expect(screen.queryByLabelText('Album metadata')).toBeNull();
	});
});

describe('Library page — playlist contents (fix-2)', () => {
	function playlistPageResult(numTracks: number, opts: { withMetadataRow?: boolean } = {}): BrowseResult {
		const items: BrowseItem[] = [
			// Page-level play action that Roon mixes into the same
			// action_list stream as the track rows.
			makeItem({ title: 'Play Playlist', itemKey: 'play-pl', hint: 'action_list' })
		];
		for (let i = 1; i <= numTracks; i++) {
			items.push(
				makeItem({
					// Real-world shape: no numeric prefix, no itemType=track.
					title: `Song Title ${i}`,
					itemKey: `t${i}`,
					hint: 'action_list'
				})
			);
		}
		if (opts.withMetadataRow !== false) {
			// Roon-style metadata header that breaks every(action_list).
			items.push(
				makeItem({
					title: `${numTracks} Tracks`,
					itemKey: 'meta',
					hint: 'list',
					isPlayable: false
				})
			);
		}
		return listResult({
			level: 2,
			title: 'My Playlist',
			subtitle: `${numTracks} Tracks`,
			items
		});
	}

	it('classifies a playlist with a metadata header row as a track list (not blue-pill page actions)', async () => {
		// Pre-fix: the one `hint: 'list'` metadata row broke
		// `every(action_list)`, sending all track rows into pageActions
		// as blue-pill .album-action-btn buttons.
		setBrowseResult(playlistPageResult(10), 'browse');
		render(LibraryPage);
		await tick();

		// No "Song Title N" should appear as an .album-action-btn /
		// page-action pill. They should be track rows. Searching by
		// the exact play-button label is unambiguous.
		const playButton = await screen.findByRole('button', { name: 'Play Song Title 1' });
		expect(playButton).toBeInTheDocument();
	});

	it('routes the "Play Playlist" row to page-actions, not track rows', async () => {
		setBrowseResult(playlistPageResult(10), 'browse');
		render(LibraryPage);
		await tick();

		// "Play Playlist" still renders, but NOT as a track row (a
		// track row would have an aria-label "Play Play Playlist" via
		// TrackList's per-row play button). It's a pageAction pill.
		expect(screen.queryByRole('button', { name: 'Play Play Playlist' })).toBeNull();
		// And it's still clickable as a page-level action.
		expect(screen.getByRole('button', { name: 'Play Playlist' })).toBeInTheDocument();
	});

	it('track-row ▶ click goes through quickPlay (not navigate / drill into action menu)', async () => {
		setBrowseResult(playlistPageResult(10), 'browse');
		setSelectedZone('zone-living-room');

		// quickPlay needs an action-list lookup that contains a play
		// action; mirror the existing "looks up the action list,
		// executes the play action" test setup.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 3,
				items: [makeItem({ title: 'Play Now', itemKey: 'play-now-key', hint: 'action', isPlayable: true })]
			})
		);
		apiBrowse.mockResolvedValueOnce(listResult({ level: 3 }));

		render(LibraryPage);
		const playBtn = await screen.findByRole('button', { name: 'Play Song Title 1' });
		playBtn.click();

		// Two apiBrowse calls — lookup + execute, exactly the quickPlay
		// shape. If the click had gone through the default
		// handleItemClick (which would `navigate(item)` since
		// shouldQuickPlayActionList returns false without itemType=track),
		// we'd see one socket browse call and zero apiBrowse calls.
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(2));
		expect(apiBrowse.mock.calls[0][1]).toEqual(
			expect.objectContaining({ hierarchy: 'browse', itemKey: 't1' })
		);
		expect(apiBrowse.mock.calls[1][1]).toEqual(
			expect.objectContaining({ hierarchy: 'browse', itemKey: 'play-now-key' })
		);
	});

	it('reopen P1: real track titles starting with "Play" stay as tracks, not page actions', async () => {
		// Reviewer caught: prior `/^play\b/i` prefix match would
		// route "Play Dead", "Play With Fire", "Play That Funky Music"
		// into pageActions instead of trackItems, hiding real songs
		// behind the bug we were trying to fix.
		const items: BrowseItem[] = [
			makeItem({ title: 'Play Playlist', itemKey: 'pa-pl', hint: 'action_list' }),
			makeItem({ title: 'Play Dead', itemKey: 't1', hint: 'action_list' }),
			makeItem({ title: 'Play With Fire', itemKey: 't2', hint: 'action_list' }),
			makeItem({ title: 'Play That Funky Music', itemKey: 't3', hint: 'action_list' }),
			makeItem({ title: 'Play Crack the Sky', itemKey: 't4', hint: 'action_list' }),
			makeItem({ title: 'Other Song', itemKey: 't5', hint: 'action_list' }),
			makeItem({ title: '6 Tracks', itemKey: 'meta', hint: 'list', isPlayable: false })
		];
		setBrowseResult(
			listResult({ level: 2, title: 'Songs Starting With Play', items }),
			'browse'
		);
		render(LibraryPage);
		await tick();

		// "Play Playlist" is the only known page-action title; it goes
		// to pageActions and has no per-track play button.
		expect(screen.queryByRole('button', { name: 'Play Play Playlist' })).toBeNull();
		expect(screen.getByRole('button', { name: 'Play Playlist' })).toBeInTheDocument();

		// Every real song title starting with "Play" is a track row
		// (rendered with TrackList's per-row ▶ button labelled
		// "Play <song>").
		expect(screen.getByRole('button', { name: 'Play Play Dead' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Play Play With Fire' })).toBeInTheDocument();
		expect(
			screen.getByRole('button', { name: 'Play Play That Funky Music' })
		).toBeInTheDocument();
		expect(
			screen.getByRole('button', { name: 'Play Play Crack the Sky' })
		).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Play Other Song' })).toBeInTheDocument();
	});

	it('reopen P1: page-action match is case-insensitive and trims whitespace, but title-only', async () => {
		// Both " Play Album " (extra whitespace) and "PLAY GENRE" (case)
		// match. A track titled "Play Album Tonight" should not match —
		// only exact whole-string equality after trim+lowercase.
		const items: BrowseItem[] = [
			makeItem({ title: ' Play Album ', itemKey: 'pa-album', hint: 'action_list' }),
			makeItem({ title: 'PLAY GENRE', itemKey: 'pa-genre', hint: 'action_list' }),
			makeItem({ title: 'Play Album Tonight', itemKey: 't-album-tonight', hint: 'action_list' }),
			makeItem({ title: 'Some Track', itemKey: 't2', hint: 'action_list' }),
			makeItem({ title: 'Another Track', itemKey: 't3', hint: 'action_list' }),
			makeItem({ title: '5 Tracks', itemKey: 'meta', hint: 'list', isPlayable: false })
		];
		setBrowseResult(
			listResult({ level: 2, title: 'Mixed', items }),
			'browse'
		);
		render(LibraryPage);
		await tick();

		// "Play Album Tonight" — a track title that contains "Play Album"
		// as a prefix — must NOT be misclassified as a page action.
		expect(
			screen.getByRole('button', { name: 'Play Play Album Tonight' })
		).toBeInTheDocument();
	});

	it('reopen P2: small playlist (3 tracks + Play Playlist) renders as track list, not pills', async () => {
		// Reviewer caught: the size-threshold of 5 was the only path
		// to inferredAllTracks for untyped tracks. A small playlist
		// (1–4 tracks) has the same shape as a larger one — action_list
		// rows with no itemType, plus a Play Playlist row — but didn't
		// hit the threshold and reverted to the blue-pill rendering.
		// The collection-page-action signal (presence of "Play Playlist")
		// now triggers track-list classification at any size.
		const items: BrowseItem[] = [
			makeItem({ title: 'Play Playlist', itemKey: 'pa', hint: 'action_list' }),
			makeItem({ title: 'First Song', itemKey: 't1', hint: 'action_list' }),
			makeItem({ title: 'Second Song', itemKey: 't2', hint: 'action_list' }),
			makeItem({ title: 'Third Song', itemKey: 't3', hint: 'action_list' }),
			makeItem({ title: '3 Tracks', itemKey: 'meta', hint: 'list', isPlayable: false })
		];
		setBrowseResult(
			listResult({ level: 2, title: 'Tiny Playlist', items }),
			'browse'
		);
		render(LibraryPage);
		await tick();

		expect(screen.getByRole('button', { name: 'Play First Song' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Play Second Song' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Play Third Song' })).toBeInTheDocument();
		// Play Playlist still the page-level action.
		expect(screen.getByRole('button', { name: 'Play Playlist' })).toBeInTheDocument();
	});

	it('reopen P2: single-track playlist also renders as track list (size = 1)', async () => {
		const items: BrowseItem[] = [
			makeItem({ title: 'Play Playlist', itemKey: 'pa', hint: 'action_list' }),
			makeItem({ title: 'Only Song', itemKey: 't1', hint: 'action_list' })
		];
		setBrowseResult(
			listResult({ level: 2, title: 'One-Song Playlist', items }),
			'browse'
		);
		render(LibraryPage);
		await tick();

		expect(screen.getByRole('button', { name: 'Play Only Song' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Play Playlist' })).toBeInTheDocument();
	});

	it('reopen P2: small album with Play Album + 2 untyped tracks also classifies as track list', async () => {
		// Same shape as small playlist but with Play Album as the
		// collection action. Roon EP / single albums (< 5 tracks) hit
		// this path.
		const items: BrowseItem[] = [
			makeItem({ title: 'Play Album', itemKey: 'pa', hint: 'action_list' }),
			makeItem({ title: 'Intro', itemKey: 't1', hint: 'action_list' }),
			makeItem({ title: 'Outro', itemKey: 't2', hint: 'action_list' })
		];
		setBrowseResult(
			listResult({ level: 2, title: 'Short EP', items }),
			'browse'
		);
		render(LibraryPage);
		await tick();

		expect(screen.getByRole('button', { name: 'Play Intro' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Play Outro' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Play Album' })).toBeInTheDocument();
	});

	it('reopen P1: mixed-typing playlist with "N Tracks" subtitle does NOT reintroduce search-this-artist bug', async () => {
		// Reviewer caught: inferredAllTracks was defined as
		// `isTrackList && !actionListRows.some(isTrackItem)`. One
		// itemType=track sibling flipped it to false, isAlbumPage()
		// then returned true, and the subtitle ("321 Tracks") became
		// a clickable search-this-artist button — re-triggering the
		// original cascade bug. Fix: NON_ALBUM_COLLECTION_TITLES
		// signal forces inferredAllTracks=true on playlist/tag/mix
		// pages regardless of any one sibling's itemType.
		const items: BrowseItem[] = [
			makeItem({ title: 'Play Playlist', itemKey: 'pa', hint: 'action_list' }),
			makeItem({ title: 'Typed Track', itemKey: 't1', hint: 'action_list', itemType: 'track' }),
			makeItem({ title: 'Hey Jude', itemKey: 't2', hint: 'action_list' }),
			makeItem({ title: 'Imagine', itemKey: 't3', hint: 'action_list' }),
			makeItem({ title: 'Yesterday', itemKey: 't4', hint: 'action_list' }),
			makeItem({ title: 'Let It Be', itemKey: 't5', hint: 'action_list' })
		];
		setBrowseResult(
			listResult({
				level: 2,
				title: 'Mixed Playlist',
				subtitle: '321 Tracks',
				items
			}),
			'browse'
		);
		render(LibraryPage);
		await tick();

		// Subtitle stays as static text — NO clickable search button.
		expect(screen.queryByRole('button', { name: '321 Tracks' })).toBeNull();
		expect(screen.getByText('321 Tracks')).toBeInTheDocument();
		// No album chips either (this is not an album).
		expect(screen.queryByLabelText('Album metadata')).toBeNull();
		// Tracks still render correctly.
		expect(screen.getByRole('button', { name: 'Play Typed Track' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Play Hey Jude' })).toBeInTheDocument();
	});

	it('reopen P1: real album page (Play Album + all typed tracks + artist subtitle) STILL renders artist link + chips', async () => {
		// Regression guard: "Play Album" is intentionally NOT in
		// NON_ALBUM_COLLECTION_TITLES, so a real album page keeps
		// isAlbumPage=true and the artist-link / chips still render.
		const items: BrowseItem[] = [
			makeItem({ title: 'Play Album', itemKey: 'pa', hint: 'action_list' }),
			makeItem({ title: '1. Pretty Good Year', itemKey: 't1', hint: 'action_list', itemType: 'track' }),
			makeItem({ title: '2. God', itemKey: 't2', hint: 'action_list', itemType: 'track' }),
			makeItem({ title: '3. Bells for Her', itemKey: 't3', hint: 'action_list', itemType: 'track' }),
			makeItem({ title: '4. Past the Mission', itemKey: 't4', hint: 'action_list', itemType: 'track' }),
			makeItem({ title: '5. Baker Baker', itemKey: 't5', hint: 'action_list', itemType: 'track' })
		];
		setBrowseResult(
			listResult({
				level: 2,
				title: 'Under the Pink',
				subtitle: 'Tori Amos · 1994 · FLAC',
				items
			}),
			'browse'
		);
		render(LibraryPage);
		await tick();

		// Artist link still renders.
		expect(screen.getByRole('button', { name: 'Tori Amos' })).toBeInTheDocument();
		// Album chips still render.
		expect(screen.getByLabelText('Album metadata')).toBeInTheDocument();
	});

	it('live regression: untyped track rows stay as tracks even when one sibling has itemType=track', async () => {
		// Observed shape from a 321-track user playlist that rendered
		// every row as a blue-pill: most rows were untyped action_list
		// with non-numeric song titles, but ONE row happened to be
		// typed `track` (or had a numeric prefix). Pre-fix the
		// pageActions/trackItems split used !isTrackItem to mean "page
		// action" — that one typed row flipped inferredAllTracks=false
		// and sent every untyped sibling into pageActions as pills.
		const items: BrowseItem[] = [
			makeItem({ title: 'Play Playlist', itemKey: 'pa', hint: 'action_list' }),
			// One row Roon happens to type as `track`:
			makeItem({ title: 'Properly Typed Track', itemKey: 't1', hint: 'action_list', itemType: 'track' }),
			// All siblings: untyped action_list, normal song titles.
			makeItem({ title: 'Hey Jude', itemKey: 't2', hint: 'action_list' }),
			makeItem({ title: 'Imagine', itemKey: 't3', hint: 'action_list' }),
			makeItem({ title: 'Yesterday', itemKey: 't4', hint: 'action_list' }),
			makeItem({ title: 'Let It Be', itemKey: 't5', hint: 'action_list' }),
			makeItem({ title: '321 Tracks', itemKey: 'meta', hint: 'list', isPlayable: false })
		];
		setBrowseResult(
			listResult({ level: 2, title: 'Mixed Playlist', items }),
			'browse'
		);
		render(LibraryPage);
		await tick();

		// All real songs render as track rows (per-row Play <title> button),
		// regardless of itemType inconsistency between siblings.
		expect(screen.getByRole('button', { name: 'Play Properly Typed Track' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Play Hey Jude' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Play Imagine' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Play Yesterday' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Play Let It Be' })).toBeInTheDocument();
		// Page-level Play Playlist still a pill.
		expect(screen.getByRole('button', { name: 'Play Playlist' })).toBeInTheDocument();
		// No untyped sibling should appear as an .album-action-btn pill.
		const pills = document.querySelectorAll('.album-action-btn');
		expect(pills).toHaveLength(1); // just Play Playlist
		expect(pills[0].textContent?.trim()).toBe('Play Playlist');
	});

	it('reopen P2: Work page (Play Work + contextual "X by Y" row) STAYS as pills, not tracks', async () => {
		// Regression guard: "Play Work" is intentionally NOT in
		// COLLECTION_PAGE_ACTION_TITLES because its siblings on a
		// Work page are contextual recordings, not tracks. This
		// preserves the existing comment's "Work-style page" exclusion.
		const items: BrowseItem[] = [
			makeItem({ title: 'Play Work', itemKey: 'pw', hint: 'action_list' }),
			makeItem({
				title: 'On Ocean to Ocean by Tori Amos',
				itemKey: 'contextual',
				hint: 'action_list'
			})
		];
		setBrowseResult(
			listResult({ level: 2, title: 'Some Work', items }),
			'browse'
		);
		render(LibraryPage);
		await tick();

		// Both rows render as pageAction pills.
		expect(screen.getByRole('button', { name: 'Play Work' })).toBeInTheDocument();
		expect(
			screen.getByRole('button', { name: 'On Ocean to Ocean by Tori Amos' })
		).toBeInTheDocument();
		// And no per-track play button.
		expect(screen.queryByRole('button', { name: /^Play On Ocean/ })).toBeNull();
	});

	it('roon "Not Found" placeholder: shows friendly explanation, not the confusing card', async () => {
		// Verified live from server logs (2026-05-17): clicking a smart
		// playlist returned action='list' / count=1 with a single item
		// titled "Not Found". The page previously rendered that as a
		// regular ItemGrid card with "N" placeholder art — confusing.
		// Now: detect the pattern and render a friendly explanation.
		setBrowseResult(
			listResult({
				level: 2,
				title: 'Last Year',
				subtitle: '453 Tracks',
				items: [
					makeItem({
						title: 'Not Found',
						itemKey: '836:0',
						hint: 'list',
						isPlayable: false
					})
				]
			}),
			'browse'
		);
		render(LibraryPage);
		await tick();

		// The friendly message renders.
		expect(screen.getByText("Couldn't load this playlist's contents")).toBeInTheDocument();
		// The mention of smart playlists is the most helpful hint.
		expect(screen.getByText(/smart playlist/i)).toBeInTheDocument();
		// And NO ItemGrid card titled "Not Found" — that's the bug we
		// were replacing.
		expect(document.querySelector('.item-card')).toBeNull();
	});

	it('roon "Not Found" trim-tolerant: matches " Not Found " too', async () => {
		// Defensive: if Roon's payload has padding, still match.
		setBrowseResult(
			listResult({
				level: 2,
				title: 'Last Year',
				items: [makeItem({ title: '  Not Found  ', itemKey: 'x', hint: 'list' })]
			}),
			'browse'
		);
		render(LibraryPage);
		await tick();
		expect(screen.getByText("Couldn't load this playlist's contents")).toBeInTheDocument();
	});

	it('roon "Not Found" only triggers on exactly-one-item lists (regression guard)', async () => {
		// Don't pattern-match every list that contains a "Not Found"
		// row alongside real items — that could be valid content like
		// a song titled "Not Found" or an Albums list including a
		// genuinely-named album. Only trigger when the list is a
		// single-item placeholder.
		setBrowseResult(
			listResult({
				level: 2,
				title: 'Some Album',
				items: [
					makeItem({ title: 'Not Found', itemKey: '1', hint: 'list' }),
					makeItem({ title: 'Track 2', itemKey: '2', hint: 'list' })
				]
			}),
			'browse'
		);
		render(LibraryPage);
		await tick();
		// Should NOT show the placeholder message.
		expect(screen.queryByText("Couldn't load this playlist's contents")).toBeNull();
	});

	it('still classifies a small action_list-only page (< size threshold, no isTrackItem matches) as NOT a track list', async () => {
		// Regression guard: the relaxation of every(action_list) must
		// not also relax the "Work" page heuristic. Two action_list
		// rows that aren't tracks should stay as pageActions, not
		// trigger inferredAllTracks.
		setBrowseResult(
			listResult({
				level: 2,
				title: 'On Ocean to Ocean',
				items: [
					makeItem({ title: 'Play Work', itemKey: 'pw', hint: 'action_list' }),
					makeItem({
						title: 'On Ocean to Ocean by Tori Amos',
						itemKey: 'contextual',
						hint: 'action_list'
					})
				]
			}),
			'browse'
		);
		render(LibraryPage);
		await tick();

		// Both render as page-action pills, not as track rows.
		expect(screen.getByRole('button', { name: 'Play Work' })).toBeInTheDocument();
		expect(
			screen.getByRole('button', { name: 'On Ocean to Ocean by Tori Amos' })
		).toBeInTheDocument();
		// No per-track play button.
		expect(screen.queryByRole('button', { name: /^Play On Ocean/ })).toBeNull();
	});
});
