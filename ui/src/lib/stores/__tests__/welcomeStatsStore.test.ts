import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import type { BrowseResult } from '@shared/types';

const apiBrowse = vi.fn<(_fetch: unknown, opts: any) => Promise<BrowseResult>>();

vi.mock('$lib/api/client', () => ({
	browse: (...args: any[]) => apiBrowse(...(args as [unknown, any]))
}));

import {
	welcomeStatsStore,
	loadWelcomeStats,
	invalidateWelcomeStats
} from '../welcomeStatsStore';

function listResult(over: Partial<BrowseResult> = {}): BrowseResult {
	return {
		title: over.title ?? 'Browse',
		subtitle: over.subtitle,
		level: over.level ?? 0,
		offset: over.offset ?? 0,
		count: over.count ?? 0,
		totalCount: over.totalCount ?? 0,
		items: over.items ?? []
	};
}

beforeEach(() => {
	apiBrowse.mockReset();
	invalidateWelcomeStats();
});

describe('welcomeStatsStore — loadWelcomeStats', () => {
	it('loads four totals via dedicated hierarchies when `tracks` works', async () => {
		// Each call returns a different totalCount so we can verify
		// the store wired each hierarchy to the right field.
		apiBrowse.mockImplementation(async (_f, opts) => {
			const totals: Record<string, number> = {
				artists: 1667,
				albums: 3962,
				composers: 9455,
				tracks: 57583
			};
			return listResult({ totalCount: totals[opts.hierarchy] ?? 0 });
		});

		await loadWelcomeStats(fetch);

		const state = get(welcomeStatsStore);
		expect(state).toEqual({
			artists: 1667,
			albums: 3962,
			composers: 9455,
			tracks: 57583,
			loading: false,
			loaded: true
		});

		// Each call used its own multiSessionKey + popAll: true.
		const calls = apiBrowse.mock.calls;
		expect(calls).toHaveLength(4);
		for (const [, opts] of calls) {
			expect(opts.multiSessionKey).toMatch(/^welcome-stats-/);
			expect(opts.popAll).toBe(true);
		}
	});

	it('falls back to drilling browse → Library → Tracks when `tracks` hierarchy errors', async () => {
		apiBrowse.mockImplementation(async (_f, opts) => {
			if (opts.hierarchy === 'artists') return listResult({ totalCount: 100 });
			if (opts.hierarchy === 'albums') return listResult({ totalCount: 200 });
			if (opts.hierarchy === 'composers') return listResult({ totalCount: 300 });
			if (opts.hierarchy === 'tracks') throw new Error('unsupported hierarchy');
			// Fallback: browse → Library → Tracks.
			if (opts.hierarchy === 'browse') {
				if (opts.popAll) {
					// Fresh root.
					return listResult({
						items: [
							{
								title: 'Library',
								itemKey: 'lib-key',
								hint: 'list',
								itemType: undefined,
								isLoadable: true,
								isPlayable: false
							}
						]
					});
				}
				if (opts.itemKey === 'lib-key') {
					// Library children.
					return listResult({
						items: [
							{
								title: 'Tracks',
								itemKey: 'tracks-key',
								hint: 'list',
								itemType: undefined,
								isLoadable: true,
								isPlayable: false
							}
						]
					});
				}
				if (opts.itemKey === 'tracks-key') {
					// Final track-list page with the total we want.
					return listResult({ totalCount: 57583 });
				}
			}
			throw new Error(`Unexpected call: ${JSON.stringify(opts)}`);
		});

		await loadWelcomeStats(fetch);

		const state = get(welcomeStatsStore);
		expect(state.tracks).toBe(57583);
		// Fallback uses a single dedicated multiSessionKey across its
		// three drills so they share the session.
		const fallbackCalls = apiBrowse.mock.calls.filter(
			([, opts]) => opts.multiSessionKey === 'welcome-stats-tracks-fallback'
		);
		expect(fallbackCalls).toHaveLength(3);
	});

	it('records null for any stat whose fetch fails — others still load', async () => {
		apiBrowse.mockImplementation(async (_f, opts) => {
			if (opts.hierarchy === 'artists') return listResult({ totalCount: 100 });
			if (opts.hierarchy === 'albums') throw new Error('roon nope');
			if (opts.hierarchy === 'composers') return listResult({ totalCount: 300 });
			if (opts.hierarchy === 'tracks') throw new Error('unsupported');
			if (opts.hierarchy === 'browse') throw new Error('also nope'); // tracks fallback fails
			throw new Error(`Unexpected: ${JSON.stringify(opts)}`);
		});

		await loadWelcomeStats(fetch);

		const state = get(welcomeStatsStore);
		expect(state.artists).toBe(100);
		expect(state.albums).toBeNull();
		expect(state.composers).toBe(300);
		expect(state.tracks).toBeNull();
		expect(state.loaded).toBe(true);
	});

	it('falls back to count when totalCount is missing', async () => {
		apiBrowse.mockImplementation(async (_f, opts) => {
			if (opts.hierarchy === 'artists')
				return { ...listResult(), count: 42, totalCount: undefined as any };
			return listResult({ totalCount: 0 });
		});

		await loadWelcomeStats(fetch);

		expect(get(welcomeStatsStore).artists).toBe(42);
	});
});

describe('welcomeStatsStore — race protection', () => {
	it('ignores a stale completion that arrives after a newer one', async () => {
		// Call A is slow and returns wrong values; call B finishes first.
		let resolveA: () => void = () => {};
		const aGate = new Promise<void>((resolve) => {
			resolveA = resolve;
		});

		apiBrowse.mockImplementationOnce(async () => {
			await aGate;
			return listResult({ totalCount: 999 });
		});
		apiBrowse.mockImplementation(async () => listResult({ totalCount: 999 }));

		const callA = loadWelcomeStats(fetch);

		// Now reset and run a second loadWelcomeStats (B) that completes
		// quickly with the correct values.
		apiBrowse.mockReset();
		apiBrowse.mockImplementation(async (_f, opts) => {
			const totals: Record<string, number> = {
				artists: 7,
				albums: 8,
				composers: 9,
				tracks: 10
			};
			return listResult({ totalCount: totals[opts.hierarchy] ?? 0 });
		});
		await loadWelcomeStats(fetch);

		// B's values committed.
		expect(get(welcomeStatsStore)).toEqual({
			artists: 7,
			albums: 8,
			composers: 9,
			tracks: 10,
			loading: false,
			loaded: true
		});

		// Now release A. Its completion is stale — must not overwrite.
		resolveA();
		await callA;

		expect(get(welcomeStatsStore)).toEqual({
			artists: 7,
			albums: 8,
			composers: 9,
			tracks: 10,
			loading: false,
			loaded: true
		});
	});

	it('invalidate clears the store', async () => {
		apiBrowse.mockResolvedValue(listResult({ totalCount: 5 }));
		await loadWelcomeStats(fetch);
		expect(get(welcomeStatsStore).loaded).toBe(true);

		invalidateWelcomeStats();
		expect(get(welcomeStatsStore)).toEqual({
			artists: null,
			albums: null,
			composers: null,
			tracks: null,
			loading: false,
			loaded: false
		});
	});
});
