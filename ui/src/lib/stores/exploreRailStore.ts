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
 * Core restarts. `cachedKey` and `cachedAncestorKeys` are reserved
 * for a later fast-path optimization (clicks bypass the label-walk
 * when keys are known good); PR1 ships label-walk-only and does
 * NOT populate the cache fields. Keeping the fields in the type
 * means a future PR can add the optimization without changing the
 * shape callers depend on.
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
	 * Reserved for a later fast-path optimization. Length =
	 * labelPath.length - 1. Empty for top-level entries. PR1 leaves
	 * these undefined; rail clicks always do the full label-walk.
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
 * Level-0 entries to exclude from the rail entirely. `Settings` is
 * a Roon-internal config page that the public browse API can't
 * action meaningfully.
 */
const EXCLUDED_LEVEL_0 = new Set(['Settings']);

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
						itemType: grand.itemType
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
				isEmpty: empty
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
