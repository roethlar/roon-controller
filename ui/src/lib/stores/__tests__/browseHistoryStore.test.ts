import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import type { BrowseOptions } from '@shared/types';

// Re-import the store fresh in each test so module-level state (the
// `internal` writable, populated from sessionStorage at import time) is
// re-evaluated against a clean storage. Without this, tests that depend
// on `readPersisted` running fresh would race against module init order.
async function importStore() {
	vi.resetModules();
	return await import('../browseHistoryStore');
}

const STORAGE_KEY = 'roon-controller-browse-history-v3';

const browse = (k: string): BrowseOptions => ({ hierarchy: 'browse', itemKey: k });
const search = (k: string): BrowseOptions => ({ hierarchy: 'search', itemKey: k });

describe('browseHistoryStore', () => {
	beforeEach(() => {
		sessionStorage.clear();
	});

	describe('pushHistory', () => {
		it('appends within the same hierarchy', async () => {
			const store = await importStore();
			store.pushHistory(browse('a'));
			store.pushHistory(browse('b'));

			expect(get(store.browseHistoryStore).history.map((s) => s.itemKey)).toEqual(['a', 'b']);
		});

		it('clears the stack when switching hierarchies (browse → search)', async () => {
			const store = await importStore();
			store.pushHistory(browse('a'));
			store.pushHistory(browse('b'));
			store.pushHistory(search('s1'), 'jazz');

			const state = get(store.browseHistoryStore);
			expect(state.history.map((s) => s.itemKey)).toEqual(['s1']);
			expect(state.searchQuery).toBe('jazz');
		});

		it('clears the stack when switching hierarchies (search → browse)', async () => {
			const store = await importStore();
			store.pushHistory(search('s1'), 'jazz');
			store.pushHistory(browse('a'));

			const state = get(store.browseHistoryStore);
			expect(state.history.map((s) => s.itemKey)).toEqual(['a']);
			expect(state.searchQuery).toBe(null);
		});

		it('preserves searchQuery when continuing in the same search hierarchy', async () => {
			const store = await importStore();
			store.pushHistory(search('s1'), 'jazz');
			store.pushHistory(search('s2'));

			expect(get(store.browseHistoryStore).searchQuery).toBe('jazz');
		});

		it('clears the forward stack on every push', async () => {
			const store = await importStore();
			store.pushHistory(browse('a'));
			store.pushHistory(browse('b'));
			store.popHistory();
			expect(get(store.browseHistoryStore).forward.length).toBe(1);
			store.pushHistory(browse('c'));
			expect(get(store.browseHistoryStore).forward.length).toBe(0);
		});
	});

	describe('popHistory / popForward', () => {
		it('moves the last entry to the forward stack and back', async () => {
			const store = await importStore();
			store.pushHistory(browse('a'));
			store.pushHistory(browse('b'));

			const popped = store.popHistory();
			expect(popped?.itemKey).toBe('b');
			let state = get(store.browseHistoryStore);
			expect(state.history.map((s) => s.itemKey)).toEqual(['a']);
			expect(state.forward.map((s) => s.itemKey)).toEqual(['b']);

			const forwardPopped = store.popForward();
			expect(forwardPopped?.itemKey).toBe('b');
			state = get(store.browseHistoryStore);
			expect(state.history.map((s) => s.itemKey)).toEqual(['a', 'b']);
			expect(state.forward.length).toBe(0);
		});

		it('returns undefined when stacks are empty', async () => {
			const store = await importStore();
			expect(store.popHistory()).toBeUndefined();
			expect(store.popForward()).toBeUndefined();
		});
	});

	describe('resetHistory', () => {
		it('empties everything', async () => {
			const store = await importStore();
			store.pushHistory(search('s1'), 'jazz');
			store.pushHistory(search('s2'));
			store.resetHistory();

			const state = get(store.browseHistoryStore);
			expect(state.history).toEqual([]);
			expect(state.forward).toEqual([]);
			expect(state.searchQuery).toBe(null);
		});
	});

	describe('persistence', () => {
		it('writes to sessionStorage on push', async () => {
			const store = await importStore();
			store.pushHistory(browse('a'));

			const raw = sessionStorage.getItem(STORAGE_KEY);
			expect(raw).not.toBeNull();
			const parsed = JSON.parse(raw!);
			expect(parsed.history[0].itemKey).toBe('a');
		});

		it('rehydrates from sessionStorage on import', async () => {
			sessionStorage.setItem(
				STORAGE_KEY,
				JSON.stringify({ history: [browse('a'), browse('b')], forward: [], searchQuery: null })
			);
			const store = await importStore();

			expect(get(store.browseHistoryStore).history.map((s) => s.itemKey)).toEqual(['a', 'b']);
		});
	});

	describe('readPersisted sanitization', () => {
		it('trims a mixed-hierarchy history to the contiguous tail', async () => {
			// Simulates legacy data from before pushHistory enforced single
			// hierarchy: [browse, browse, search] should restore as [search].
			sessionStorage.setItem(
				STORAGE_KEY,
				JSON.stringify({
					history: [browse('a'), browse('b'), search('s1')],
					forward: [],
					searchQuery: 'jazz'
				})
			);
			const store = await importStore();

			const state = get(store.browseHistoryStore);
			expect(state.history.map((s) => s.itemKey)).toEqual(['s1']);
			expect(state.searchQuery).toBe('jazz');
		});

		it('keeps forward when its hierarchy matches the sanitized history tail', async () => {
			// History truncates browse('a'), surviving as [search('s1')].
			// The forward step is also search — it belongs with the
			// surviving thread, so it's a legitimate forward target.
			sessionStorage.setItem(
				STORAGE_KEY,
				JSON.stringify({
					history: [browse('a'), search('s1')],
					forward: [search('s2')],
					searchQuery: 'jazz'
				})
			);
			const store = await importStore();

			expect(get(store.browseHistoryStore).forward.map((s) => s.itemKey)).toEqual(['s2']);
		});

		it('discards forward when its hierarchy does not match a truncated history', async () => {
			// History [browse, search] sanitizes to [search]. Forward is
			// browse — abandoned context, must be dropped to prevent
			// popForward from splicing a foreign hierarchy into history.
			sessionStorage.setItem(
				STORAGE_KEY,
				JSON.stringify({
					history: [browse('a'), search('s1')],
					forward: [browse('b')],
					searchQuery: 'jazz'
				})
			);
			const store = await importStore();

			expect(get(store.browseHistoryStore).forward).toEqual([]);
		});

		it('discards forward when its hierarchy does not match history', async () => {
			// The forward-stack migration case — history wasn't truncated
			// but forward is from a different context.
			sessionStorage.setItem(
				STORAGE_KEY,
				JSON.stringify({
					history: [browse('a')],
					forward: [search('s1')],
					searchQuery: null
				})
			);
			const store = await importStore();

			const state = get(store.browseHistoryStore);
			expect(state.history.map((s) => s.itemKey)).toEqual(['a']);
			expect(state.forward).toEqual([]);
		});

		it('discards forward when history is empty', async () => {
			sessionStorage.setItem(
				STORAGE_KEY,
				JSON.stringify({ history: [], forward: [browse('a')], searchQuery: null })
			);
			const store = await importStore();

			expect(get(store.browseHistoryStore).forward).toEqual([]);
		});

		it('clears searchQuery when sanitized tail is not search', async () => {
			sessionStorage.setItem(
				STORAGE_KEY,
				JSON.stringify({ history: [browse('a')], forward: [], searchQuery: 'jazz' })
			);
			const store = await importStore();

			expect(get(store.browseHistoryStore).searchQuery).toBe(null);
		});

		it('returns empty state on malformed JSON', async () => {
			sessionStorage.setItem(STORAGE_KEY, 'not-json');
			const store = await importStore();

			const state = get(store.browseHistoryStore);
			expect(state).toEqual({ history: [], forward: [], searchQuery: null });
		});

		it('ignores entries from older schema (different storage key)', async () => {
			// v1/v2 entries — newer reader uses v3 key.
			sessionStorage.setItem(
				'roon-controller-browse-history-v2',
				JSON.stringify({ history: [browse('legacy')], forward: [] })
			);
			const store = await importStore();

			expect(get(store.browseHistoryStore).history).toEqual([]);
		});
	});
});
