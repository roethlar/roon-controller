import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import type { RecentlyPlayedEntry, RecentlyPlayedSnapshot } from '@shared/types';

const fetchRecentlyPlayed = vi.fn<(_fetch: unknown) => Promise<RecentlyPlayedSnapshot>>();

vi.mock('$lib/api/client', () => ({
	fetchRecentlyPlayed: (...args: any[]) => fetchRecentlyPlayed(...(args as [unknown]))
}));

import {
	recentlyPlayedStore,
	loadRecentlyPlayed,
	applyRecentlyPlayedInserted,
	applyRecentlyPlayedCleared,
	applyClearResponse,
	resetRecentlyPlayed
} from '../recentlyPlayedStore';

function makeEntry(over: Partial<RecentlyPlayedEntry> = {}): RecentlyPlayedEntry {
	return {
		title: 'Track',
		artist: 'Artist',
		album: 'Album',
		duration: 180,
		image_key: 'img',
		zone_id: 'zone-a',
		zone_name: 'Living Room',
		played_at: '2026-05-08T00:00:00.000Z',
		...over
	};
}

function snapshot(
	entries: RecentlyPlayedEntry[],
	revision: number
): RecentlyPlayedSnapshot {
	return { entries, revision };
}

beforeEach(() => {
	fetchRecentlyPlayed.mockReset();
	resetRecentlyPlayed();
});

describe('recentlyPlayedStore', () => {
	it('loads entries via REST and marks store as loaded', async () => {
		fetchRecentlyPlayed.mockResolvedValueOnce(
			snapshot(
				[
					makeEntry({ title: 'A', played_at: '2026-05-08T00:00:00.000Z' }),
					makeEntry({ title: 'B', played_at: '2026-05-08T00:00:00.000Z', album: 'Album B' })
				],
				5
			)
		);

		await loadRecentlyPlayed(fetch);

		const state = get(recentlyPlayedStore);
		expect(state.entries.map((e) => e.title)).toEqual(['A', 'B']);
		expect(state.loading).toBe(false);
		expect(state.loaded).toBe(true);
	});

	it('survives REST failure: keeps existing entries, clears loading', async () => {
		fetchRecentlyPlayed.mockResolvedValueOnce(snapshot([makeEntry({ title: 'A' })], 1));
		await loadRecentlyPlayed(fetch);
		expect(get(recentlyPlayedStore).entries).toHaveLength(1);

		fetchRecentlyPlayed.mockRejectedValueOnce(new Error('network blip'));
		await loadRecentlyPlayed(fetch);

		const state = get(recentlyPlayedStore);
		expect(state.entries.map((e) => e.title)).toEqual(['A']);
		expect(state.loading).toBe(false);
	});

	it('socket insert unshifts a new entry to the top (newer revision)', async () => {
		fetchRecentlyPlayed.mockResolvedValueOnce(
			snapshot([makeEntry({ title: 'Older', played_at: '2026-05-07T00:00:00.000Z' })], 1)
		);
		await loadRecentlyPlayed(fetch);

		applyRecentlyPlayedInserted({
			entry: makeEntry({ title: 'Newer', played_at: '2026-05-08T00:00:00.000Z' }),
			revision: 2
		});

		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual(['Newer', 'Older']);
	});

	it('socket insert bubbles a replayed track to the top instead of duplicating', async () => {
		fetchRecentlyPlayed.mockResolvedValueOnce(
			snapshot(
				[
					makeEntry({ title: 'A', played_at: '2026-05-08T00:00:01.000Z' }),
					makeEntry({ title: 'B', played_at: '2026-05-08T00:00:00.000Z', album: 'Album B' })
				],
				2
			)
		);
		await loadRecentlyPlayed(fetch);

		// Backend bubbled a replay of A. The store must drop the prior
		// A and unshift the fresh one — even from a different zone,
		// since the shared dedupe key excludes zone_id / played_at.
		applyRecentlyPlayedInserted({
			entry: makeEntry({
				title: 'A',
				zone_id: 'zone-b',
				played_at: '2026-05-08T00:00:05.000Z'
			}),
			revision: 3
		});

		const entries = get(recentlyPlayedStore).entries;
		expect(entries.map((e) => e.title)).toEqual(['A', 'B']);
		expect(entries[0].zone_id).toBe('zone-b');
	});

	it('socket insert with stale revision is discarded', async () => {
		fetchRecentlyPlayed.mockResolvedValueOnce(snapshot([makeEntry({ title: 'A' })], 5));
		await loadRecentlyPlayed(fetch);
		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual(['A']);

		// Older revision than what we've already applied — discard.
		applyRecentlyPlayedInserted({
			entry: makeEntry({ title: 'Stale' }),
			revision: 3
		});

		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual(['A']);
	});

	it('socket cleared with stale revision is discarded (the load-vs-clear race guard)', async () => {
		// A reconnect-triggered load delivers rev=10. A `cleared` event
		// queued in the socket buffer that was emitted at rev=8 (before
		// the load's snapshot) must NOT wipe the freshly-loaded state.
		fetchRecentlyPlayed.mockResolvedValueOnce(
			snapshot([makeEntry({ title: 'A' }), makeEntry({ title: 'B', album: 'Album B' })], 10)
		);
		await loadRecentlyPlayed(fetch);
		expect(get(recentlyPlayedStore).entries).toHaveLength(2);

		applyRecentlyPlayedCleared({ revision: 8 });

		expect(get(recentlyPlayedStore).entries).toHaveLength(2);
	});

	it('socket cleared with newer revision empties the list', async () => {
		fetchRecentlyPlayed.mockResolvedValueOnce(
			snapshot([makeEntry({ title: 'A' }), makeEntry({ title: 'B', album: 'Album B' })], 5)
		);
		await loadRecentlyPlayed(fetch);

		applyRecentlyPlayedCleared({ revision: 6 });

		const state = get(recentlyPlayedStore);
		expect(state.entries).toEqual([]);
		expect(state.loaded).toBe(true);
	});

	it('socket insert idempotent: replaying the exact same revision is a no-op', () => {
		const entry = makeEntry({ title: 'X', played_at: '2026-05-08T00:00:00.000Z' });
		applyRecentlyPlayedInserted({ entry, revision: 1 });
		applyRecentlyPlayedInserted({ entry, revision: 1 });

		expect(get(recentlyPlayedStore).entries).toHaveLength(1);
	});

	it('two distinct tracks at consecutive revisions both apply', () => {
		const sharedTs = '2026-05-08T00:00:00.000Z';
		applyRecentlyPlayedInserted({
			entry: makeEntry({ title: 'First', played_at: sharedTs, zone_id: 'zone-a' }),
			revision: 1
		});
		applyRecentlyPlayedInserted({
			entry: makeEntry({ title: 'Second', played_at: sharedTs, zone_id: 'zone-a' }),
			revision: 2
		});

		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual([
			'Second',
			'First'
		]);
	});

	it('applyClearResponse with newer revision wins over stale socket events', async () => {
		// The exact race the reviewer flagged: server clear drains
		// MidClear, emits cleared (rev N), emits inserted:MidClear
		// (rev N+1), DELETE response carries { entries: [MidClear],
		// revision: N+1 }. If only the cleared socket event reaches
		// the client (inserted dropped), applying the DELETE response
		// authoritatively at rev N+1 sets the store to [MidClear].
		// Subsequent stale cleared events from this same operation
		// are filtered out.
		applyRecentlyPlayedCleared({ revision: 5 });
		expect(get(recentlyPlayedStore).entries).toEqual([]);

		const midClear = makeEntry({ title: 'MidClear' });
		applyClearResponse({ entries: [midClear], revision: 6 });
		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual([
			'MidClear'
		]);

		// A duplicate `cleared` for the same operation (rev <= 6)
		// must NOT wipe the authoritative snapshot.
		applyRecentlyPlayedCleared({ revision: 5 });
		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual([
			'MidClear'
		]);
	});

	it('post-clear socket insert applies on top of an applied DELETE snapshot', () => {
		// After DELETE applies at rev 5, a genuine post-clear insert
		// at rev 6 should land on top of the snapshot.
		applyClearResponse({ entries: [], revision: 5 });
		applyRecentlyPlayedInserted({
			entry: makeEntry({ title: 'Post' }),
			revision: 6
		});

		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual([
			'Post'
		]);
	});

	it('cap: insert applies caps at 50', () => {
		for (let i = 0; i < 51; i++) {
			applyRecentlyPlayedInserted({
				entry: makeEntry({
					title: `T${i}`,
					played_at: `2026-05-08T00:00:${String(i).padStart(2, '0')}.000Z`
				}),
				revision: i + 1
			});
		}
		const entries = get(recentlyPlayedStore).entries;
		expect(entries).toHaveLength(50);
		expect(entries[0].title).toBe('T50');
		expect(entries.map((e) => e.title)).not.toContain('T0');
	});
});
