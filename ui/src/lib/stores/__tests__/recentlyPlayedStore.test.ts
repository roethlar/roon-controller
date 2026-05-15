import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';
import type { RecentlyPlayedEntry } from '@shared/types';

const fetchRecentlyPlayed = vi.fn<(_fetch: unknown) => Promise<RecentlyPlayedEntry[]>>();

vi.mock('$lib/api/client', () => ({
	fetchRecentlyPlayed: (...args: any[]) => fetchRecentlyPlayed(...(args as [unknown]))
}));

import {
	recentlyPlayedStore,
	loadRecentlyPlayed,
	appendRecentlyPlayedFromSocket,
	clearRecentlyPlayedEntries,
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

beforeEach(() => {
	fetchRecentlyPlayed.mockReset();
	resetRecentlyPlayed();
});

describe('recentlyPlayedStore', () => {
	it('loads entries via REST and marks store as loaded', async () => {
		fetchRecentlyPlayed.mockResolvedValueOnce([
			makeEntry({ title: 'A', played_at: '2026-05-08T00:00:00.000Z' }),
			makeEntry({ title: 'B', played_at: '2026-05-07T00:00:00.000Z' })
		]);

		await loadRecentlyPlayed(fetch);

		const state = get(recentlyPlayedStore);
		expect(state.entries.map((e) => e.title)).toEqual(['A', 'B']);
		expect(state.loading).toBe(false);
		expect(state.loaded).toBe(true);
	});

	it('survives REST failure: keeps existing entries, clears loading', async () => {
		fetchRecentlyPlayed.mockResolvedValueOnce([makeEntry({ title: 'A' })]);
		await loadRecentlyPlayed(fetch);
		expect(get(recentlyPlayedStore).entries).toHaveLength(1);

		fetchRecentlyPlayed.mockRejectedValueOnce(new Error('network blip'));
		await loadRecentlyPlayed(fetch);

		const state = get(recentlyPlayedStore);
		expect(state.entries.map((e) => e.title)).toEqual(['A']);
		expect(state.loading).toBe(false);
	});

	it('appendFromSocket unshifts a new entry to the top', async () => {
		fetchRecentlyPlayed.mockResolvedValueOnce([
			makeEntry({ title: 'Older', played_at: '2026-05-07T00:00:00.000Z' })
		]);
		await loadRecentlyPlayed(fetch);

		appendRecentlyPlayedFromSocket(
			makeEntry({ title: 'Newer', played_at: '2026-05-08T00:00:00.000Z' })
		);

		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual(['Newer', 'Older']);
	});

	it('appendFromSocket bubbles a replayed track to the top instead of duplicating', async () => {
		fetchRecentlyPlayed.mockResolvedValueOnce([
			makeEntry({ title: 'A', played_at: '2026-05-08T00:00:01.000Z' }),
			makeEntry({ title: 'B', played_at: '2026-05-08T00:00:00.000Z' })
		]);
		await loadRecentlyPlayed(fetch);

		// Backend bubbled a replay of A. The store must drop the prior
		// A and unshift the fresh one — even from a different zone,
		// since the shared dedupe key excludes zone_id / played_at.
		appendRecentlyPlayedFromSocket(
			makeEntry({
				title: 'A',
				zone_id: 'zone-b',
				played_at: '2026-05-08T00:00:05.000Z'
			})
		);

		const entries = get(recentlyPlayedStore).entries;
		expect(entries.map((e) => e.title)).toEqual(['A', 'B']);
		expect(entries[0].zone_id).toBe('zone-b');
	});

	it('appendFromSocket dedupes when head matches (same entry broadcast twice)', async () => {
		const entry = makeEntry({
			title: 'Dup',
			played_at: '2026-05-08T00:00:00.000Z',
			zone_id: 'zone-a'
		});
		appendRecentlyPlayedFromSocket(entry);
		appendRecentlyPlayedFromSocket(entry);

		expect(get(recentlyPlayedStore).entries).toHaveLength(1);
	});

	it('appendFromSocket keeps two distinct tracks that share played_at + zone_id', async () => {
		// Two fast track changes in the same zone can land on the same
		// millisecond timestamp. The idempotence guard must not collapse
		// them — it also compares the dedupe key, so distinct tracks
		// both make it through.
		const sharedTs = '2026-05-08T00:00:00.000Z';
		appendRecentlyPlayedFromSocket(
			makeEntry({ title: 'First', played_at: sharedTs, zone_id: 'zone-a' })
		);
		appendRecentlyPlayedFromSocket(
			makeEntry({ title: 'Second', played_at: sharedTs, zone_id: 'zone-a' })
		);

		expect(get(recentlyPlayedStore).entries.map((e) => e.title)).toEqual([
			'Second',
			'First'
		]);
	});

	it('clearRecentlyPlayedEntries empties the list but keeps loaded=true', async () => {
		fetchRecentlyPlayed.mockResolvedValueOnce([
			makeEntry({ title: 'A' }),
			makeEntry({ title: 'B' })
		]);
		await loadRecentlyPlayed(fetch);
		expect(get(recentlyPlayedStore).entries).toHaveLength(2);

		clearRecentlyPlayedEntries();

		const state = get(recentlyPlayedStore);
		expect(state.entries).toEqual([]);
		// loaded stays true — the list is known-empty, not unloaded, so
		// the welcome view shows nothing rather than a loading state.
		expect(state.loaded).toBe(true);
	});

	it('clearRecentlyPlayedEntries on an already-empty store is a harmless no-op', () => {
		clearRecentlyPlayedEntries();
		const state = get(recentlyPlayedStore);
		expect(state.entries).toEqual([]);
		expect(state.loaded).toBe(true);
	});

	it('discards a load response that arrives after a clear (race guard)', async () => {
		// A reconnect-triggered load can be in flight when the user
		// (or another client via socket) clears. The stale GET
		// response must NOT resurrect the pre-clear entries.
		let resolveLoad!: (entries: RecentlyPlayedEntry[]) => void;
		fetchRecentlyPlayed.mockImplementationOnce(
			() => new Promise((r) => (resolveLoad = r))
		);

		const loadPromise = loadRecentlyPlayed(fetch);

		// Mid-flight, a clear arrives (e.g., from the socket).
		clearRecentlyPlayedEntries();
		expect(get(recentlyPlayedStore).entries).toEqual([]);

		// Now let the stale load resolve with pre-clear data.
		resolveLoad([
			makeEntry({ title: 'Stale A' }),
			makeEntry({ title: 'Stale B' })
		]);
		await loadPromise;

		// Stale response discarded — store stays empty.
		expect(get(recentlyPlayedStore).entries).toEqual([]);
	});

	it('appendFromSocket caps the list at 50 entries', () => {
		// Pre-fill 50 entries via socket appends.
		for (let i = 0; i < 50; i++) {
			appendRecentlyPlayedFromSocket(
				makeEntry({
					title: `T${i}`,
					played_at: `2026-05-08T00:00:${String(i).padStart(2, '0')}.000Z`
				})
			);
		}
		expect(get(recentlyPlayedStore).entries).toHaveLength(50);

		// One more — the oldest should fall off.
		appendRecentlyPlayedFromSocket(
			makeEntry({ title: 'Newest', played_at: '2026-05-08T00:01:00.000Z' })
		);

		const entries = get(recentlyPlayedStore).entries;
		expect(entries).toHaveLength(50);
		expect(entries[0].title).toBe('Newest');
		// The very first one (T0) was pushed off the bottom.
		expect(entries.map((e) => e.title)).not.toContain('T0');
	});
});
