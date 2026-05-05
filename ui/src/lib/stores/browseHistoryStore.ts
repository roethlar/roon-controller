import { browser } from '$app/environment';
import { writable } from 'svelte/store';
import type { BrowseOptions } from '@shared/types';

/**
 * Browse navigation stacks, persisted to sessionStorage so they survive
 * route changes (e.g. Library → Queue → Library) within a tab session.
 *
 * sessionStorage is preferred over URL state because Roon `item_key`s are
 * session-scoped: a deep link could 404 silently after a Roon Core restart.
 * Per-session persistence avoids that drift while still preventing the
 * remount-clears-everything UX bug.
 *
 * `searchQuery` is recorded when the active hierarchy is "search". On
 * restore we need it to re-seed the Roon search session before replaying
 * any drill-down steps; the steps themselves carry only `item_key`s that
 * are only valid against a freshly-seeded search stack.
 *
 * Each `BrowseHistoryStep` extends `BrowseOptions` with an optional
 * `breadcrumb`. The breadcrumb is written at click time (`pushHistory`
 * receives the title/subtitle/imageKey/itemType of the row the user
 * clicked) and consumed at restore time: search drill-down `item_key`s
 * are minted fresh on each search re-seed, so re-walking a deep search
 * path requires matching saved breadcrumbs against the freshly-loaded
 * results to find the new keys.
 */
export interface BrowseBreadcrumb {
	title?: string;
	subtitle?: string;
	imageKey?: string;
	itemType?: string;
}

export type BrowseHistoryStep = BrowseOptions & { breadcrumb?: BrowseBreadcrumb };

export interface BrowseHistoryState {
	history: BrowseHistoryStep[];
	forward: BrowseHistoryStep[];
	searchQuery: string | null;
}

// Versioned key. Bump when the persisted shape changes or when legacy
// entries can violate a new invariant.
//   v2 → v3: each entry is a BrowseHistoryStep (BrowseOptions + optional
//   breadcrumb). v2 stored bare BrowseOptions; reading v2 raw would give
//   us steps with no breadcrumb, which would force search-rooted restore
//   to drop drill history (the old behavior). Bumping the key migrates
//   users to a fresh persisted state on first load.
const STORAGE_KEY = 'roon-controller-browse-history-v3';

function emptyState(): BrowseHistoryState {
	return { history: [], forward: [], searchQuery: null };
}

/**
 * Trim a persisted stack to its contiguous tail of same-hierarchy steps.
 *
 * `pushHistory` enforces single-hierarchy stacks going forward, but
 * sessionStorage entries written by older builds (or briefly during the
 * window before this fix shipped) can contain mixed entries. Loading
 * those raw would let `restoreBrowse` walk a browse-hierarchy step
 * against a freshly-seeded search session (or vice versa). Walking from
 * the end and taking only steps with the same hierarchy as the tail
 * gives `restoreBrowse` exactly the same shape it would see for a
 * stack written under the new invariant.
 */
function sanitizeStack(raw: unknown): { stack: BrowseHistoryStep[]; truncated: boolean } {
	if (!Array.isArray(raw) || raw.length === 0) {
		return { stack: [], truncated: false };
	}
	const tailHierarchy = (raw[raw.length - 1] as BrowseHistoryStep)?.hierarchy || 'browse';
	const out: BrowseHistoryStep[] = [];
	for (let i = raw.length - 1; i >= 0; i--) {
		const step = raw[i] as BrowseHistoryStep;
		const h = step?.hierarchy || 'browse';
		if (h !== tailHierarchy) break;
		out.unshift(step);
	}
	return { stack: out, truncated: out.length !== raw.length };
}

function readPersisted(): BrowseHistoryState {
	if (!browser) return emptyState();
	try {
		const raw = sessionStorage.getItem(STORAGE_KEY);
		if (!raw) return emptyState();
		const parsed = JSON.parse(raw) as Partial<BrowseHistoryState>;
		const { stack: history } = sanitizeStack(parsed.history);
		const tailHierarchy = history[history.length - 1]?.hierarchy || 'browse';

		// Forward stack must share history's hierarchy — otherwise
		// `popForward` would bypass `pushHistory`'s guard and splice a
		// foreign-hierarchy step directly into history. If history is
		// empty there's no anchor, so discard forward entirely.
		let forward: BrowseHistoryStep[] = [];
		if (history.length > 0) {
			const { stack: rawForward } = sanitizeStack(parsed.forward);
			if (rawForward.every((s) => (s.hierarchy || 'browse') === tailHierarchy)) {
				forward = rawForward;
			}
		}

		const searchQuery =
			tailHierarchy === 'search' && typeof parsed.searchQuery === 'string'
				? parsed.searchQuery
				: null;
		return { history, forward, searchQuery };
	} catch {
		return emptyState();
	}
}

function persist(state: BrowseHistoryState): void {
	if (!browser) return;
	try {
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {
		/* sessionStorage unavailable */
	}
}

const internal = writable<BrowseHistoryState>(readPersisted());

export const browseHistoryStore = {
	subscribe: internal.subscribe
};

export function pushHistory(
	opts: BrowseOptions,
	searchQuery?: string | null,
	breadcrumb?: BrowseBreadcrumb
): void {
	internal.update((state) => {
		const newHierarchy = opts.hierarchy || 'browse';
		const tail = state.history[state.history.length - 1];
		const tailHierarchy = (tail?.hierarchy || 'browse') as string;

		// Switching hierarchies (e.g. user was browsing albums, then clicked
		// a search result) starts a new navigation context. The Roon browse
		// and search hierarchies are independent multi-sessions, so mixing
		// their item_keys in one history stack would cause `restoreBrowse`
		// to replay browse steps against a search session (or vice versa)
		// and fail or land in the wrong place.
		const switchingContext = !!tail && tailHierarchy !== newHierarchy;
		const step: BrowseHistoryStep = breadcrumb ? { ...opts, breadcrumb } : { ...opts };
		const history = switchingContext ? [step] : [...state.history, step];

		let nextQuery: string | null;
		if (newHierarchy === 'search') {
			// Capture the active query so a later restore can re-seed the
			// Roon search session before walking the saved drill-down steps.
			nextQuery =
				typeof searchQuery === 'string' && searchQuery
					? searchQuery
					: state.searchQuery;
		} else if (switchingContext) {
			// Leaving a search context — drop the saved query.
			nextQuery = null;
		} else {
			nextQuery = state.searchQuery;
		}

		const next: BrowseHistoryState = {
			history,
			forward: [],
			searchQuery: nextQuery
		};
		persist(next);
		return next;
	});
}

export function popHistory(): BrowseHistoryStep | undefined {
	let popped: BrowseHistoryStep | undefined;
	internal.update((state) => {
		if (state.history.length === 0) return state;
		const last = state.history[state.history.length - 1];
		popped = last;
		const next: BrowseHistoryState = {
			history: state.history.slice(0, -1),
			forward: [...state.forward, last],
			searchQuery: state.searchQuery
		};
		persist(next);
		return next;
	});
	return popped;
}

export function popForward(): BrowseHistoryStep | undefined {
	let popped: BrowseHistoryStep | undefined;
	internal.update((state) => {
		if (state.forward.length === 0) return state;
		const last = state.forward[state.forward.length - 1];
		popped = last;
		const next: BrowseHistoryState = {
			history: [...state.history, last],
			forward: state.forward.slice(0, -1),
			searchQuery: state.searchQuery
		};
		persist(next);
		return next;
	});
	return popped;
}

export function resetHistory(): void {
	const empty = emptyState();
	internal.set(empty);
	persist(empty);
}

/**
 * Replace the history stack wholesale, clearing forward but preserving
 * the active searchQuery. Used by `restoreBrowse` to rewrite the stack
 * with fresh `item_key`s after walking a deep search drill via
 * breadcrumb matching: the persisted itemKeys are stale (Roon mints new
 * ones on each search re-seed), so without rewriting them the user's
 * Forward navigation after Back would later send stale keys to Roon.
 */
export function replaceHistory(history: BrowseHistoryStep[]): void {
	internal.update((state) => {
		const next: BrowseHistoryState = {
			history,
			forward: [],
			searchQuery: state.searchQuery
		};
		persist(next);
		return next;
	});
}
