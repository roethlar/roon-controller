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
	resetHistory
} from '$lib/stores/browseHistoryStore';
import { pendingSearchStore } from '$lib/stores/pendingSearchStore';
import { setNowPlaying, resetNowPlaying } from '$lib/stores/nowPlayingStore';
import { setSelectedZone } from '$lib/stores/selectedZoneStore';
import { resetBrowse, browseStore } from '$lib/stores/browseStore';

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
	});

	it('navigates to /library when clicked from another route', async () => {
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

		renderLayout();
		const railBtn = await screen.findByRole('button', { name: 'Albums' });
		await fireEvent.click(railBtn);

		await waitFor(() => {
			expect(gotoMock).toHaveBeenCalledWith('/library');
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
});
