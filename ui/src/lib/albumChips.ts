import type { BrowseResult } from '@shared/types';

export type AlbumChipKind = 'year' | 'format';

export interface AlbumChip {
	kind: AlbumChipKind;
	label: string;
}

const YEAR_RE = /\b(19|20)\d{2}\b/;
// Order matters — match longer / more specific tags first so "Hi-Res"
// doesn't get split into "Hi" + "Res", and "MQA Studio" wins over plain
// "MQA". The format list is conservative: only widely-used Roon-reported
// quality / format markers. Add cautiously — false positives leak
// "FLAC"-looking substrings out of legitimate album titles.
const FORMAT_TAGS = [
	'MQA Studio',
	'MQA',
	'Hi-Res',
	'Hi Res',
	'HiRes',
	'DSD256',
	'DSD128',
	'DSD64',
	'DSD',
	'FLAC',
	'ALAC',
	'WAV',
	'MP3',
	'AAC'
];

/**
 * Heuristic extraction of album-page chips (year, format) from the
 * Roon-supplied subtitle. The subtitle is a free-form string that
 * varies by source (local files, Tidal, Qobuz); the parser fails
 * closed — if nothing recognizable is found, returns an empty array
 * and the album header just shows the subtitle as-is.
 *
 * Per UX overhaul plan (PR2 album page polish): "best-effort
 * metadata only; hide unavailable chips. Don't parse three_line line
 * strings into fake codec/format chips — wait until live evidence
 * shows stable structured fields." The patterns here are intentionally
 * narrow — 4-digit years in 19xx/20xx range, and a small allowlist of
 * format tags that Roon is known to emit.
 */
export function extractAlbumChips(subtitle: string | undefined): AlbumChip[] {
	if (!subtitle) return [];
	const chips: AlbumChip[] = [];

	const yearMatch = subtitle.match(YEAR_RE);
	if (yearMatch) {
		chips.push({ kind: 'year', label: yearMatch[0] });
	}

	// Word-boundary-insensitive scan: subtitle separators are unpredictable
	// ("Artist / 2024 / FLAC" vs "Artist · 2024 · FLAC"). Lowercase compare
	// then look up the canonical-cased label from the allowlist.
	const lower = subtitle.toLowerCase();
	for (const tag of FORMAT_TAGS) {
		if (lower.includes(tag.toLowerCase())) {
			chips.push({ kind: 'format', label: tag });
			// First match wins per tag-kind to avoid duplicates when
			// the subtitle contains the same format twice.
			break;
		}
	}

	return chips;
}

/**
 * True when the current browse result looks like an album page —
 * a content-level (level 2+) listing whose rows are track plays.
 * The album-chip header should only render on these pages so chips
 * don't pollute artist / genre listings whose subtitles also
 * contain year-shaped strings.
 */
export function isAlbumPage(
	current: BrowseResult | null,
	isTrackList: boolean
): boolean {
	if (!current) return false;
	if (!isTrackList) return false;
	return (current.level ?? 0) >= 2;
}
