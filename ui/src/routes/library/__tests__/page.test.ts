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

vi.mock('$lib/api/client', () => ({
	browse: (...args: any[]) => apiBrowse(...(args as [unknown, any])),
	browseLoad: (...args: any[]) => apiBrowseLoad(...(args as [unknown, any]))
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

// $app/navigation isn't used by Library directly, but the Search child
// component imports nothing from it. Provide a stub anyway so any
// transitive import resolves.
vi.mock('$app/navigation', () => ({
	goto: vi.fn()
}));

// Import after mocks so the page picks them up.
import LibraryPage from '../+page.svelte';
import { browseHistoryStore, resetHistory, pushHistory } from '$lib/stores/browseHistoryStore';
import { browseStore, setSearchLoading } from '$lib/stores/browseStore';
import { setSelectedZone } from '$lib/stores/selectedZoneStore';

// ---------------- Helpers ----------------

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

beforeEach(() => {
	apiBrowse.mockReset();
	apiBrowseLoad.mockReset();
	fakeSocket.emit.mockReset();
	resetHistory();
	setSelectedZone('');
	// Default: any apiBrowse call returns an empty browse root.
	apiBrowse.mockResolvedValue(listResult({ level: 0 }));
});

// ---------------- Tests ----------------

describe('Library page — mount restore', () => {
	it('with empty history, pops to root via REST', async () => {
		render(LibraryPage);
		await waitFor(() => {
			expect(apiBrowse).toHaveBeenCalledTimes(1);
		});
		expect(apiBrowse).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ hierarchy: 'browse', popAll: true })
		);
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

	it('with search-rooted history + saved query, re-seeds search then walks', async () => {
		pushHistory(
			{ hierarchy: 'search', itemKey: 's1', multiSessionKey: 'library-search' },
			'beatles'
		);

		apiBrowse.mockResolvedValueOnce(listResult({ level: 0 })); // re-seed
		apiBrowse.mockResolvedValueOnce(listResult({ level: 1 })); // s1 drill

		render(LibraryPage);

		await waitFor(() => {
			expect(apiBrowse).toHaveBeenCalledTimes(2);
		});

		expect(apiBrowse.mock.calls[0][1]).toEqual(
			expect.objectContaining({
				hierarchy: 'search',
				input: 'beatles',
				popAll: true,
				multiSessionKey: 'library-search'
			})
		);
		expect(apiBrowse.mock.calls[1][1]).toEqual(
			expect.objectContaining({
				hierarchy: 'search',
				itemKey: 's1',
				multiSessionKey: 'library-search'
			})
		);
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
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [
					makeItem({ title: 'Albums', itemKey: 'albums' }),
					makeItem({ title: 'Artists', itemKey: 'artists' })
				]
			})
		);

		render(LibraryPage);

		expect(await screen.findByText('Albums')).toBeInTheDocument();
		expect(await screen.findByText('Artists')).toBeInTheDocument();
	});
});

describe('Library page — navigation actions', () => {
	it('clicking a list item emits browse:browse with the item key and records history', async () => {
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 0,
				items: [makeItem({ title: 'Albums', itemKey: 'albums' })]
			})
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

	it('Home (browseNavStore.home) resets history and re-pops to root', async () => {
		// Seed prior history so we can confirm it gets cleared.
		pushHistory({ hierarchy: 'browse', itemKey: 'deep' });

		apiBrowse.mockResolvedValueOnce(listResult({ level: 0 })); // mount popAll
		apiBrowse.mockResolvedValueOnce(listResult({ level: 1 })); // mount step
		apiBrowse.mockResolvedValueOnce(listResult({ level: 0 })); // home popAll

		render(LibraryPage);
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(2));

		// Home is exposed via browseNavStore by Library's onMount.
		const { browseNavStore } = await import('$lib/stores/browseNavStore');
		const nav = get(browseNavStore);

		// Home routes through the socket (browse function) — assert socket
		// emit + history reset rather than apiBrowse here.
		nav.home();
		await tick();

		expect(fakeSocket.emit).toHaveBeenCalledWith(
			'browse:browse',
			expect.objectContaining({ hierarchy: 'browse', popAll: true })
		);
		expect(get(browseHistoryStore).history).toEqual([]);
		expect(get(browseHistoryStore).forward).toEqual([]);
	});

	it('Back (browseNavStore.back) calls browse:pop and moves the step to forward', async () => {
		apiBrowse.mockResolvedValueOnce(listResult({ level: 0 })); // mount popAll
		render(LibraryPage);
		await waitFor(() => expect(apiBrowse).toHaveBeenCalled());

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
		await waitFor(() => expect(apiBrowse).toHaveBeenCalled());

		// Direct loading toggle covers what setBrowseLoading does on the
		// browse panel — the Library page's results-panel switches to the
		// "Loading library data..." copy.
		const { setBrowseLoading } = await import('$lib/stores/browseStore');
		setBrowseLoading('browse');
		await tick();

		expect(await screen.findByText(/loading library data/i)).toBeInTheDocument();
	});
});

describe('Library page — quickPlay', () => {
	function setUpRoot(items: BrowseItem[] = []) {
		// First call is the mount popAll. Subsequent calls are queued by
		// the test for the quickPlay flow.
		apiBrowse.mockResolvedValueOnce(listResult({ level: 0, items }));
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
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(3));

		expect(apiBrowse.mock.calls[1][1]).toEqual(
			expect.objectContaining({
				hierarchy: 'browse',
				itemKey: 'track-key',
				zoneId: 'zone-living-room'
			})
		);
		expect(apiBrowse.mock.calls[2][1]).toEqual(
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
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(2));
		await tick();

		// Fallback path emits browse:browse via socket and records history.
		expect(fakeSocket.emit).toHaveBeenCalledWith(
			'browse:browse',
			expect.objectContaining({ itemKey: 'track-key' })
		);
		expect(get(browseHistoryStore).history.map((s) => s.itemKey)).toEqual(['track-key']);
	});

	it('pushes a feedback toast and skips REST calls when no zone is selected', async () => {
		const track = makeItem({ title: 'Play Album', itemKey: 'track-key', hint: 'action_list' });
		setUpRoot([track]);

		setSelectedZone('');
		render(LibraryPage);
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(1)); // mount popAll only

		const btn = await screen.findByRole('button', { name: 'Play Album' });
		btn.click();
		await tick();

		// No additional apiBrowse calls after the mount popAll.
		expect(apiBrowse).toHaveBeenCalledTimes(1);

		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message).toMatch(/select a zone/i);
	});

	it('does not pop the album view when starting in the search hierarchy', async () => {
		// Set up a search-rooted state so $browseStore.hierarchy === 'search'.
		// Then click an action_list item to trigger quickPlay; the popInternal
		// branch only runs when hierarchyAtStart === 'browse'.
		pushHistory(
			{ hierarchy: 'search', itemKey: 's1', multiSessionKey: 'library-search' },
			'beatles'
		);
		// Mount: re-seed search + walk drill step. Drill returns one action_list track.
		const track = makeItem({ title: 'Play Album', itemKey: 'track-key', hint: 'action_list' });
		apiBrowse.mockResolvedValueOnce(listResult({ level: 0 })); // search re-seed
		apiBrowse.mockResolvedValueOnce(listResult({ level: 1, items: [track] })); // drill
		// quickPlay action lookup + execute
		apiBrowse.mockResolvedValueOnce(
			listResult({
				level: 2,
				items: [makeItem({ title: 'Play Now', itemKey: 'pn', hint: 'action', isPlayable: true })]
			})
		);
		apiBrowse.mockResolvedValueOnce(listResult({ level: 2 }));

		setSelectedZone('zone-living-room');
		render(LibraryPage);
		const btn = await screen.findByRole('button', { name: 'Play Album' });
		btn.click();
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(4));
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
		await waitFor(() => expect(apiBrowse).toHaveBeenCalledTimes(2));
		await tick();

		const { commandFeedbackStore } = await import('$lib/stores/commandFeedbackStore');
		expect(get(commandFeedbackStore)?.message).toMatch(/Roon timed out/);
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
		apiBrowse.mockResolvedValueOnce(listResult({ level: 2, items }));

		render(LibraryPage);
		await waitFor(() => expect(apiBrowse).toHaveBeenCalled());
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
		apiBrowse.mockResolvedValueOnce(listResult({ level: 2, items }));

		render(LibraryPage);
		await waitFor(() => expect(apiBrowse).toHaveBeenCalled());
		await tick();

		expect(screen.queryByLabelText(/alphabetic index/i)).toBeNull();
	});

	it('clicking a letter scrolls to the section anchor when it is loaded', async () => {
		const items: BrowseItem[] = [];
		for (let i = 0; i < 6; i++) items.push(makeItem({ title: `A${i}`, itemKey: `a${i}` }));
		for (let i = 0; i < 6; i++) items.push(makeItem({ title: `B${i}`, itemKey: `b${i}` }));
		for (let i = 0; i < 9; i++) items.push(makeItem({ title: `C${i}`, itemKey: `c${i}` }));
		apiBrowse.mockResolvedValueOnce(listResult({ level: 2, items }));

		render(LibraryPage);
		await waitFor(() => expect(apiBrowse).toHaveBeenCalled());
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
		apiBrowse.mockResolvedValueOnce(
			listResult({ level: 2, items, totalCount: 30, count: 30 })
		);

		render(LibraryPage);
		await waitFor(() => expect(apiBrowse).toHaveBeenCalled());
		await tick();

		expect(await screen.findByText(/showing 21 of 30/i)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /load more/i })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /load all/i })).toBeInTheDocument();
	});

	it('"Load more" calls apiBrowseLoad with the right offset/count and appends items', async () => {
		const initial = Array.from({ length: 21 }, (_, i) =>
			makeItem({ title: `Item ${i}`, itemKey: `k${i}` })
		);
		apiBrowse.mockResolvedValueOnce(
			listResult({ level: 2, items: initial, totalCount: 100, count: 100 })
		);
		const more = Array.from({ length: 79 }, (_, i) =>
			makeItem({ title: `Extra ${i}`, itemKey: `extra${i}` })
		);
		apiBrowseLoad.mockResolvedValueOnce(listResult({ level: 2, items: more.slice(0, 79) }));

		render(LibraryPage);
		await waitFor(() => expect(apiBrowse).toHaveBeenCalled());
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
});
