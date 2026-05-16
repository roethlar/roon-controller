import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/svelte';
import { writable, get } from 'svelte/store';
import { tick, createRawSnippet } from 'svelte';
import type { BrowseResult, BrowseItem, BrowseOptions } from '@shared/types';

const { railWritable, gotoMock, apiBrowse } = vi.hoisted(() => {
	const { writable: w } = require('svelte/store') as typeof import('svelte/store');
	const rail = w<{
		entries: Array<{ id: string; label: string; labelPath: string[]; isEmpty: boolean }>;
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

const fakeSocket = {
	emit: vi.fn(),
	on: vi.fn(),
	off: vi.fn(),
	connected: true,
	io: { on: vi.fn(), off: vi.fn() }
};
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
import {
	resetBrowse,
	browseStore,
	setBrowseResult,
	setSearchLoading
} from '$lib/stores/browseStore';

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
		itemKey: over.itemKey,
		hint: over.hint ?? 'list',
		imageKey: over.imageKey,
		isLoadable: over.isLoadable ?? true,
		isPlayable: over.isPlayable ?? false,
		itemType: over.itemType
	};
}

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
});

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
