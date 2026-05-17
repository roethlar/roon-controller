import { writable } from 'svelte/store';
import type { BrowseItem, BrowseResult } from '@shared/types';
import { browse as apiBrowse } from '../api/client';

/**
 * Left-rail "Explore" data — the top-level Roon browse-hierarchy
 * navigation surfaced as a sidebar nav. Ships with PR1 of the UX
 * overhaul.
 *
 * Resolution strategy (see docs/UX_OVERHAUL_PLAN_2026-05-05.md):
 * runs at layout mount and on `core-status: paired/reconnect`. Uses
 * a dedicated multiSessionKey ('explore-rail-discover') for the
 * REST capture so the user's main browse session isn't disturbed
 * by the popAll/drill pattern the resolver does.
 *
 * Entry identity is `labelPath: string[]` — stable across Roon
 * Core restarts. `cachedKey` and `cachedAncestorKeys` carry the
 * Roon itemKey chain captured during resolution; the layout's rail
 * click handler walks the chain (popAll + drill each ancestor +
 * drill leaf) instead of doing the label-scan slow path. REST call
 * count is the same — Roon's browse session is stack-based so
 * every level must be drilled — but the fast path skips the
 * per-drill title-match scan and uses known-good keys. Stale keys
 * (Core restart) cause the fast-path drill to fail and the handler
 * falls through to the label walk; the resolver re-runs on the
 * next `core-status: paired` and repopulates the cache.
 */

export interface ExploreRailEntry {
	/** The label rendered in the rail. Same as labelPath[labelPath.length-1]. */
	label: string;
	/**
	 * Stable identity: chain of titles drilled through to reach this
	 * entry. ["Genres"] for top-level; ["Library", "Albums"] for
	 * nested.
	 */
	labelPath: string[];
	/** Hint from Roon at the leaf level — used for filtering. */
	hint?: string;
	/** itemType from Roon — currently always undefined at level 0/1. */
	itemType?: string;
	/**
	 * True when the leaf container has zero `hint: 'list'` children.
	 * Detected during resolution by drilling each level-0 list-hint
	 * child once. Renders muted in the rail; click still works (lands
	 * on whatever the empty state is).
	 */
	isEmpty?: boolean;
	/**
	 * Roon itemKeys captured during resolution. The rail click
	 * handler walks `cachedAncestorKeys` then drills `cachedKey`
	 * (matches labelPath positions; `cachedAncestorKeys.length ===
	 * labelPath.length - 1`). Empty ancestors for top-level entries.
	 * Stale keys after a Roon Core restart cause the drill to fail
	 * and the handler falls back to the title-match label walk;
	 * the resolver re-runs on the next `core-status: paired`.
	 */
	cachedKey?: string;
	cachedAncestorKeys?: string[];
}

export interface ExploreRailState {
	entries: ExploreRailEntry[];
	loading: boolean;
	error: string | null;
}

const RESOLVE_SESSION_KEY = 'explore-rail-discover';

/**
 * Level-0 entries to drill for nested rail items. Today only
 * `Library` is expanded — its children become nested rail items.
 * `Playlists`, `Genres`, `My Live Radio` stay as single rail
 * entries (drilling them would clutter the rail with user-named
 * playlists / 100+ subgenres / provider lists).
 */
const EXPANDED_LEVEL_0 = new Set(['Library']);

/**
 * Level-0 entries to exclude from the rail entirely. None today —
 * `Settings` is surfaced even though our public-API surface can't
 * drive every action it exposes; users want it visible per
 * 2026-05-07 feedback.
 */
const EXCLUDED_LEVEL_0 = new Set<string>();

/**
 * Level-0 entries to surface in the rail but NOT drill for the
 * empty-state check. `Settings` is a special pseudo-list in Roon's
 * browse hierarchy — drilling its itemKey returns `InvalidItemKey`
 * even from a clean popAll'd session (verified live: produced three
 * `POST /api/browse 500` errors in the browser console per page
 * load). The catch block downstream handles the failure but the
 * surfaced 500s polluted both the journal and the browser console.
 *
 * Skip these: rail entry still renders (no isEmpty flag — never
 * muted), click-through still works via the layout's label-walk
 * fallback (cachedKey is also left unset to force the slow path).
 */
const SKIP_DRILL_LEVEL_0 = new Set(['Settings']);

/**
 * Level-1 entries under `Library` to exclude from the rail.
 * `Search` is redundant with the top-bar search input.
 */
const EXCLUDED_LEVEL_1_BY_PARENT: Record<string, Set<string>> = {
	Library: new Set(['Search'])
};

const initialState: ExploreRailState = {
	entries: [],
	loading: false,
	error: null
};

const internalStore = writable<ExploreRailState>(initialState);

/**
 * Monotonic resolve token. `core-status: paired` can fire multiple
 * times in quick succession (e.g. flap during reconnect), and each
 * triggers `resolveExploreRail`. Without a token, a slow-failing
 * earlier call could overwrite a fast-succeeding later one with an
 * error state — preserving the entries it didn't touch but masking
 * them behind a stale error in the layout. Each call captures the
 * token at start and only commits its result if the token is still
 * current at the end.
 */
let resolveToken = 0;

export const exploreRailStore = {
	subscribe: internalStore.subscribe
};

function isListChild(item: BrowseItem): boolean {
	return item.hint === 'list' && !!item.itemKey;
}

function hasListChildren(result: BrowseResult): boolean {
	return result.items.some(isListChild);
}

/**
 * Resolve the rail's structure by drilling browse root + level-1
 * children of expanded entries. Pure REST — no socket emission, no
 * `browseStore` mutation. Caller (layout) replaces existing entries
 * on success.
 */
export async function resolveExploreRail(fetchFn: typeof fetch): Promise<void> {
	const myToken = ++resolveToken;
	internalStore.update((s) => ({ ...s, loading: true, error: null }));

	try {
		// Level 0 — fresh session, popAll guarantees we land at the root.
		const root = await apiBrowse(fetchFn, {
			hierarchy: 'browse',
			multiSessionKey: RESOLVE_SESSION_KEY,
			popAll: true
		});

		const entries: ExploreRailEntry[] = [];

		for (const item of root.items) {
			if (!isListChild(item)) continue;
			if (EXCLUDED_LEVEL_0.has(item.title)) continue;

			// Skip the empty-check drill for items known to fail with
			// InvalidItemKey (currently just `Settings`). Surface them
			// as plain rail entries with no isEmpty flag (so never
			// muted) and no cached itemKey (so click-through walks
			// labels). This stops the 500 spam on every rail resolve.
			if (SKIP_DRILL_LEVEL_0.has(item.title)) {
				entries.push({
					label: item.title,
					labelPath: [item.title],
					hint: item.hint,
					itemType: item.itemType
				});
				continue;
			}

			// Drill once for empty-state detection AND (if expanded) for
			// nested entries. popAll first because Roon's browse session
			// is stack-based — without it, sibling drills would inherit
			// the prior drill's level.
			let child: BrowseResult;
			try {
				await apiBrowse(fetchFn, {
					hierarchy: 'browse',
					multiSessionKey: RESOLVE_SESSION_KEY,
					popAll: true
				});
				child = await apiBrowse(fetchFn, {
					hierarchy: 'browse',
					multiSessionKey: RESOLVE_SESSION_KEY,
					itemKey: item.itemKey
				});
			} catch {
				// Drill failed — still add the entry as non-empty
				// (label-walk on click will surface the real error).
				entries.push({
					label: item.title,
					labelPath: [item.title],
					hint: item.hint,
					itemType: item.itemType
				});
				continue;
			}

			const empty = !hasListChildren(child);

			if (EXPANDED_LEVEL_0.has(item.title)) {
				// Nested expansion — surface each level-1 list child
				// (minus the parent-specific exclusion list).
				const excludedChildren =
					EXCLUDED_LEVEL_1_BY_PARENT[item.title] ?? new Set<string>();

				for (const grand of child.items) {
					if (!isListChild(grand)) continue;
					if (excludedChildren.has(grand.title)) continue;

					entries.push({
						label: grand.title,
						labelPath: [item.title, grand.title],
						hint: grand.hint,
						itemType: grand.itemType,
						// Populate cached itemKeys for the fast-path on
						// click. cachedAncestorKeys carries the path
						// from level-0 down to (but not including) the
						// leaf; cachedKey is the leaf itself. Stale keys
						// (Core restart) make the fast-path fail
						// silently and the label-walk fallback runs.
						cachedKey: grand.itemKey,
						cachedAncestorKeys:
							item.itemKey !== undefined ? [item.itemKey] : []
						// isEmpty for nested entries left undefined —
						// detecting it would require N more drills.
						// Resolved at first click instead.
					});
				}

				// Add the parent itself as a non-clickable section
				// header? Layout decides. For now, the parent label is
				// represented only by its children's labelPath[0]; the
				// layout component renders the section header from the
				// labelPath grouping.
				continue;
			}

			// Top-level entry, not expanded — surface as a single rail
			// item with its empty-state flag set.
			entries.push({
				label: item.title,
				labelPath: [item.title],
				hint: item.hint,
				itemType: item.itemType,
				isEmpty: empty,
				cachedKey: item.itemKey,
				cachedAncestorKeys: []
			});
		}

		if (myToken !== resolveToken) return; // newer call superseded us
		internalStore.set({ entries, loading: false, error: null });
	} catch (err) {
		if (myToken !== resolveToken) return; // newer call superseded us
		const message = err instanceof Error ? err.message : 'Rail resolution failed';
		internalStore.update((s) => ({ ...s, loading: false, error: message }));
	}
}

/**
 * Drop entries and reset to loading state. Called when the Roon
 * Core un-pairs (cached itemKeys would all be stale after a Core
 * restart). The layout calls `resolveExploreRail` again on
 * `core-status: paired`.
 */
export function invalidateExploreRail(): void {
	// Bump the token so any in-flight resolve from before the
	// invalidate doesn't trample the cleared state on completion.
	resolveToken++;
	internalStore.set({ ...initialState });
}
