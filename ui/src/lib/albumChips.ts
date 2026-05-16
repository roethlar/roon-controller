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
 * Escape regex metacharacters so a tag is safe to splice into a
 * RegExp source.
 */
function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Separator-aware boundary match. The previous `.includes()` lookup
 * triggered on names containing a tag as a substring — "Wavves" →
 * WAV, "Flacid" → FLAC. This matches only when the tag is preceded
 * and followed by either string edge or a non-alphanumeric character
 * (subtitle separators are typically space / `/` / `·` / `,`).
 * Hyphens count as non-alphanumeric so "Hi-Res" still matches the
 * hyphenated form.
 */
function buildBoundaryRe(tag: string): RegExp {
	return new RegExp(`(?:^|[^A-Za-z0-9])${escapeRe(tag)}(?:$|[^A-Za-z0-9])`, 'i');
}

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
 * format tags that Roon is known to emit, matched with separator-aware
 * boundaries (see `buildBoundaryRe`).
 */
export function extractAlbumChips(subtitle: string | undefined): AlbumChip[] {
	if (!subtitle) return [];
	const chips: AlbumChip[] = [];

	const yearMatch = subtitle.match(YEAR_RE);
	if (yearMatch) {
		chips.push({ kind: 'year', label: yearMatch[0] });
	}

	// Boundary-aware scan: subtitle separators are unpredictable
	// ("Artist / 2024 / FLAC" vs "Artist · 2024 · FLAC"). Longer
	// tags first so "MQA Studio" wins over "MQA".
	for (const tag of FORMAT_TAGS) {
		if (buildBoundaryRe(tag).test(subtitle)) {
			chips.push({ kind: 'format', label: tag });
			// First match wins per tag-kind to avoid duplicates when
			// the subtitle contains the same format twice.
			break;
		}
	}

	return chips;
}

/**
 * Strip year and format tokens (plus their separators) from a
 * subtitle, leaving the artist portion. Used by the album header's
 * "Search for this artist" link so a subtitle like
 * `"Tori Amos · 1994 · FLAC"` searches for `"Tori Amos"`, not the
 * full metadata string.
 *
 * Conservative: only removes tokens the chip extractor would have
 * matched, then trims separators. If extraction surfaces no chips,
 * returns the subtitle unchanged.
 */
export function extractArtistFromSubtitle(subtitle: string | undefined): string {
	if (!subtitle) return '';
	let working = subtitle;

	const yearMatch = working.match(YEAR_RE);
	if (yearMatch) {
		working = working.replace(yearMatch[0], '');
	}
	for (const tag of FORMAT_TAGS) {
		const re = buildBoundaryRe(tag);
		const m = working.match(re);
		if (m) {
			// Replace the matched span minus the boundary characters
			// (which may include adjacent letters in unusual cases —
			// the boundary set is non-alphanumeric, so this is safe).
			const idx = m.index ?? 0;
			const matched = m[0];
			const tagStart = matched.search(new RegExp(escapeRe(tag), 'i'));
			const before = working.slice(0, idx + tagStart);
			const after = working.slice(idx + tagStart + tag.length);
			working = before + after;
			break;
		}
	}

	// Collapse runs of separator characters (space, `/`, `·`, `,`,
	// `-`, `|`) into a single space, then trim leading/trailing
	// separators and whitespace.
	return working
		.replace(/[\s/·,|\-]+/g, ' ')
		.replace(/^[\s/·,|\-]+|[\s/·,|\-]+$/g, '')
		.trim();
}

/**
 * True when the current browse result looks like an album page —
 * a content-level (level 2+) listing whose rows are track plays.
 * The album-chip header should only render on these pages so chips
 * don't pollute artist / genre listings whose subtitles also
 * contain year-shaped strings.
 *
 * `inferredAllTracks` is the layout's signal that the track-list
 * heuristic kicked in WITHOUT any `itemType=track` row — i.e. the
 * page is something like `Library/Tracks` or playlist contents,
 * not a real album. Those pages don't carry album metadata in the
 * subtitle, so we exclude them to avoid stray year/format chips on
 * pages that just happen to satisfy the track-list shape.
 *
 * A non-empty `subtitle` is also required — an album page without
 * a subtitle has nothing for the chip extractor to find anyway,
 * and the requirement excludes a class of misclassified pages.
 */
export function isAlbumPage(
	current: BrowseResult | null,
	isTrackList: boolean,
	inferredAllTracks = false
): boolean {
	if (!current) return false;
	if (!isTrackList) return false;
	if (inferredAllTracks) return false;
	if ((current.level ?? 0) < 2) return false;
	if (!current.subtitle || current.subtitle.trim().length === 0) return false;
	return true;
}
