import { describe, it, expect } from 'vitest';
import { extractAlbumChips, isAlbumPage } from '../albumChips';
import { listResult } from '../../test/fixtures/browse';

describe('extractAlbumChips', () => {
	it('returns empty for undefined / empty subtitle', () => {
		expect(extractAlbumChips(undefined)).toEqual([]);
		expect(extractAlbumChips('')).toEqual([]);
	});

	it('extracts a 4-digit year when present', () => {
		expect(extractAlbumChips('Tori Amos / 1994')).toEqual([
			{ kind: 'year', label: '1994' }
		]);
		expect(extractAlbumChips('Released 2024 by Some Label')).toEqual([
			{ kind: 'year', label: '2024' }
		]);
	});

	it('ignores 4-digit numbers outside the 19xx/20xx range', () => {
		// Track counts, run lengths, etc. shouldn't masquerade as years.
		expect(extractAlbumChips('Album · 1234')).toEqual([]);
		expect(extractAlbumChips('Album · 2200')).toEqual([]);
	});

	it('returns no chips when subtitle is just an artist name', () => {
		expect(extractAlbumChips('Tori Amos')).toEqual([]);
		expect(extractAlbumChips('The Beatles')).toEqual([]);
	});

	it('extracts a format tag (FLAC, MQA, DSD, Hi-Res, etc.)', () => {
		expect(extractAlbumChips('Tori Amos / FLAC')).toEqual([
			{ kind: 'format', label: 'FLAC' }
		]);
		expect(extractAlbumChips('Album / 2024 / Hi-Res')).toEqual([
			{ kind: 'year', label: '2024' },
			{ kind: 'format', label: 'Hi-Res' }
		]);
		expect(extractAlbumChips('Some Album · MQA Studio · 2020')).toEqual([
			{ kind: 'year', label: '2020' },
			{ kind: 'format', label: 'MQA Studio' }
		]);
	});

	it('matches the longer/more-specific format tag first (MQA Studio not MQA)', () => {
		const chips = extractAlbumChips('Album · MQA Studio');
		const formats = chips.filter((c) => c.kind === 'format');
		expect(formats).toHaveLength(1);
		expect(formats[0].label).toBe('MQA Studio');
	});

	it('is case-insensitive on format tags', () => {
		expect(extractAlbumChips('album / flac')).toContainEqual({
			kind: 'format',
			label: 'FLAC'
		});
		expect(extractAlbumChips('Album / hi-res')).toContainEqual({
			kind: 'format',
			label: 'Hi-Res'
		});
	});

	it('returns at most one format chip even if subtitle mentions it twice', () => {
		const chips = extractAlbumChips('FLAC remaster / FLAC reissue');
		expect(chips.filter((c) => c.kind === 'format')).toHaveLength(1);
	});

	it('year and format can coexist', () => {
		expect(extractAlbumChips('Pet Sounds · 1966 · FLAC')).toEqual([
			{ kind: 'year', label: '1966' },
			{ kind: 'format', label: 'FLAC' }
		]);
	});
});

describe('isAlbumPage', () => {
	it('false when current is null', () => {
		expect(isAlbumPage(null, false)).toBe(false);
		expect(isAlbumPage(null, true)).toBe(false);
	});

	it('false when not a track list', () => {
		const cur = listResult({ level: 2, items: [] });
		expect(isAlbumPage(cur, false)).toBe(false);
	});

	it('false at navigation levels (< 2) even if track-list-shaped', () => {
		const cur = listResult({ level: 1, items: [] });
		expect(isAlbumPage(cur, true)).toBe(false);
	});

	it('true at level 2+ track list', () => {
		const cur = listResult({ level: 2, items: [] });
		expect(isAlbumPage(cur, true)).toBe(true);
		const deeper = listResult({ level: 3, items: [] });
		expect(isAlbumPage(deeper, true)).toBe(true);
	});
});
