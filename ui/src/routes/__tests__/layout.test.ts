import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/svelte';
import { writable, get } from 'svelte/store';
import { tick, createRawSnippet } from 'svelte';
import type { BrowseResult, BrowseOptions } from '@shared/types';

const { railWritable, gotoMock, apiBrowse } = vi.hoisted(() => {
	const { writable: w } = require('svelte/store') as typeof import('svelte/store');
	const rail = w<{
		entries: Array<{
			id: string;
			label: string;
			labelPath: string[];
			isEmpty: boolean;
			cachedKey?: string;
			cachedAncestorKeys?: string[];
		}>;
		loading: boolean;
		error: string | null;
	}>({ entries: [], loading: false, error: null });
	return {
		railWritable: rail,
		gotoMock: vi.fn(),
		apiBrowse: vi.fn<(_fetch: unknown, opts: BrowseOptions) => Promise<BrowseResult>>()
	};
});

const pageState = writable({ url: new URL('http://localhost/library') });

vi.mock('$app/navigation', () => ({
	goto: gotoMock
}));

vi.mock('$app/stores', () => ({
	page: {
		subscribe: (run: (value: { url: URL }) => void) => pageState.subscribe(run)
	}
}));

import { createFakeSocket } from '../../test/fixtures/socket';
const fakeSocket = createFakeSocket();
vi.mock('$lib/socket/client', () => ({
	getSocket: () => fakeSocket,
	disconnectSocket: vi.fn()
}));

vi.mock('$lib/socket/register', () => ({
	registerSocketHandlers: () => () => {}
}));

vi.mock('$lib/socket/emit', () => ({
	emitWithAck: vi.fn().mockResolvedValue(undefined),
	emitIfConnected: vi.fn().mockReturnValue(true)
}));

vi.mock('$lib/api/client', () => ({
	browse: (fetchFn: unknown, opts: BrowseOptions) => apiBrowse(fetchFn, opts)
}));

vi.mock('$lib/stores/exploreRailStore', () => ({
	exploreRailStore: railWritable,
	resolveExploreRail: vi.fn().mockResolvedValue(undefined),
	invalidateExploreRail: vi.fn()
}));

// initializeStores fans out to coreStore/zonesStore/recentlyPlayedStore
// REST loaders at mount. Replace it wholesale rather than mocking each
// store's loader individually — the alternative pulls each store's full
// module graph just to spread it and stub one function.
vi.mock('$lib/stores', async (importOriginal) => {
	const mod = await importOriginal<typeof import('$lib/stores')>();
	return { ...mod, initializeStores: vi.fn().mockResolvedValue(undefined) };
});

import Layout from '../+layout.svelte';
import {
	browseHistoryStore,
	resetHistory,
	pushHistory,
	type BrowseHistoryStep
} from '$lib/stores/browseHistoryStore';
import { pendingSearchStore } from '$lib/stores/pendingSearchStore';
import { setNowPlaying, resetNowPlaying } from '$lib/stores/nowPlayingStore';
import { setSelectedZone } from '$lib/stores/selectedZoneStore';
import { setZonesSnapshot } from '$lib/stores/zonesStore';
import { themeStore, toggleTheme } from '$lib/stores/themeStore';
import { emitWithAck } from '$lib/socket/emit';
import type { Zone } from '@shared/types';
import {
	resetBrowse,
	browseStore,
	setBrowseResult,
	setSearchLoading,
	setBrowseError
} from '$lib/stores/browseStore';

import { listResult, makeItem } from '../../test/fixtures/browse';

// The layout calls `{@render children()}` (non-optional). A trivial
// snippet keeps the mount from throwing; the children aren't inspected.
const childrenSnippet = createRawSnippet(() => ({
	render: () => '<div data-testid="route-child">child</div>'
}));

function renderLayout() {
	return render(Layout, { props: { children: childrenSnippet } });
}

beforeEach(() => {
	apiBrowse.mockReset();
	gotoMock.mockReset();
	fakeSocket.emit.mockReset();
	fakeSocket.connected = true;
	railWritable.set({ entries: [], loading: false, error: null });
	pageState.set({ url: new URL('http://localhost/library') });
	resetBrowse();
	resetHistory();
	resetNowPlaying();
	setSelectedZone('');
	setZonesSnapshot([]);
	vi.mocked(emitWithAck).mockReset();
	// AckResponse<T> = { success: true; data?: T } | { success: false; ... }
	// Tests assert on the emit call, not the resolved value, but the
	// mock must return a shape that satisfies the type.
	vi.mocked(emitWithAck).mockResolvedValue({ success: true });
});

/**
 * Minimal Zone with the flags transport buttons read. Overrides win.
 */
function makeZone(over: Partial<Zone> = {}): Zone {
	return {
		zone_id: over.zone_id ?? 'zone-a',
		display_name: over.display_name ?? 'Main Zone',
		state: over.state ?? 'playing',
		seek_position: over.seek_position ?? 0,
		is_play_allowed: over.is_play_allowed ?? true,
		is_pause_allowed: over.is_pause_allowed ?? true,
		is_previous_allowed: over.is_previous_allowed ?? true,
		is_next_allowed: over.is_next_allowed ?? true,
		is_seek_allowed: over.is_seek_allowed ?? true,
		queue_items_remaining: over.queue_items_remaining,
		outputs: over.outputs ?? []
	};
}

describe('Layout — header search submit', () => {
	it('routes the query through pendingSearchStore and navigates to /library', async () => {
		// R7 contract: a search submitted from any route must land on
		// /library where the results pane renders.
		pageState.set({ url: new URL('http://localhost/queue') });
		renderLayout();

		const input = await screen.findByLabelText(/Search library/i) as HTMLInputElement;
		await fireEvent.input(input, { target: { value: 'tori amos' } });
		await fireEvent.keyDown(input, { key: 'Enter' });

		await waitFor(() => {
			expect(get(pendingSearchStore)).toBe('tori amos');
			expect(gotoMock).toHaveBeenCalledWith('/library');
		});
		// The Library page (or restore flow) is responsible for the
		// actual browse:search emit; the header path is purely routing.
		expect(fakeSocket.emit).not.toHaveBeenCalled();
	});
});

describe('Layout — mobile hamburger toggle', () => {
	it('opens and closes the sidebar', async () => {
		const { container } = renderLayout();
		await tick();

		const sidebar = container.querySelector('aside.sidebar');
		const hamburger = container.querySelector('button.hamburger');
		expect(sidebar).toBeTruthy();
		expect(hamburger).toBeTruthy();
		expect(sidebar!.classList.contains('open')).toBe(false);

		await fireEvent.click(hamburger!);
		await tick();
		expect(sidebar!.classList.contains('open')).toBe(true);

		const scrim = container.querySelector('.sidebar-scrim');
		expect(scrim).toBeTruthy();
		await fireEvent.click(scrim!);
		await tick();
		expect(sidebar!.classList.contains('open')).toBe(false);
	});
});

describe('Layout — Explore rail click', () => {
	it('label-walks via apiBrowse, pushes history with breadcrumbs, and stays on /library without goto', async () => {
		railWritable.set({
			entries: [
				{ id: 'rail-albums', label: 'Albums', labelPath: ['Albums'], isEmpty: false }
			],
			loading: false,
			error: null
		});
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({ title: 'Albums', itemKey: 'albums-key', itemType: 'list' }),
					makeItem({ title: 'Artists', itemKey: 'artists-key', itemType: 'list' })
				]
			})
		);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [makeItem({ title: 'Abbey Road', itemKey: 'album-1', itemType: 'album' })]
			})
		);

		renderLayout();
		const railBtn = await screen.findByRole('button', { name: 'Albums' });
		await fireEvent.click(railBtn);

		await waitFor(() => {
			expect(apiBrowse).toHaveBeenCalledTimes(2);
		});

		expect(apiBrowse.mock.calls[0][1]).toEqual(
			expect.objectContaining({ hierarchy: 'browse', popAll: true })
		);
		expect(apiBrowse.mock.calls[1][1]).toEqual(
			expect.objectContaining({ hierarchy: 'browse', itemKey: 'albums-key' })
		);

		// Phase A: each walked step records a breadcrumb so a later
		// remount can replay via restoreBrowse.
		const persisted = get(browseHistoryStore).history;
		expect(persisted).toHaveLength(1);
		expect(persisted[0].itemKey).toBe('albums-key');
		expect(persisted[0].breadcrumb?.title).toBe('Albums');

		// Already on /library — no route navigation needed.
		expect(gotoMock).not.toHaveBeenCalled();

		// Right pane was updated in-place via setBrowseResult. Without
		// this assertion, a regression dropping the `setBrowseResult(cur,
		// 'browse')` call would still satisfy the history/goto checks
		// above while the user's pane never refreshed.
		await waitFor(() => {
			const store = get(browseStore);
			expect(store.hierarchy).toBe('browse');
			expect(store.current?.level).toBe(1);
			expect(store.current?.items[0]?.itemKey).toBe('album-1');
		});
	});

	it('navigates to /library when clicked from another route, with history pushed BEFORE goto', async () => {
		// The walk must complete AND history must be pushed BEFORE goto.
		// Library's mount reads the freshly-pushed history to restore
		// the target view; if goto fires first the mount restores from
		// the prior (likely empty) history and the user lands on the
		// wrong state. End-state assertions can't catch
		// goto-then-pushHistory ordering bugs — snapshot history
		// synchronously at goto() call time instead.
		pageState.set({ url: new URL('http://localhost/queue') });
		railWritable.set({
			entries: [
				{ id: 'rail-albums', label: 'Albums', labelPath: ['Albums'], isEmpty: false }
			],
			loading: false,
			error: null
		});
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [makeItem({ title: 'Albums', itemKey: 'albums-key' })]
			})
		);
		apiBrowse.mockResolvedValueOnce(listResult({ level: 1 }));

		let historyAtGoto: BrowseHistoryStep[] | null = null;
		gotoMock.mockImplementation(() => {
			// Snapshot the FIRST goto only — a regression that fires
			// goto early would still call it again at the end; capturing
			// the last call would mask the ordering bug.
			if (historyAtGoto === null) {
				historyAtGoto = get(browseHistoryStore).history;
			}
		});

		renderLayout();
		const railBtn = await screen.findByRole('button', { name: 'Albums' });
		await fireEvent.click(railBtn);

		await waitFor(() => {
			expect(apiBrowse).toHaveBeenCalledTimes(2);
			expect(gotoMock).toHaveBeenCalledWith('/library');
		});

		expect(apiBrowse.mock.calls[0][1]).toEqual(
			expect.objectContaining({ hierarchy: 'browse', popAll: true })
		);
		expect(apiBrowse.mock.calls[1][1]).toEqual(
			expect.objectContaining({ hierarchy: 'browse', itemKey: 'albums-key' })
		);

		// The ordering assertion: at the moment goto fired, history
		// already had the walked step. A regression calling goto first
		// and pushing afterward would leave historyAtGoto empty.
		expect(historyAtGoto).not.toBeNull();
		expect(historyAtGoto!).toHaveLength(1);
		expect(historyAtGoto![0].itemKey).toBe('albums-key');
		expect(historyAtGoto![0].breadcrumb?.title).toBe('Albums');
	});

	it('M-1: REST failure on the first label-walk call restores prior history and pane', async () => {
		// Old code mutated visible state (setBrowseLoading + resetHistory)
		// BEFORE the first apiBrowse. A failing call left the pane stuck
		// in "loading" with the prior back stack wiped. Now we defer
		// state changes until the walk succeeds; on failure the prior
		// browse view is restored exactly.
		railWritable.set({
			entries: [
				{ id: 'rail-albums', label: 'Albums', labelPath: ['Albums'], isEmpty: false }
			],
			loading: false,
			error: null
		});

		// Seed prior history + pane content that the failure must NOT lose.
		pushHistory({ hierarchy: 'browse', itemKey: 'prior-key' }, undefined, {
			title: 'Prior Page'
		});
		const priorResult = listResult({
			title: 'Prior Page',
			level: 1,
			items: [makeItem({ title: 'Prior Item', itemKey: 'prior-item-key' })]
		});
		setBrowseResult(priorResult, 'browse');

		// First apiBrowse fails.
		apiBrowse.mockRejectedValueOnce(new Error('REST blew up'));

		renderLayout();
		const railBtn = await screen.findByRole('button', { name: 'Albums' });
		await fireEvent.click(railBtn);

		// Feedback toast surfaced.
		await waitFor(async () => {
			const { commandFeedbackStore } = await import(
				'$lib/stores/commandFeedbackStore'
			);
			expect(get(commandFeedbackStore)?.message).toMatch(
				/Rail navigation failed/i
			);
		});

		// History preserved — old code would have wiped it.
		expect(get(browseHistoryStore).history.map((s) => s.itemKey)).toEqual([
			'prior-key'
		]);

		// Pane restored to prior view — loading cleared, items intact.
		const store = get(browseStore);
		expect(store.loading).toBe(false);
		expect(store.current).toBe(priorResult);
	});

	it('M-1: REST failure mid-walk (second drill) leaves prior history + pane intact', async () => {
		// Multi-step labelPath; second apiBrowse rejects. Without
		// deferred mutation the first drill's pushHistory would have
		// already landed (partial walk), corrupting back state.
		railWritable.set({
			// Layout's railSections derived groups only 'Library' (nested)
			// and null (top-level). Use a Library-rooted labelPath so the
			// button actually renders.
			entries: [
				{
					id: 'rail-tracks',
					label: 'Tracks',
					labelPath: ['Library', 'Tracks'],
					isEmpty: false
				}
			],
			loading: false,
			error: null
		});

		pushHistory({ hierarchy: 'browse', itemKey: 'prior-key' }, undefined, {
			title: 'Prior Page'
		});
		const priorResult = listResult({
			title: 'Prior Page',
			level: 1,
			items: [makeItem({ title: 'Prior Item', itemKey: 'prior-item-key' })]
		});
		setBrowseResult(priorResult, 'browse');

		// popAll succeeds (root has Library); drill into Library succeeds
		// (has Tracks); drill into Tracks fails.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [makeItem({ title: 'Library', itemKey: 'library-key' })]
			})
		);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [makeItem({ title: 'Tracks', itemKey: 'tracks-key' })]
			})
		);
		apiBrowse.mockRejectedValueOnce(new Error('mid-walk failure'));

		renderLayout();
		const railBtn = await screen.findByRole('button', { name: 'Tracks' });
		await fireEvent.click(railBtn);

		await waitFor(() => {
			expect(apiBrowse).toHaveBeenCalledTimes(3);
		});

		// History still has ONLY the prior entry — the successful drill
		// into Library did NOT prematurely commit (deferred-commit
		// pattern). Old code would have left [prior-key, library-key].
		expect(get(browseHistoryStore).history.map((s) => s.itemKey)).toEqual([
			'prior-key'
		]);
		const store2 = get(browseStore);
		expect(store2.loading).toBe(false);
		expect(store2.current).toBe(priorResult);
	});

	it('M-1: stale rail entry (label missing) restores prior pane', async () => {
		// The "stale label set" early-return path used to set loading
		// + reset history and leave it that way. Now we treat it the
		// same as any other failure — restore the prior view.
		railWritable.set({
			entries: [
				{
					id: 'rail-ghost',
					label: 'Ghost',
					labelPath: ['Ghost'],
					isEmpty: false
				}
			],
			loading: false,
			error: null
		});

		pushHistory({ hierarchy: 'browse', itemKey: 'prior-key' }, undefined, {
			title: 'Prior Page'
		});
		const priorResult = listResult({
			title: 'Prior Page',
			level: 1,
			items: [makeItem({ title: 'Prior Item', itemKey: 'prior-item-key' })]
		});
		setBrowseResult(priorResult, 'browse');

		// popAll returns no matching label.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [makeItem({ title: 'Albums', itemKey: 'albums-key' })]
			})
		);

		renderLayout();
		const railBtn = await screen.findByRole('button', { name: 'Ghost' });
		await fireEvent.click(railBtn);

		await waitFor(async () => {
			const { commandFeedbackStore } = await import(
				'$lib/stores/commandFeedbackStore'
			);
			expect(get(commandFeedbackStore)?.message).toMatch(/no longer in results/i);
		});

		expect(get(browseHistoryStore).history.map((s) => s.itemKey)).toEqual([
			'prior-key'
		]);
		const store3 = get(browseStore);
		expect(store3.loading).toBe(false);
		expect(store3.current).toBe(priorResult);
	});

	it('M-1 reopen: prior error pane is restored on rail-click failure (not blanked)', async () => {
		// Reopen finding: the initial M-1 fix snapshotted only
		// current + hierarchy. setBrowseLoading clears error, so a
		// user looking at an error pane saw the error disappear on a
		// failed rail click — replaced by a blank welcome view. The
		// snapshot must capture loading + error too.
		railWritable.set({
			entries: [
				{ id: 'rail-albums', label: 'Albums', labelPath: ['Albums'], isEmpty: false }
			],
			loading: false,
			error: null
		});

		// Seed prior history. The pane is in the error state — no
		// current result, error banner visible.
		pushHistory({ hierarchy: 'browse', itemKey: 'prior-key' }, undefined, {
			title: 'Prior Page'
		});
		setBrowseError('Roon Core unreachable');

		const before = get(browseStore);
		expect(before.error).toBe('Roon Core unreachable');
		expect(before.current).toBeNull();

		// First apiBrowse fails.
		apiBrowse.mockRejectedValueOnce(new Error('REST blew up'));

		renderLayout();
		const railBtn = await screen.findByRole('button', { name: 'Albums' });
		await fireEvent.click(railBtn);

		await waitFor(async () => {
			const { commandFeedbackStore } = await import(
				'$lib/stores/commandFeedbackStore'
			);
			expect(get(commandFeedbackStore)?.message).toMatch(
				/Rail navigation failed/i
			);
		});

		// Prior history preserved AND prior error banner preserved.
		expect(get(browseHistoryStore).history.map((s) => s.itemKey)).toEqual([
			'prior-key'
		]);
		const store = get(browseStore);
		expect(store.error).toBe('Roon Core unreachable');
		expect(store.current).toBeNull();
		expect(store.loading).toBe(false);
	});

	it('M-1 reopen #2: active search-loading state is preserved on rail-click failure', async () => {
		// Second reopen: setBrowseLoading clears `searchLoading` and
		// `error` as side effects. The narrow snapshot covered
		// `error` but not `searchLoading`. A user with an in-flight
		// search panel could click a rail item, hit a REST failure,
		// and lose the visible "searching" spinner in the search
		// panel. Full-state snapshot must preserve the entire
		// search slice.
		railWritable.set({
			entries: [
				{ id: 'rail-albums', label: 'Albums', labelPath: ['Albums'], isEmpty: false }
			],
			loading: false,
			error: null
		});

		// Seed an in-flight search: setSearchLoading flips
		// searchLoading=true and sets lastSearchQuery.
		setSearchLoading('beatles');
		const before = get(browseStore);
		expect(before.searchLoading).toBe(true);
		expect(before.lastSearchQuery).toBe('beatles');

		apiBrowse.mockRejectedValueOnce(new Error('REST blew up'));

		renderLayout();
		const railBtn = await screen.findByRole('button', { name: 'Albums' });
		await fireEvent.click(railBtn);

		await waitFor(async () => {
			const { commandFeedbackStore } = await import(
				'$lib/stores/commandFeedbackStore'
			);
			expect(get(commandFeedbackStore)?.message).toMatch(
				/Rail navigation failed/i
			);
		});

		// Active search state restored exactly.
		const store = get(browseStore);
		expect(store.searchLoading).toBe(true);
		expect(store.lastSearchQuery).toBe('beatles');
		expect(store.loading).toBe(false);
	});

	it('M-1 reopen #3: search results that arrive mid-rail-await survive the rollback', async () => {
		// Reviewer race (M-1 reopen #3): the full-state snapshot
		// captured `searchLoading=true`/`lastSearch=null` at click
		// time. While the rail REST call awaited, a `browse:search`
		// socket result landed and called setSearchResults() — which
		// flipped `searchLoading=false` and set `lastSearch`. When
		// the rail REST then rejected, the full-state restore wrote
		// the stale `searchLoading=true`/`lastSearch=null` back,
		// resurrecting the spinner and wiping the just-arrived
		// results.
		//
		// New conditional-restore behavior: only roll back fields
		// whose current value still equals the post-setBrowseLoading
		// snapshot. `searchResults`'s update changed both
		// `searchLoading` and `lastSearch`, so neither is restored.
		railWritable.set({
			entries: [
				{ id: 'rail-albums', label: 'Albums', labelPath: ['Albums'], isEmpty: false }
			],
			loading: false,
			error: null
		});

		// Step 1: user is mid-search.
		setSearchLoading('beatles');
		expect(get(browseStore).searchLoading).toBe(true);
		expect(get(browseStore).lastSearch).toBeNull();

		// Step 2: rail click — apiBrowse stalls until we manually
		// reject it so we can interleave the search-result socket
		// callback in between.
		let rejectApi: (err: Error) => void = () => undefined;
		apiBrowse.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					rejectApi = reject;
				})
		);

		renderLayout();
		const railBtn = await screen.findByRole('button', { name: 'Albums' });
		void fireEvent.click(railBtn);

		// Wait for the click handler to take its snapshots + fire
		// the (still-pending) apiBrowse.
		await waitFor(() => {
			expect(apiBrowse).toHaveBeenCalled();
		});

		// Step 3: independent search-result socket lands.
		const { setSearchResults } = await import('$lib/stores/browseStore');
		const arrivedResults = [
			{ kind: 'artist', items: [] }
		] as unknown as Parameters<typeof setSearchResults>[0];
		setSearchResults(arrivedResults);
		expect(get(browseStore).searchLoading).toBe(false);
		expect(get(browseStore).lastSearch).toBe(arrivedResults);

		// Step 4: rail REST rejects.
		rejectApi(new Error('REST blew up'));

		await waitFor(async () => {
			const { commandFeedbackStore } = await import(
				'$lib/stores/commandFeedbackStore'
			);
			expect(get(commandFeedbackStore)?.message).toMatch(
				/Rail navigation failed/i
			);
		});

		// The just-arrived search results SURVIVE the rollback.
		// `searchLoading` must NOT be resurrected to true; `lastSearch`
		// must NOT be wiped to null.
		const store = get(browseStore);
		expect(store.searchLoading).toBe(false);
		expect(store.lastSearch).toBe(arrivedResults);
		// The browse loading flag (which setBrowseLoading set to true
		// and nothing else touched) IS rolled back to false.
		expect(store.loading).toBe(false);
	});

	describe('cached-key fast path (perf)', () => {
		it('top-level entry with cachedKey skips the label walk (1 popAll + 1 drill)', async () => {
			railWritable.set({
				entries: [
					{
						id: 'rail-albums',
						label: 'Albums',
						labelPath: ['Albums'],
						isEmpty: false,
						cachedKey: 'albums-cached-key',
						cachedAncestorKeys: []
					}
				],
				loading: false,
				error: null
			});

			// popAll, then drill DIRECTLY to cachedKey.
			apiBrowse.mockResolvedValueOnce(listResult({ level: 0, items: [] }));
			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 1,
					items: [makeItem({ title: 'Abbey Road', itemKey: 'album-1' })]
				})
			);

			renderLayout();
			const railBtn = await screen.findByRole('button', { name: 'Albums' });
			await fireEvent.click(railBtn);

			await waitFor(() => {
				expect(apiBrowse).toHaveBeenCalledTimes(2);
			});
			// The drill uses the cached key directly — no label-walk
			// scanning the root for "Albums" then drilling its
			// itemKey.
			expect(apiBrowse.mock.calls[0][1]).toEqual(
				expect.objectContaining({ hierarchy: 'browse', popAll: true })
			);
			expect(apiBrowse.mock.calls[1][1]).toEqual(
				expect.objectContaining({
					hierarchy: 'browse',
					itemKey: 'albums-cached-key'
				})
			);

			// History records the cached key.
			const persisted = get(browseHistoryStore).history;
			expect(persisted).toHaveLength(1);
			expect(persisted[0].itemKey).toBe('albums-cached-key');
			expect(persisted[0].breadcrumb?.title).toBe('Albums');
		});

		it('nested entry walks the cached chain (popAll + each ancestor + leaf) to keep Roon session stack aligned with UI history', async () => {
			// Roon's browse session is stack-based: skipping ancestor
			// drills and going directly to the leaf would leave Roon
			// at `root → leaf` while UI history pushed
			// `root → ancestor → leaf` — a subsequent Back's
			// popLevel=1 would diverge the two stacks. The fast path
			// must drill every level. REST count matches the slow
			// label walk; the win is purely "skip the title-match
			// scan + use known-good keys".
			railWritable.set({
				entries: [
					{
						id: 'rail-tracks',
						label: 'Tracks',
						labelPath: ['Library', 'Tracks'],
						isEmpty: false,
						cachedKey: 'tracks-cached-key',
						cachedAncestorKeys: ['library-cached-key']
					}
				],
				loading: false,
				error: null
			});

			apiBrowse.mockResolvedValueOnce(listResult({ level: 0, items: [] }));
			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 1,
					items: [makeItem({ title: 'Tracks', itemKey: 'tracks-cached-key' })]
				})
			);
			apiBrowse.mockResolvedValueOnce(
				listResult({ level: 2, items: [makeItem({ title: 'T1', itemKey: 't1' })] })
			);

			renderLayout();
			const railBtn = await screen.findByRole('button', { name: 'Tracks' });
			await fireEvent.click(railBtn);

			await waitFor(() => {
				expect(apiBrowse).toHaveBeenCalledTimes(3);
			});
			// popAll, drill ancestor, drill leaf — in order. Roon
			// session is now root → Library → Tracks.
			expect(apiBrowse.mock.calls[0][1]).toEqual(
				expect.objectContaining({ popAll: true })
			);
			expect(apiBrowse.mock.calls[1][1]).toEqual(
				expect.objectContaining({ itemKey: 'library-cached-key' })
			);
			expect(apiBrowse.mock.calls[2][1]).toEqual(
				expect.objectContaining({ itemKey: 'tracks-cached-key' })
			);

			// History has BOTH steps — ancestor + leaf — synthesized
			// from cachedAncestorKeys + cachedKey + labelPath labels.
			const persisted = get(browseHistoryStore).history;
			expect(persisted).toHaveLength(2);
			expect(persisted[0].itemKey).toBe('library-cached-key');
			expect(persisted[0].breadcrumb?.title).toBe('Library');
			expect(persisted[1].itemKey).toBe('tracks-cached-key');
			expect(persisted[1].breadcrumb?.title).toBe('Tracks');
		});

		it('nested fast path falls back to the label walk when an ancestor drill fails', async () => {
			// Stale ancestor key — must fall through to title-match
			// recovery just like the leaf-fail case.
			railWritable.set({
				entries: [
					{
						id: 'rail-tracks',
						label: 'Tracks',
						labelPath: ['Library', 'Tracks'],
						isEmpty: false,
						cachedKey: 'tracks-cached-key',
						cachedAncestorKeys: ['stale-library-key']
					}
				],
				loading: false,
				error: null
			});

			// Fast path: popAll OK, ancestor drill REJECTS.
			apiBrowse.mockResolvedValueOnce(listResult({ level: 0, items: [] }));
			apiBrowse.mockRejectedValueOnce(new Error('InvalidItemKey'));
			// Label-walk fallback: popAll → drill Library → drill Tracks.
			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 0,
					items: [makeItem({ title: 'Library', itemKey: 'library-fresh-key' })]
				})
			);
			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 1,
					items: [makeItem({ title: 'Tracks', itemKey: 'tracks-fresh-key' })]
				})
			);
			apiBrowse.mockResolvedValueOnce(
				listResult({ level: 2, items: [makeItem({ title: 'T1', itemKey: 't1' })] })
			);

			renderLayout();
			const railBtn = await screen.findByRole('button', { name: 'Tracks' });
			await fireEvent.click(railBtn);

			await waitFor(() => {
				expect(apiBrowse).toHaveBeenCalledTimes(5);
			});
			// Final history uses the FRESH keys from label-walk.
			const persisted = get(browseHistoryStore).history;
			expect(persisted).toHaveLength(2);
			expect(persisted[0].itemKey).toBe('library-fresh-key');
			expect(persisted[1].itemKey).toBe('tracks-fresh-key');
		});

		it('stale cachedKey falls through to label-walk (no error surfaced)', async () => {
			railWritable.set({
				entries: [
					{
						id: 'rail-albums',
						label: 'Albums',
						labelPath: ['Albums'],
						isEmpty: false,
						cachedKey: 'stale-key',
						cachedAncestorKeys: []
					}
				],
				loading: false,
				error: null
			});

			// Fast path: popAll OK, drill REJECTS (stale key after Core
			// restart).
			apiBrowse.mockResolvedValueOnce(listResult({ level: 0, items: [] }));
			apiBrowse.mockRejectedValueOnce(new Error('InvalidItemKey'));
			// Label-walk fallback: popAll, then label-match drill.
			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 0,
					items: [
						makeItem({ title: 'Albums', itemKey: 'albums-fresh-key' })
					]
				})
			);
			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 1,
					items: [makeItem({ title: 'Some Album', itemKey: 'a1' })]
				})
			);

			renderLayout();
			const railBtn = await screen.findByRole('button', { name: 'Albums' });
			await fireEvent.click(railBtn);

			await waitFor(() => {
				expect(apiBrowse).toHaveBeenCalledTimes(4);
			});
			// Final history uses the FRESH key from label-walk, not
			// the stale cached one.
			const persisted = get(browseHistoryStore).history;
			expect(persisted).toHaveLength(1);
			expect(persisted[0].itemKey).toBe('albums-fresh-key');
		});

		it('entry without cachedKey still uses label-walk (back-compat for un-cached rails)', async () => {
			// Rail entries from the pre-fast-path build don't have
			// cachedKey. The fast path is skipped; label-walk runs.
			railWritable.set({
				entries: [
					{
						id: 'rail-albums',
						label: 'Albums',
						labelPath: ['Albums'],
						isEmpty: false
						// no cachedKey
					}
				],
				loading: false,
				error: null
			});

			apiBrowse.mockResolvedValueOnce(
				listResult({
					level: 0,
					items: [
						makeItem({ title: 'Albums', itemKey: 'albums-key' })
					]
				})
			);
			apiBrowse.mockResolvedValueOnce(
				listResult({ level: 1, items: [makeItem({ title: 'X', itemKey: 'x' })] })
			);

			renderLayout();
			const railBtn = await screen.findByRole('button', { name: 'Albums' });
			await fireEvent.click(railBtn);

			await waitFor(() => {
				expect(apiBrowse).toHaveBeenCalledTimes(2);
			});
			// Label-walk path: drill uses the itemKey scanned from
			// the root result.
			expect(apiBrowse.mock.calls[1][1]).toEqual(
				expect.objectContaining({ itemKey: 'albums-key' })
			);
		});
	});
});

describe('Layout — play-bar link (resolveAndNavigate)', () => {
	it('artist click pushes history with searchQuery set to the artist input (R7 regression guard)', async () => {
		// R7 regression: resolveAndNavigate once dropped the searchQuery
		// argument to pushHistory, so a future remount would treat the
		// search-rooted entry as orphaned and discard it. This test pins
		// the contract: the play-bar artist click must persist the input
		// as the top-level searchQuery.
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 'Cornflake Girl',
			artist: 'Tori Amos',
			album: 'Under the Pink',
			duration: 300,
			seek_position: 0
		});

		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Tori Amos',
						itemKey: 'fresh-artist-key',
						itemType: 'artist',
						subtitle: ''
					})
				]
			})
		);
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 1,
				items: [makeItem({ title: 'Albums', itemKey: 'albums-under-artist' })]
			})
		);

		renderLayout();
		const artistBtn = await screen.findByRole('button', { name: 'Tori Amos' });
		await fireEvent.click(artistBtn);

		await waitFor(() => {
			expect(apiBrowse).toHaveBeenCalledTimes(2);
		});

		expect(apiBrowse.mock.calls[0][1]).toEqual(
			expect.objectContaining({ hierarchy: 'search', input: 'Tori Amos', popAll: true })
		);
		expect(apiBrowse.mock.calls[1][1]).toEqual(
			expect.objectContaining({ hierarchy: 'search', itemKey: 'fresh-artist-key' })
		);

		const state = get(browseHistoryStore);
		expect(state.history).toHaveLength(1);
		expect(state.history[0]).toEqual(
			expect.objectContaining({
				hierarchy: 'search',
				itemKey: 'fresh-artist-key',
				breadcrumb: expect.objectContaining({ title: 'Tori Amos', itemType: 'artist' })
			})
		);
		expect(state.searchQuery).toBe('Tori Amos');

		const store = get(browseStore);
		expect(store.hierarchy).toBe('search');
		expect(store.current?.level).toBe(1);
	});

	it('M-2: drill failure leaves prior history + search context intact', async () => {
		// Old code: setSearchLoading + resetHistory + pushHistory ran
		// BEFORE the drill apiBrowse. A failing drill left searchLoading
		// stuck true, prior back stack wiped, and a search-rooted
		// history step pointing at the matched-but-undrilled itemKey.
		// New behavior: defer all mutations until drill succeeds.
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 'Cornflake Girl',
			artist: 'Tori Amos',
			album: 'Under the Pink',
			duration: 300,
			seek_position: 0
		});

		// Seed prior history + pane + search context. Crucially, seed
		// a prior `lastSearchQuery` — the old broken ordering called
		// setSearchLoading(opts.input) BEFORE the failing drill, which
		// would clobber lastSearchQuery to opts.input ('Tori Amos').
		// Pin the contract that the prior query survives a drill failure
		// (M-2 reopen: original test missed this assertion entirely).
		pushHistory({ hierarchy: 'browse', itemKey: 'prior-key' }, undefined, {
			title: 'Prior Page'
		});
		const priorResult = listResult({
			title: 'Prior Page',
			level: 1,
			items: [makeItem({ title: 'Prior Item', itemKey: 'prior-item-key' })]
		});
		// setSearchLoading flips searchLoading=true AND sets
		// lastSearchQuery; setBrowseResult clears searchLoading back
		// to false while preserving lastSearchQuery — leaving a
		// clean prior search context: lastSearchQuery='prior-query',
		// searchLoading=false, current=priorResult.
		setSearchLoading('prior-query');
		setBrowseResult(priorResult, 'browse');

		// Search succeeds (match found); drill rejects.
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Tori Amos',
						itemKey: 'fresh-artist-key',
						itemType: 'artist',
						subtitle: ''
					})
				]
			})
		);
		apiBrowse.mockRejectedValueOnce(new Error('drill failed'));

		renderLayout();
		const artistBtn = await screen.findByRole('button', { name: 'Tori Amos' });
		await fireEvent.click(artistBtn);

		await waitFor(async () => {
			const { commandFeedbackStore } = await import(
				'$lib/stores/commandFeedbackStore'
			);
			expect(get(commandFeedbackStore)?.message).toMatch(/Couldn't open/i);
		});

		// History untouched — prior back stack preserved.
		const histAfter = get(browseHistoryStore);
		expect(histAfter.history.map((s) => s.itemKey)).toEqual(['prior-key']);

		// browseStore unchanged — searchLoading not set, pane intact,
		// AND the prior lastSearchQuery is preserved (this is the
		// reopen-fix assertion that the old ordering would have failed).
		const storeAfter = get(browseStore);
		expect(storeAfter.searchLoading).toBe(false);
		expect(storeAfter.current).toBe(priorResult);
		expect(storeAfter.hierarchy).toBe('browse');
		expect(storeAfter.lastSearchQuery).toBe('prior-query');
	});

	it('M-2: search apiBrowse failure leaves prior history + search context intact', async () => {
		// First apiBrowse (the search itself) rejecting is the easier
		// case — no state should be mutated before that call returns.
		// Pin the contract anyway: a play-bar click that can't even
		// complete the search must not corrupt back state.
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 'Cornflake Girl',
			artist: 'Tori Amos',
			album: 'Under the Pink',
			duration: 300,
			seek_position: 0
		});

		pushHistory({ hierarchy: 'browse', itemKey: 'prior-key' }, undefined, {
			title: 'Prior Page'
		});
		const priorResult = listResult({
			title: 'Prior Page',
			level: 1,
			items: [makeItem({ title: 'Prior Item', itemKey: 'prior-item-key' })]
		});
		setBrowseResult(priorResult, 'browse');
		// Seed an unrelated lastSearchQuery to confirm it's not overwritten.
		setSearchLoading('prior-query');
		// setSearchLoading flips searchLoading=true; clear it back so
		// the failure-path assertion (searchLoading still false) is
		// meaningful.
		setBrowseResult(priorResult, 'browse');

		apiBrowse.mockRejectedValueOnce(new Error('search blew up'));

		renderLayout();
		const artistBtn = await screen.findByRole('button', { name: 'Tori Amos' });
		await fireEvent.click(artistBtn);

		await waitFor(async () => {
			const { commandFeedbackStore } = await import(
				'$lib/stores/commandFeedbackStore'
			);
			expect(get(commandFeedbackStore)?.message).toMatch(/Couldn't open/i);
		});

		const histAfter = get(browseHistoryStore);
		expect(histAfter.history.map((s) => s.itemKey)).toEqual(['prior-key']);

		const storeAfter = get(browseStore);
		expect(storeAfter.searchLoading).toBe(false);
		expect(storeAfter.current).toBe(priorResult);
		expect(storeAfter.lastSearchQuery).toBe('prior-query');
	});

	it('M-2: off-library drill failure does NOT stage a search-rooted history without goto', async () => {
		// Old code's bug: from a non-library route, the drill failure
		// left a search-rooted history step pushed but no goto fired.
		// A later visit to /library would replay that broken step.
		// New behavior: nothing is pushed until the drill succeeds.
		pageState.set({ url: new URL('http://localhost/queue') });

		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 'Cornflake Girl',
			artist: 'Tori Amos',
			album: 'Under the Pink',
			duration: 300,
			seek_position: 0
		});

		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({
						title: 'Tori Amos',
						itemKey: 'fresh-artist-key',
						itemType: 'artist',
						subtitle: ''
					})
				]
			})
		);
		apiBrowse.mockRejectedValueOnce(new Error('drill failed'));

		renderLayout();
		const artistBtn = await screen.findByRole('button', { name: 'Tori Amos' });
		await fireEvent.click(artistBtn);

		await waitFor(() => {
			expect(apiBrowse).toHaveBeenCalledTimes(2);
		});

		// No goto fired (drill failed before the commit branch).
		expect(gotoMock).not.toHaveBeenCalled();

		// No history pushed — a later /library visit must not see an
		// orphan search-rooted step.
		expect(get(browseHistoryStore).history).toEqual([]);
	});
});

describe('Layout — transport controls', () => {
	function setupActiveZone() {
		const zone = makeZone({
			zone_id: 'zone-a',
			outputs: [
				{
					output_id: 'out-a',
					display_name: 'Main',
					volume: { type: 'number', min: 0, max: 100, value: 50, step: 1, is_muted: false }
				}
			]
		});
		setZonesSnapshot([zone]);
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 'Cornflake Girl',
			artist: 'Tori Amos',
			album: 'Under the Pink',
			duration: 300,
			seek_position: 30
		});
	}

	it('Play/Pause button emits transport:play-pause for the active zone', async () => {
		setupActiveZone();
		renderLayout();
		// `aria-label` is "Pause" while state is 'playing'.
		const btn = await screen.findByRole('button', { name: 'Pause' });
		await fireEvent.click(btn);

		await waitFor(() => {
			expect(emitWithAck).toHaveBeenCalledWith(
				fakeSocket,
				'transport:play-pause',
				expect.objectContaining({ zone_id: 'zone-a' }),
				expect.objectContaining({ timeoutMs: 3000 })
			);
		});
	});

	it('Next button emits transport:next', async () => {
		setupActiveZone();
		renderLayout();
		const btn = await screen.findByRole('button', { name: 'Next' });
		await fireEvent.click(btn);

		await waitFor(() => {
			expect(emitWithAck).toHaveBeenCalledWith(
				fakeSocket,
				'transport:next',
				expect.objectContaining({ zone_id: 'zone-a' }),
				expect.any(Object)
			);
		});
	});

	it('Previous button emits transport:previous', async () => {
		setupActiveZone();
		renderLayout();
		const btn = await screen.findByRole('button', { name: 'Previous' });
		await fireEvent.click(btn);

		await waitFor(() => {
			expect(emitWithAck).toHaveBeenCalledWith(
				fakeSocket,
				'transport:previous',
				expect.objectContaining({ zone_id: 'zone-a' }),
				expect.any(Object)
			);
		});
	});

	it('Play/Pause button is rendered but disabled when no zone is selected', async () => {
		// No setupActiveZone — selectedZone is empty. The play-bar
		// transport buttons render unconditionally; canPlay falls to
		// false so the button is disabled. Clicking it is a no-op.
		renderLayout();
		await tick();
		const btn = await screen.findByRole('button', { name: 'Play' });
		expect(btn).toBeDisabled();
		await fireEvent.click(btn);
		expect(emitWithAck).not.toHaveBeenCalled();
	});

	it('Transport buttons disable when the zone forbids the action', async () => {
		// state: 'paused' → aria-label = 'Play' (isPlaying derives from
		// activeZone.state, not nowPlaying.state).
		const zone = makeZone({
			zone_id: 'zone-a',
			state: 'paused',
			is_play_allowed: false,
			is_pause_allowed: false,
			is_next_allowed: false,
			is_previous_allowed: false
		});
		setZonesSnapshot([zone]);
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'paused',
			title: 'X',
			artist: 'Y',
			album: 'Z',
			duration: 0,
			seek_position: 0
		});

		renderLayout();
		const play = await screen.findByRole('button', { name: 'Play' });
		const next = screen.getByRole('button', { name: 'Next' });
		const prev = screen.getByRole('button', { name: 'Previous' });
		expect(play).toBeDisabled();
		expect(next).toBeDisabled();
		expect(prev).toBeDisabled();
	});
});

describe('Layout — volume controls', () => {
	function setupAbsoluteVolumeZone() {
		const zone = makeZone({
			zone_id: 'zone-a',
			outputs: [
				{
					output_id: 'out-a',
					display_name: 'Main',
					volume: { type: 'number', min: 0, max: 100, value: 42, step: 1, is_muted: false }
				}
			]
		});
		setZonesSnapshot([zone]);
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 't',
			artist: 'a',
			album: 'al',
			duration: 100,
			seek_position: 0
		});
	}

	it('Volume +/- buttons emit transport:volume directly (no rAF) for incremental zones', async () => {
		// +/- buttons only render when volumeIsIncremental === true.
		// Use an incremental volume control (fixed-step amps/preamps).
		const zone = makeZone({
			zone_id: 'zone-a',
			outputs: [
				{
					output_id: 'out-a',
					display_name: 'Preamp',
					volume: {
						type: 'incremental',
						min: 0,
						max: 0,
						value: 0,
						step: 1,
						is_muted: false
					}
				}
			]
		});
		setZonesSnapshot([zone]);
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 't',
			artist: 'a',
			album: 'al',
			duration: 100,
			seek_position: 0
		});

		renderLayout();
		const up = await screen.findByRole('button', { name: 'Volume up' });
		await fireEvent.click(up);

		expect(emitWithAck).toHaveBeenCalledWith(
			fakeSocket,
			'transport:volume',
			expect.objectContaining({ output_id: 'out-a', value: 1 }),
			expect.any(Object)
		);
	});

	it('Volume slider coalesces multiple input events into one emit per animation frame', async () => {
		setupAbsoluteVolumeZone();

		// Stub rAF so we control when the flush fires. Capture the
		// callback so the test can decide when to invoke it.
		const rafCallbacks: FrameRequestCallback[] = [];
		const rafSpy = vi
			.spyOn(window, 'requestAnimationFrame')
			.mockImplementation((cb) => {
				rafCallbacks.push(cb);
				return rafCallbacks.length;
			});

		try {
			renderLayout();
			const slider = (await screen.findByLabelText('Volume')) as HTMLInputElement;

			// Three drag events back-to-back; each calls onVolumeSlide,
			// which sets pendingVolume and schedules ONE rAF (the first
			// time only). Subsequent input events update pendingVolume
			// without scheduling a new rAF.
			slider.value = '60';
			await fireEvent.input(slider);
			slider.value = '65';
			await fireEvent.input(slider);
			slider.value = '70';
			await fireEvent.input(slider);

			// Before the rAF fires: no emit yet.
			expect(emitWithAck).not.toHaveBeenCalled();
			// Only ONE rAF scheduled despite three input events.
			expect(rafCallbacks).toHaveLength(1);

			// Fire the rAF — should emit ONCE with the LATEST value (70).
			rafCallbacks[0](performance.now());
			await tick();
			expect(emitWithAck).toHaveBeenCalledTimes(1);
			expect(emitWithAck).toHaveBeenCalledWith(
				fakeSocket,
				'transport:volume',
				expect.objectContaining({ output_id: 'out-a', value: 70 }),
				expect.any(Object)
			);
		} finally {
			rafSpy.mockRestore();
		}
	});

	it('Volume slider is absent for fixed-volume zones (no volume control on output)', async () => {
		const zone = makeZone({
			zone_id: 'zone-a',
			outputs: [
				{ output_id: 'out-fixed', display_name: 'Fixed DAC' }
				// No volume field → fixed-volume output.
			]
		});
		setZonesSnapshot([zone]);
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 't',
			artist: 'a',
			album: 'al',
			duration: 100,
			seek_position: 0
		});

		renderLayout();
		await tick();
		expect(screen.queryByLabelText('Volume')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Volume up' })).toBeNull();
	});
});

describe('Layout — theme toggle', () => {
	it('toggle button flips themeStore dark ↔ light', async () => {
		// Force a known starting state.
		const initial = get(themeStore);
		const expectedAfterOne = initial === 'dark' ? 'light' : 'dark';

		renderLayout();
		const toggle = await screen.findByRole('button', { name: 'Toggle theme' });

		await fireEvent.click(toggle);
		expect(get(themeStore)).toBe(expectedAfterOne);

		await fireEvent.click(toggle);
		expect(get(themeStore)).toBe(initial);

		// Restore so subsequent tests see the original.
		if (get(themeStore) !== initial) {
			toggleTheme();
		}
	});
});

describe('Layout — seek bar', () => {
	it('click on the seek bar emits transport:seek at the proportional position', async () => {
		const zone = makeZone({
			zone_id: 'zone-a',
			seek_position: 30,
			is_seek_allowed: true
		});
		setZonesSnapshot([zone]);
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 't',
			artist: 'a',
			album: 'al',
			duration: 200, // 200s track
			seek_position: 30
		});

		const { container } = renderLayout();
		await tick();
		const bar = container.querySelector('.pb-progress-bar') as HTMLElement;
		expect(bar).toBeTruthy();

		// Stub getBoundingClientRect: bar is 400px wide starting at x=0.
		bar.getBoundingClientRect = () =>
			({
				left: 0,
				right: 400,
				width: 400,
				top: 0,
				bottom: 8,
				height: 8,
				x: 0,
				y: 0,
				toJSON: () => ({})
			}) as DOMRect;

		// Click at 100px = 25% of 400px = 50s of 200s.
		await fireEvent.click(bar, { clientX: 100 });

		expect(emitWithAck).toHaveBeenCalledWith(
			fakeSocket,
			'transport:seek',
			expect.objectContaining({ zone_id: 'zone-a', seconds: 50 }),
			expect.any(Object)
		);
	});

	it('seek bar does NOT emit when zone forbids seeking', async () => {
		const zone = makeZone({
			zone_id: 'zone-a',
			is_seek_allowed: false
		});
		setZonesSnapshot([zone]);
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 't',
			artist: 'a',
			album: 'al',
			duration: 200,
			seek_position: 30
		});

		const { container } = renderLayout();
		await tick();
		const bar = container.querySelector('.pb-progress-bar') as HTMLElement;
		bar.getBoundingClientRect = () =>
			({
				left: 0,
				right: 400,
				width: 400,
				top: 0,
				bottom: 8,
				height: 8,
				x: 0,
				y: 0,
				toJSON: () => ({})
			}) as DOMRect;

		await fireEvent.click(bar, { clientX: 100 });
		expect(emitWithAck).not.toHaveBeenCalledWith(
			fakeSocket,
			'transport:seek',
			expect.anything(),
			expect.anything()
		);
	});
});

describe('Layout — play-bar → now-playing overlay wiring (PR2)', () => {
	// PR2 replaced the play-bar title's "navigate to album" behavior
	// with "open the now-playing overlay" (album navigation now lives
	// inside the overlay as a "Go to album" button). The artwork is
	// also a button for the same purpose.
	it('clicking the play-bar artwork opens the now-playing overlay', async () => {
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 'Cornflake Girl',
			artist: 'Tori Amos',
			album: 'Under the Pink',
			image_key: 'img-x',
			duration: 200,
			seek_position: 0
		});

		const { nowPlayingOverlayStore, closeNowPlayingOverlay } = await import(
			'$lib/stores/nowPlayingOverlayStore'
		);
		closeNowPlayingOverlay();

		renderLayout();
		const artBtn = await screen.findByRole('button', { name: 'Open now playing' });
		expect(get(nowPlayingOverlayStore)).toBe(false);
		await fireEvent.click(artBtn);
		expect(get(nowPlayingOverlayStore)).toBe(true);
		closeNowPlayingOverlay();
	});

	it('clicking the play-bar title opens the now-playing overlay (no album navigation)', async () => {
		setSelectedZone('zone-a');
		setNowPlaying('zone-a', {
			zone_id: 'zone-a',
			state: 'playing',
			title: 'Cornflake Girl',
			artist: 'Tori Amos',
			album: 'Under the Pink',
			duration: 200,
			seek_position: 0
		});

		const { nowPlayingOverlayStore, closeNowPlayingOverlay } = await import(
			'$lib/stores/nowPlayingOverlayStore'
		);
		closeNowPlayingOverlay();

		renderLayout();
		const titleBtn = await screen.findByRole('button', { name: 'Cornflake Girl' });
		await fireEvent.click(titleBtn);
		expect(get(nowPlayingOverlayStore)).toBe(true);
		// Title click no longer triggers apiBrowse — navigation moved
		// into the overlay's "Go to album" button.
		expect(apiBrowse).not.toHaveBeenCalled();
		closeNowPlayingOverlay();
	});

	it('artwork button is disabled when there is no track playing', async () => {
		// No nowPlaying for the selected zone.
		setSelectedZone('zone-a');
		renderLayout();
		const artBtn = await screen.findByRole('button', { name: 'Open now playing' });
		expect(artBtn).toBeDisabled();
	});
});
