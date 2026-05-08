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

	it('appendFromSocket dedupes when head matches (same played_at + zone_id)', async () => {
		const entry = makeEntry({
			title: 'Dup',
			played_at: '2026-05-08T00:00:00.000Z',
			zone_id: 'zone-a'
		});
		appendRecentlyPlayedFromSocket(entry);
		appendRecentlyPlayedFromSocket(entry);

		expect(get(recentlyPlayedStore).entries).toHaveLength(1);
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
