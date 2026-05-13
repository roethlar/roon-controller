/**
 * Strip the leading "N. " prefix from a Roon track title so it matches
 * the bare title Roon emits in now-playing events. The browse track
 * list uses "3. Cornflake Girl" / now-playing reports "Cornflake Girl".
 */
export function trackTitle(title: string): string {
	return title.replace(/^\d+\.\s*/, '');
}

/**
 * Extract the leading track number from a title like "3. Song Name" → "3".
 * Falls back to the row index (1-based) when no prefix is present.
 */
export function trackNum(title: string, index: number): string {
	return title.match(/^(\d+)\./)?.[1] ?? String(index + 1);
}
