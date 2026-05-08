<script lang="ts">
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import Search from '$lib/components/Search.svelte';
	import { SEARCH_SESSION_KEY } from '$lib/browseSessions';
	import {
		browseStore,
		setBrowseError,
		setBrowseLoading,
		setSearchLoading,
		setBrowseResult,
		appendBrowseItems,
		resetBrowse
	} from '$lib/stores/browseStore';
	import { selectedZoneStore } from '$lib/stores/selectedZoneStore';
	import {
		pushCommandFeedback,
		pendingSearchStore,
		browseNavStore,
		browseHistoryStore,
		pushHistory,
		popHistory,
		popForward,
		resetHistory,
		replaceHistory,
		type BrowseBreadcrumb,
		type BrowseHistoryStep
	} from '$lib/stores';
	import { getSocket } from '$lib/socket/client';
	import { browse as apiBrowse, browseLoad as apiBrowseLoad } from '$lib/api/client';
	import type {
		BrowseItem,
		BrowseOptions,
		BrowsePopOptions,
		BrowseResult,
		SearchResult
	} from '@shared/types';
	import type { BrowseHistoryState } from '$lib/stores/browseHistoryStore';

	let socket = $state(getSocket());
	let quickPlayInFlight = $state(false);
	let loadMoreInFlight = $state(false);

	onMount(() => {
		socket = getSocket();

		// Restore navigation. Roon's browse and search hierarchies live in
		// independent multi-sessions; we reset whichever one the saved
		// history was rooted in, then replay each step. Resetting only the
		// browse hierarchy would leave a search-derived restore walking a
		// stale Roon search stack.
		void restoreBrowse(get(browseHistoryStore));

		browseNavStore.set({
			canBack: false,
			canForward: false,
			back: pop,
			forward,
			home: resetRoot
		});

		return () => {
			browseNavStore.set({ canBack: false, canForward: false, back: noop, forward: noop, home: noop });
		};
	});

	function matchBreadcrumb(items: BrowseItem[], crumb: BrowseBreadcrumb): BrowseItem | undefined {
		// Match on every breadcrumb field that's present. Title must match
		// exactly; subtitle/imageKey/itemType act as disambiguators when
		// multiple rows share a title (e.g. albums with the same name by
		// different artists).
		return items.find((candidate) => {
			if (crumb.title && candidate.title !== crumb.title) return false;
			if (crumb.subtitle && candidate.subtitle !== crumb.subtitle) return false;
			if (crumb.imageKey && candidate.imageKey !== crumb.imageKey) return false;
			if (crumb.itemType && candidate.itemType !== crumb.itemType) return false;
			return true;
		});
	}

	async function restoreBrowse(state: BrowseHistoryState): Promise<void> {
		const { history, searchQuery } = state;

		// Empty history + no active search → show the welcome view, not
		// the browse-root listing. The browse-root content (Library /
		// Playlists / Genres / etc.) is already surfaced in the Explore
		// rail; popAll-ing here would just duplicate the rail in the
		// right pane. Leave `$browseStore.current` null so the welcome
		// placeholder renders.
		if (history.length === 0 && !searchQuery) {
			return;
		}

		// The hierarchy we end up in is the hierarchy of the deepest saved
		// step, or 'browse' if there's no history. Setting loading with the
		// right hierarchy up front means the store stays consistent if the
		// user navigates while the restore is still in flight.
		const targetHierarchy = history.length > 0
			? (history[history.length - 1].hierarchy || 'browse')
			: 'browse';
		setBrowseLoading(targetHierarchy);

		try {
			let last: BrowseResult;

			if (targetHierarchy === 'search') {
				if (!searchQuery) {
					// Search history without a saved query is unrecoverable —
					// the saved item_keys are only valid against a freshly
					// seeded search session. Discard the broken history and
					// fall back to the browse root.
					resetHistory();
					last = await apiBrowse(fetch, {
						hierarchy: 'browse',
						zoneId: $selectedZoneStore || undefined,
						popAll: true
					});
					setBrowseResult(last, 'browse');
					return;
				}
				// Re-seed the Roon search session by replaying the original
				// query. This puts the search stack at the result-list level
				// so the saved drill-down item_keys would resolve — except
				// they don't, because Roon mints fresh keys on each re-seed.
				// The breadcrumb walk below recovers the new keys by
				// matching saved title/subtitle/imageKey/itemType against
				// the freshly-loaded results at each level.
				last = await apiBrowse(fetch, {
					hierarchy: 'search',
					input: searchQuery,
					zoneId: $selectedZoneStore || undefined,
					multiSessionKey: SEARCH_SESSION_KEY,
					popAll: true
				});
				setSearchLoading(searchQuery);

				// Walk each saved step using its breadcrumb. We rebuild a
				// fresh history list with the new itemKeys so subsequent
				// Forward navigation (after Back) doesn't send Roon stale
				// keys minted by a prior search session.
				const rebuilt: BrowseHistoryStep[] = [];
				let truncated = false;
				let stopReason: string | undefined;
				for (const step of history) {
					if (!step.breadcrumb) {
						// Legacy step with no breadcrumb — can't remap
						// safely. Stop here and let the user re-navigate.
						truncated = true;
						stopReason = 'breadcrumb metadata missing';
						break;
					}
					const match = matchBreadcrumb(last.items, step.breadcrumb);
					if (!match?.itemKey) {
						truncated = true;
						stopReason = `"${step.breadcrumb.title}" no longer in results`;
						break;
					}
					try {
						last = await apiBrowse(fetch, {
							hierarchy: step.hierarchy || 'search',
							itemKey: match.itemKey,
							zoneId: step.zoneId ?? ($selectedZoneStore || undefined),
							multiSessionKey: step.multiSessionKey ?? SEARCH_SESSION_KEY
						});
						rebuilt.push({
							...step,
							itemKey: match.itemKey
						});
					} catch (err) {
						truncated = true;
						stopReason = (err as Error).message;
						break;
					}
				}

				// Replace persisted history with the successfully-walked
				// path so its itemKeys reflect the current Roon session.
				replaceHistory(rebuilt);

				if (truncated && stopReason) {
					pushCommandFeedback({
						source: 'browse',
						command: 'browse:restore',
						message: `Restore stopped: ${stopReason}.`
					});
				}

				setBrowseResult(last, targetHierarchy);
				return;
			}

			last = await apiBrowse(fetch, {
				hierarchy: 'browse',
				zoneId: $selectedZoneStore || undefined,
				popAll: true
			});

			// Walk each saved step. If any step fails (e.g. stale item_key
			// after a Roon Core restart), stop where we are and surface a
			// feedback toast — Home / Back are still functional from any
			// partial state.
			for (const step of history) {
				const stepWithZone: BrowseOptions = {
					...step,
					zoneId: step.zoneId ?? ($selectedZoneStore || undefined),
					hierarchy: step.hierarchy || 'browse'
				};
				// Strip breadcrumb before sending to Roon — it's a
				// restore-time concern, not part of the browse request.
				delete (stepWithZone as Partial<BrowseHistoryStep>).breadcrumb;
				try {
					last = await apiBrowse(fetch, stepWithZone);
				} catch (err) {
					pushCommandFeedback({
						source: 'browse',
						command: 'browse:restore',
						message: `Restore stopped at level ${last.level}: ${(err as Error).message}`
					});
					break;
				}
			}
			setBrowseResult(last, targetHierarchy);
		} catch (err) {
			setBrowseError(`Restore failed: ${(err as Error).message}`);
		}
	}

	const noop = () => {};

	// Keep nav store in sync with navigation state
	$effect(() => {
		browseNavStore.update((s) => ({
			...s,
			canBack: !!$browseStore.current && $browseStore.current.level > 0,
			canForward: $browseHistoryStore.forward.length > 0
		}));
	});

	// React to search requests set by the play bar (track/artist links)
	$effect(() => {
		const query = $pendingSearchStore;
		if (query) {
			pendingSearchStore.set(null);
			setSearchLoading(query);
			const liveSocket = socket ?? getSocket();
			socket = liveSocket;
			if (liveSocket) {
				liveSocket.emit('browse:search', {
					input: query,
					zoneId: $selectedZoneStore || undefined,
					multiSessionKey: SEARCH_SESSION_KEY,
					popAll: true
				});
			}
		}
	});

	function emitBrowse(event: string, payload: BrowseOptions | BrowsePopOptions) {
		const liveSocket = socket ?? getSocket();
		socket = liveSocket;

		if (!liveSocket) {
			setBrowseError('Realtime connection is unavailable.');
			return;
		}

		liveSocket.emit(event, payload);
	}

	function activeMultiSessionKey(): string | undefined {
		return $browseStore.hierarchy === 'search' ? SEARCH_SESSION_KEY : undefined;
	}

	function makeBreadcrumb(item: BrowseItem): BrowseBreadcrumb {
		// Capture only stable, content-keyed fields. itemKey is intentionally
		// excluded — search itemKeys mint fresh on each search re-seed, which
		// is exactly the staleness this breadcrumb is meant to recover from.
		return {
			title: item.title || undefined,
			subtitle: item.subtitle,
			imageKey: item.imageKey,
			itemType: item.itemType
		};
	}

	function browse(
		options: BrowseOptions,
		opts: { recordHistory?: boolean; breadcrumb?: BrowseBreadcrumb } = {}
	) {
		const scopedOptions: BrowseOptions = {
			...options,
			zoneId: options.zoneId ?? ($selectedZoneStore || undefined)
		};

		setBrowseLoading(scopedOptions.hierarchy ?? 'browse');
		emitBrowse('browse:browse', scopedOptions);

		if (opts.recordHistory) {
			// Capture the active search query alongside any search-derived
			// step so a later restore can re-seed the Roon search session.
			// The breadcrumb (when supplied) lets restore re-walk a deep
			// search drill: each step's saved itemKey is stale after a
			// search re-seed, so we match the breadcrumb against fresh
			// results to recover the new key.
			pushHistory(scopedOptions, $browseStore.lastSearchQuery, opts.breadcrumb);
		}
	}

	function pop() {
		popHistory();
		const options: BrowsePopOptions = {
			hierarchy: $browseStore.hierarchy,
			zoneId: $selectedZoneStore || undefined,
			multiSessionKey: activeMultiSessionKey()
		};
		setBrowseLoading(options.hierarchy);
		emitBrowse('browse:pop', options);
	}

	/** Internal pop used by quickPlay — does not touch history/forward stacks. */
	function popInternal() {
		emitBrowse('browse:pop', {
			hierarchy: $browseStore.hierarchy,
			zoneId: $selectedZoneStore || undefined,
			multiSessionKey: activeMultiSessionKey()
		});
	}

	function forward() {
		const next = popForward();
		if (next) {
			// Strip breadcrumb before re-issuing — it's a restore-time
			// concern, not part of the Roon browse request.
			const { breadcrumb: _drop, ...request } = next;
			browse(request, { recordHistory: false });
		}
	}

	function resetRoot() {
		// Home returns to the welcome view, not the Roon browse root.
		// The browse root would just mirror the Explore rail (Library /
		// Playlists / Genres / etc.) which is already in the sidebar.
		resetHistory();
		resetBrowse();
	}

	/**
	 * Load the next page of items at the current level. Used by the
	 * "Load more" / "Load all" buttons and the alphabetic jump bar fast-path.
	 */
	async function loadMore(opts: { all?: boolean } = {}): Promise<void> {
		const current = $browseStore.current;
		if (!current || loadMoreInFlight) return;
		const total = current.totalCount ?? current.count;
		const loaded = current.items.length;
		if (loaded >= total) return;

		loadMoreInFlight = true;
		try {
			const remaining = total - loaded;
			const count = opts.all ? remaining : Math.min(100, remaining);
			const next = await apiBrowseLoad(fetch, {
				hierarchy: $browseStore.hierarchy,
				zoneId: $selectedZoneStore || undefined,
				offset: loaded,
				count,
				multiSessionKey: activeMultiSessionKey()
			});
			appendBrowseItems(next.items);
		} catch (err) {
			pushCommandFeedback({
				source: 'browse',
				command: 'browse:load',
				message: `Load failed: ${(err as Error).message}`
			});
		} finally {
			loadMoreInFlight = false;
		}
	}

	/** Navigate into a list item (hierarchy drill-down). */
	function navigate(item: BrowseItem) {
		if (!item.itemKey) return;
		const opts: BrowseOptions = {
			hierarchy: $browseStore.hierarchy,
			itemKey: item.itemKey,
			zoneId: $selectedZoneStore || undefined,
			multiSessionKey: activeMultiSessionKey()
		};
		browse(opts, { recordHistory: true, breadcrumb: makeBreadcrumb(item) });
	}

	/** Open an item's action menu (e.g. Play Now / Play Next / Add to Queue). */
	function openActionMenu(item: BrowseItem) {
		if (!item.itemKey) return;
		browse({
			hierarchy: $browseStore.hierarchy,
			itemKey: item.itemKey,
			zoneId: $selectedZoneStore || undefined,
			multiSessionKey: activeMultiSessionKey()
		});
	}

	function handleSearchResultClick(result: SearchResult) {
		if (result.resultType === 'track' && result.hint === 'action_list') {
			void quickPlay(result, { hierarchy: 'search', multiSessionKey: SEARCH_SESSION_KEY, resetSearch: true });
		} else {
			void navigateSearchResult(result);
		}
	}

	/** Search for an artist by name (from album subtitle). */
	function searchArtist(name: string) {
		const liveSocket = socket ?? getSocket();
		socket = liveSocket;
		if (!liveSocket) return;
		setSearchLoading(name);
		liveSocket.emit('browse:search', {
			input: name,
			zoneId: $selectedZoneStore || undefined,
			multiSessionKey: SEARCH_SESSION_KEY,
			popAll: true
		});
	}

	async function resetSearchSession(): Promise<BrowseResult | null> {
		const query = $browseStore.lastSearchQuery;
		if (!query) return null;

		return apiBrowse(fetch, {
			hierarchy: 'search',
			input: query,
			zoneId: $selectedZoneStore || undefined,
			multiSessionKey: SEARCH_SESSION_KEY,
			popAll: true
		});
	}

	function optionalFieldMatches(left?: string, right?: string): boolean {
		return !left || !right || left === right;
	}

	function semanticType(item: BrowseItem): string | undefined {
		const resultType = (item as BrowseItem & { resultType?: SearchResult['resultType'] }).resultType;
		return item.itemType ?? (resultType && resultType !== 'unknown' ? resultType : undefined);
	}

	function searchItemMatches(candidate: BrowseItem, original: BrowseItem): boolean {
		if (candidate.title !== original.title) return false;
		if (!optionalFieldMatches(candidate.subtitle, original.subtitle)) return false;
		if (!optionalFieldMatches(candidate.hint, original.hint)) return false;
		if (!optionalFieldMatches(candidate.imageKey, original.imageKey)) return false;
		if (!optionalFieldMatches(semanticType(candidate), semanticType(original))) return false;
		return true;
	}

	async function freshenSearchItem(item: BrowseItem): Promise<BrowseItem> {
		const freshSearch = await resetSearchSession();
		if (!freshSearch) return item;

		const freshItem = freshSearch.items.find((candidate) => candidate.itemKey && searchItemMatches(candidate, item));
		if (!freshItem?.itemKey) {
			throw new Error(`Search result is no longer available: ${item.title}`);
		}
		return { ...item, itemKey: freshItem.itemKey };
	}

	async function navigateSearchResult(result: SearchResult): Promise<void> {
		if (!result.itemKey) return;

		setBrowseLoading('search');
		try {
			const target = await freshenSearchItem(result);

			// Each search-result click starts a new navigation thread:
			//   - prior browse history is from a different Roon hierarchy
			//   - prior search drill history is from a different sub-tree
			// Search re-seeding mints fresh Roon item_keys, so browse the
			// matched result from the new session rather than the stale key
			// attached to the rendered search row.
			// Restore-on-remount must replay only this thread, so reset
			// before pushing. The store's hierarchy-switch guard would
			// catch the browse-history case anyway, but doing it here
			// makes the intent explicit and also covers within-search
			// thread switches (a different result on the same query).
			resetHistory();

			const opts: BrowseOptions = {
				hierarchy: 'search',
				itemKey: target.itemKey,
				zoneId: $selectedZoneStore || undefined,
				multiSessionKey: SEARCH_SESSION_KEY
			};
			browse(opts, { recordHistory: true, breadcrumb: makeBreadcrumb(target) });
		} catch (err) {
			setBrowseError(`Browse failed: ${(err as Error).message}`);
			pushCommandFeedback({
				source: 'browse',
				command: 'search-result',
				message: `Browse failed: ${(err as Error).message}`
			});
		}
	}

	/**
	 * Immediately play a track-level item without navigating into its action menu.
	 * Uses a separate browse session (multiSessionKey) so main navigation is undisturbed.
	 * Flow: browse(itemKey) → find first action ("Play Now") → browse(actionKey) → plays.
	 */
	async function quickPlay(
		item: BrowseItem,
		options: { hierarchy?: string; multiSessionKey?: string; resetSearch?: boolean } = {}
	) {
		if (!item.itemKey) return;

		const zoneId = $selectedZoneStore || undefined;
		if (!zoneId) {
			pushCommandFeedback({ source: 'browse', command: 'play', message: 'Select a zone to play.' });
			return;
		}

		const hierarchyAtStart = options.hierarchy ?? $browseStore.hierarchy;
		quickPlayInFlight = true;
		try {
			let target = item;
			if (options.resetSearch) {
				target = await freshenSearchItem(item);
			}

			// Browse into the track to get its action list (Play Now, Play Next, etc.).
			// REST keeps this helper from broadcasting intermediate action-list state.
			const actionResult = await apiBrowse(fetch, {
				hierarchy: hierarchyAtStart,
				itemKey: target.itemKey,
				zoneId,
				multiSessionKey: options.multiSessionKey
			});

			const playAction = actionResult.items.find((i) => i.isPlayable || i.hint === 'action');
			if (!playAction?.itemKey) {
				// quickPlay couldn't find a play action — fall back to
				// rendering the action list. If the user got here from a
				// search result (resetSearch=true), this is the same kind
				// of "new navigation thread" reset as navigateSearchResult,
				// so clear history before pushing.
				if (options.resetSearch) {
					resetHistory();
				}
				const fallbackOpts: BrowseOptions = {
					hierarchy: hierarchyAtStart,
					itemKey: target.itemKey,
					zoneId,
					multiSessionKey: options.multiSessionKey
				};
				browse(fallbackOpts, { recordHistory: true, breadcrumb: makeBreadcrumb(target) });
				return;
			}

			// Execute Play Now
			await apiBrowse(fetch, {
				hierarchy: hierarchyAtStart,
				itemKey: playAction.itemKey,
				zoneId,
				multiSessionKey: options.multiSessionKey
			});

			// Only restore the album view if we were in the main browse hierarchy.
			// In search context there's no album view to restore.
			if (hierarchyAtStart === 'browse') {
				popInternal();
			}
		} catch (err) {
			pushCommandFeedback({
				source: 'browse',
				command: 'play',
				message: `Play failed: ${(err as Error).message}`
			});
		} finally {
			quickPlayInFlight = false;
		}
	}

	function handleItemClick(item: BrowseItem) {
		if (!item.itemKey) return;

		if (item.hint === 'action_list') {
			if (shouldQuickPlayActionList(item)) {
				void quickPlay(item, { multiSessionKey: activeMultiSessionKey() });
			} else if (parseAlbumByArtist(item.title)) {
				// Contextual rows like "On Ocean to Ocean by Tori Amos"
				// land on a play-action menu in Roon, not the album page.
				// Try to resolve the album via search; fall back to the
				// existing navigate (action menu) if resolution fails.
				void resolveAlbumOrNavigate(item);
			} else {
				navigate(item);
			}
			return;
		}

		navigate(item);
	}

	/**
	 * Parse "<album> by <artist>" titles. Roon uses this format for
	 * contextual rows on Work / Composer pages where the row points to a
	 * play-action menu rather than an album browse page. Returning the
	 * parsed pair lets `resolveAlbumOrNavigate` look up the album via
	 * search and jump to the album page directly.
	 */
	function parseAlbumByArtist(title: string): { album: string; artist: string } | null {
		const m = title.match(/^(.+?)\s+by\s+(.+?)\s*$/i);
		if (!m) return null;
		const album = m[1].trim();
		const artist = m[2].trim();
		if (!album || !artist) return null;
		return { album, artist };
	}

	async function resolveAlbumOrNavigate(item: BrowseItem): Promise<void> {
		const parsed = parseAlbumByArtist(item.title);
		if (!parsed) {
			navigate(item);
			return;
		}

		// Show loading without committing the hierarchy switch — a
		// failed resolver must be able to fall back to navigate(item)
		// in the original hierarchy. setBrowseLoading('search') here
		// would switch the store's hierarchy and the fallback would
		// then send the contextual row's browse-hierarchy itemKey
		// against the search session.
		setBrowseLoading();

		let searchResult: BrowseResult;
		try {
			// Re-seed the user's main search session with the album title.
			// Side effect: the search panel reflects this lookup. Acceptable
			// trade-off — the alternative (a side multi-session) would
			// produce a fresh itemKey that's only valid in that session,
			// forcing a second re-seed before navigation.
			searchResult = await apiBrowse(fetch, {
				hierarchy: 'search',
				input: parsed.album,
				zoneId: $selectedZoneStore || undefined,
				multiSessionKey: SEARCH_SESSION_KEY,
				popAll: true
			});
		} catch {
			navigate(item);
			return;
		}

		const albumLower = parsed.album.toLowerCase();
		const artistLower = parsed.artist.toLowerCase();
		const match = searchResult.items.find((candidate) => {
			if (!candidate.itemKey) return false;
			if ((candidate.itemType ?? '').toLowerCase() !== 'album') return false;
			if (candidate.title.toLowerCase() !== albumLower) return false;
			const subtitle = (candidate.subtitle ?? '').toLowerCase();
			return subtitle.includes(artistLower);
		});

		if (!match?.itemKey) {
			// No album match; fall back to the contextual row's own
			// action menu — same behavior as the pre-resolver code.
			navigate(item);
			return;
		}

		// Match confirmed — commit the hierarchy switch and land on the
		// album as a fresh search-rooted thread (mirrors
		// `navigateSearchResult`). The prior browse stack is intentionally
		// cleared; Back walks search history from here.
		setSearchLoading(parsed.album);
		resetHistory();
		browse(
			{
				hierarchy: 'search',
				itemKey: match.itemKey,
				zoneId: $selectedZoneStore || undefined,
				multiSessionKey: SEARCH_SESSION_KEY
			},
			{ recordHistory: true, breadcrumb: makeBreadcrumb(match) }
		);
	}

	/**
	 * Normalize a Roon `item_type` / `item_subtype` for comparison.
	 * BrowseService passes the raw value through; Roon is mostly lowercase
	 * singular but `inferSearchType` already handles plurals defensively.
	 * Match that style here so a `Track` / `tracks` payload doesn't slip
	 * through as untyped.
	 */
	function normalizeItemType(value: string | undefined): string | undefined {
		return value ? value.toLowerCase() : undefined;
	}

	function isTrackType(value: string | undefined): boolean {
		const t = normalizeItemType(value);
		return t === 'track' || t === 'tracks';
	}

	/**
	 * Classify an action_list item as a track. Roon usually sets
	 * `item_type === 'track'` on real track rows; when it does, trust that
	 * over the leading-digit heuristic (some tracklists — e.g. classical
	 * movements — have no numeric prefix). Fall back to the regex only when
	 * the payload omits `item_type`, so older Roon responses keep working.
	 */
	function isTrackItem(item: BrowseItem): boolean {
		if (item.itemType) return isTrackType(item.itemType);
		return /^\d/.test(item.title);
	}

	function shouldQuickPlayActionList(item: BrowseItem): boolean {
		// Track rows always quick-play, regardless of title shape.
		if (isTrackType(item.itemType)) return true;
		// For any other itemType (or none), fall back to title heuristics.
		// `/^play\b/i` is a strong positive signal across itemType values:
		// `Play Work` may carry `itemType: "work"` or `"action"`, but it's
		// still an explicit play action — not blocking on itemType here
		// keeps that path working. The numeric prefix only fires as a
		// track signal when itemType is absent (legacy fallback for the
		// untyped track-row path).
		const title = item.title.trim();
		if (/^play\b/i.test(title)) return true;
		if (!item.itemType && /^\d/.test(title)) return true;
		return false;
	}

	/**
	 * True when the current level renders as a track list. A page is a
	 * track list when every item is `action_list` AND at least one item
	 * classifies as a track. The second clause keeps "Work"-style pages
	 * (e.g. `Play Work` + `On Ocean to Ocean by Tori Amos`) — which are
	 * pure action_list but contain no real tracks — out of the track
	 * layout.
	 */
	const isTrackList = $derived.by(() => {
		const cur = $browseStore.current;
		if (!cur || cur.items.length === 0) return false;
		if (!cur.items.every((i) => i.hint === 'action_list')) return false;
		return cur.items.some(isTrackItem);
	});

	/**
	 * In a mixed list (e.g. artist page): action_list items like "Play Artist" shown as pill buttons.
	 * In a pure tracklist: page-level actions like "Play Work" — items that aren't classified as tracks.
	 */
	const pageActions = $derived(
		isTrackList
			? ($browseStore.current?.items.filter((i) => !isTrackItem(i)) ?? [])
			: ($browseStore.current?.items.filter((i) => i.hint === 'action_list') ?? [])
	);

	/** Individual tracks — items classified as `track` semantically (or numbered, in legacy fallback). */
	const trackItems = $derived(
		isTrackList
			? ($browseStore.current?.items.filter(isTrackItem) ?? [])
			: []
	);

	/** Non-action items for the current list. */
	const browseItems = $derived(
		isTrackList
			? []
			: ($browseStore.current?.items.filter((i) => i.hint !== 'action_list') ?? [])
	);

	/** Levels 0–1 are navigation menus; level 2+ is content (artists, albums, etc.). */
	const isContentList = $derived(($browseStore.current?.level ?? 0) >= 2);

	const gridItems = $derived(isContentList ? browseItems : []);
	const listItems = $derived(isContentList ? [] : browseItems);

	/** Alphabetic jump list — unique first letters from the displayed items. */
	const jumpLetters = $derived.by(() => {
		if (isTrackList || browseItems.length <= 20) return [];
		const seen = new Set<string>();
		for (const item of browseItems) {
			const ch = item.title.charAt(0).toUpperCase();
			seen.add(/[A-Z]/.test(ch) ? ch : '#');
		}
		return Array.from(seen).sort((a, b) => (a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b)));
	});

	/** For each letter, the index of the first browseItem starting with it. */
	const jumpIndex = $derived.by(() => {
		const map = new Map<string, number>();
		for (let i = 0; i < browseItems.length; i++) {
			const ch = browseItems[i].title.charAt(0).toUpperCase();
			const letter = /[A-Z]/.test(ch) ? ch : '#';
			if (!map.has(letter)) map.set(letter, i);
		}
		return map;
	});

	function itemLetter(title: string): string {
		const ch = title.charAt(0).toUpperCase();
		return /[A-Z]/.test(ch) ? ch : '#';
	}

	function jumpId(item: BrowseItem, index: number): string | undefined {
		const letter = itemLetter(item.title);
		return jumpIndex.get(letter) === index ? `jump-${letter}` : undefined;
	}

	async function jumpTo(letter: string) {
		const el = document.getElementById(`jump-${letter}`);
		if (el) {
			el.scrollIntoView({ behavior: 'smooth', block: 'start' });
			return;
		}
		// Letter not in the loaded slice yet — pull the rest, then jump.
		await loadMore({ all: true });
		// Wait one tick for derived state to flush.
		await new Promise((r) => setTimeout(r, 0));
		const after = document.getElementById(`jump-${letter}`);
		if (after) after.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	/** Extract the leading track number from a title like "3. Song Name" → "3" */
	function trackNum(title: string, index: number): string {
		return title.match(/^(\d+)\./)?.[1] ?? String(index + 1);
	}

	/** Strip the leading "N. " prefix from a track title. */
	function trackTitle(title: string): string {
		return title.replace(/^\d+\.\s*/, '');
	}
</script>

<div class="library-shell">
	{#if $browseStore.searchLoading || $browseStore.searchError || $browseStore.lastSearch}
		<section class="search-results-panel card">
			<Search mode="results" onResultClick={handleSearchResultClick} />
		</section>
	{/if}

	<section class="results-panel card">
		{#if $browseStore.loading}
			<p class="loading">Loading library data...</p>
		{:else if $browseStore.error}
			<div class="error">
				<p>{$browseStore.error}</p>
			</div>
		{:else if $browseStore.current}
			<div class="result-header">
				<div>
					<h2>{$browseStore.current.title || 'Browse'}</h2>
					{#if $browseStore.current?.subtitle && !isTrackList}
						<button
							type="button"
							class="artist-link"
							onclick={() => searchArtist($browseStore.current!.subtitle!)}
							title="Search for this artist"
						>{$browseStore.current.subtitle}</button>
					{/if}
				</div>
				{#if pageActions.length > 0}
					<div class="page-actions">
						{#each pageActions as action}
							<button
								type="button"
								class="album-action-btn"
								onclick={() => handleItemClick(action)}
								disabled={!action.itemKey || quickPlayInFlight}
							>{action.title}</button>
						{/each}
					</div>
				{/if}
			</div>

			{#if jumpLetters.length > 0}
				<nav class="jump-bar" aria-label="Alphabetic index">
					{#each jumpLetters as letter}
						<button type="button" class="jump-letter" onclick={() => jumpTo(letter)}>{letter}</button>
					{/each}
				</nav>
			{/if}

			{#if isTrackList}
				{#if $browseStore.current?.subtitle}
					<div class="album-header">
						<button
							type="button"
							class="artist-link"
							onclick={() => searchArtist($browseStore.current!.subtitle!)}
							title="Search for this artist"
						>{$browseStore.current.subtitle}</button>
					</div>
				{/if}
				<ol class="track-list">
					{#each trackItems as item, index}
						<li class="track-row">
							<span class="track-num">{trackNum(item.title, index)}</span>
							<div class="track-info">
								<span class="track-title">{trackTitle(item.title)}</span>
								{#if item.subtitle}
									<span class="track-sub">{item.subtitle}</span>
								{/if}
							</div>
							<div class="track-actions">
								<button
									type="button"
									class="track-play"
									onclick={() => handleItemClick(item)}
									disabled={!item.itemKey || quickPlayInFlight}
									title="Play now"
								>▶</button>
								{#if item.itemKey}
									<button
										type="button"
										class="track-more"
										title="More options"
										onclick={() => openActionMenu(item)}
									>⋮</button>
								{/if}
							</div>
						</li>
					{/each}
				</ol>
			{:else}
				{#if listItems.length > 0}
					<ul class="list-items">
						{#each listItems as item, index}
							<li id={jumpId(item, index)}>
								<button
									type="button"
									class="list-item-btn"
									onclick={() => handleItemClick(item)}
									disabled={!item.itemKey}
								>
									<span class="list-item-title">{item.title}</span>
									{#if item.subtitle}
										<span class="list-item-sub">{item.subtitle}</span>
									{/if}
								</button>
							</li>
						{/each}
					</ul>
				{/if}
				{#if gridItems.length > 0}
					<div class="items-grid">
						{#each gridItems as item, index}
							<div
								class="item-wrapper"
								style={`--delay: ${Math.min(index * 20, 240)}ms`}
								id={jumpId(item, index)}
							>
								<button
									type="button"
									class="item-card"
									onclick={() => handleItemClick(item)}
									disabled={!item.itemKey}
									title={item.title}
								>
									<div class="item-art">
										{#if item.imageKey}
											<img src="/api/image/{item.imageKey}?scale=fit&width=320&height=320" alt={item.title} />
										{:else}
											<span class="art-placeholder">{item.title.charAt(0)}</span>
										{/if}
									</div>
									<div class="item-meta">
										<p class="title">{item.title}</p>
										{#if item.subtitle}
											<p class="subtitle">{item.subtitle}</p>
										{/if}
									</div>
								</button>
							</div>
						{/each}
					</div>
				{/if}
				{#if $browseStore.current && !isTrackList && $browseStore.current.items.length < ($browseStore.current.totalCount ?? $browseStore.current.count)}
					<div class="load-more-bar">
						<span class="load-meta">
							Showing {$browseStore.current.items.length} of {$browseStore.current.totalCount ?? $browseStore.current.count}
						</span>
						<div class="load-actions">
							<button type="button" onclick={() => loadMore()} disabled={loadMoreInFlight}>
								{loadMoreInFlight ? 'Loading…' : 'Load more'}
							</button>
							<button type="button" onclick={() => loadMore({ all: true })} disabled={loadMoreInFlight}>
								Load all
							</button>
						</div>
					</div>
				{/if}
			{/if}
		{:else}
			<div class="welcome">
				<h2>Welcome</h2>
				<p>Pick something from <strong>Explore</strong> on the left to start browsing your library — Albums, Artists, Tracks, Composers, Genres, Playlists.</p>
				<p class="welcome-hint">Or use the search box up top to jump straight to an artist or album.</p>
			</div>
		{/if}
	</section>
</div>

<style>
	.library-shell {
		display: grid;
		gap: 0.85rem;
	}

	.search-results-panel {
		padding: 0.85rem;
		background: var(--surface);
	}

	.results-panel {
		padding: 0.85rem;
		background: var(--surface);
	}

	.welcome {
		padding: 2rem 1.4rem;
		max-width: 640px;
	}

	.welcome h2 {
		font-family: var(--font-display);
		font-size: 1.4rem;
		margin-bottom: 0.6rem;
	}

	.welcome p {
		font-size: 0.95rem;
		line-height: 1.55;
		color: var(--text-soft);
	}

	.welcome-hint {
		margin-top: 0.7rem;
		font-size: 0.86rem;
		opacity: 0.78;
	}

	.loading {
		color: var(--text-soft);
	}

	.error {
		padding: 0.8rem;
		background: rgba(255, 124, 124, 0.1);
		border: 1px solid rgba(255, 124, 124, 0.4);
		border-radius: 10px;
		color: #ffb3b3;
	}

	/* ── Jump bar ── */
	.jump-bar {
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem;
		margin-bottom: 0.7rem;
		position: sticky;
		top: 0;
		z-index: 5;
		background: var(--surface);
		padding: 0.4rem 0;
	}

	.jump-letter {
		min-width: 1.7rem;
		padding: 0.2rem 0;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface-2);
		color: var(--text);
		font-size: 0.75rem;
		font-weight: 600;
		font-family: var(--font-mono);
		cursor: pointer;
		text-align: center;
		line-height: 1;
	}

	.jump-letter:hover {
		background: var(--accent);
		color: var(--bg);
		border-color: var(--accent);
	}

	.result-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.8rem;
		margin-bottom: 0.85rem;
		flex-wrap: wrap;
	}

	.result-header h2 {
		font-family: var(--font-display);
		font-size: 1.2rem;
	}

	.page-actions {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	/* ── Album header (artist link in tracklist view) ── */
	.album-header {
		margin-bottom: 0.5rem;
	}

	.artist-link {
		font-size: 0.88rem;
		font-weight: 600;
		color: var(--accent-2);
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	.artist-link:hover {
		opacity: 0.8;
	}

	.album-action-btn {
		padding: 0.45rem 1rem;
		border: 1px solid var(--accent);
		border-radius: 20px;
		background: transparent;
		color: var(--accent);
		font-size: 0.85rem;
		font-weight: 600;
		cursor: pointer;
		transition: background 120ms ease;
	}

	.album-action-btn:hover:not(:disabled) {
		background: rgba(95, 109, 240, 0.15);
	}

	.album-action-btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	/* ── Track list (album view) ── */
	.track-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.track-row {
		display: grid;
		grid-template-columns: 2rem 1fr auto;
		align-items: center;
		gap: 0.6rem;
		padding: 0.48rem 0.4rem;
		border-radius: 8px;
	}

	.track-row:hover {
		background: var(--surface-2);
	}

	.track-row + .track-row {
		border-top: 1px solid var(--border);
	}

	.track-num {
		font-family: var(--font-mono);
		font-size: 0.78rem;
		color: var(--text-soft);
		text-align: right;
	}

	.track-info {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		min-width: 0;
	}

	.track-title {
		font-weight: 580;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.track-sub {
		font-size: 0.8rem;
		color: var(--text-soft);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.track-actions {
		display: flex;
		gap: 0.28rem;
		align-items: center;
		opacity: 0;
		transition: opacity 120ms ease;
	}

	.track-row:hover .track-actions,
	.track-row:focus-within .track-actions {
		opacity: 1;
	}

	.track-play,
	.track-more {
		border: 1px solid var(--border);
		border-radius: 7px;
		background: var(--surface-3);
		color: var(--text);
		cursor: pointer;
	}

	.track-play {
		padding: 0.28rem 0.55rem;
		font-size: 0.72rem;
	}

	.track-more {
		padding: 0.28rem 0.42rem;
		font-size: 0.88rem;
		line-height: 1;
	}

	.track-play:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	@media (max-width: 600px) {
		.track-actions {
			opacity: 1;
		}
	}

	/* ── List items (no artwork) ── */
	.list-items {
		list-style: none;
		margin: 0 0 0.85rem;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.list-item-btn {
		width: 100%;
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
		padding: 0.52rem 0.5rem;
		border: none;
		border-radius: 8px;
		background: none;
		color: var(--text);
		text-align: left;
		cursor: pointer;
	}

	.list-item-btn:hover:not(:disabled) {
		background: var(--surface-2);
	}

	.list-item-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.list-items li + li .list-item-btn {
		border-top: 1px solid var(--border);
		border-radius: 0;
	}

	.list-items li:first-child .list-item-btn {
		border-radius: 8px 8px 0 0;
	}

	.list-items li:last-child .list-item-btn {
		border-radius: 0 0 8px 8px;
	}

	.list-items li:only-child .list-item-btn {
		border-radius: 8px;
	}

	.list-item-title {
		font-weight: 600;
	}

	.list-item-sub {
		font-size: 0.82rem;
		color: var(--text-soft);
	}

	/* ── Card grid ── */
	.items-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
		gap: 0.62rem;
	}

	/* Wrapper enables the ⋮ button overlay on tracks */
	.item-wrapper {
		position: relative;
		animation: rise-in 280ms ease both;
		animation-delay: var(--delay);
	}

	.item-card {
		width: 100%;
		padding: 0.48rem;
		border: 1px solid var(--border);
		border-radius: 11px;
		background: var(--surface-2);
		text-align: left;
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
		color: var(--text);
	}

	.item-card:hover:not(:disabled) {
		border-color: var(--accent-2);
		box-shadow: var(--shadow-soft);
		transform: translateY(-1px);
	}

	.item-card:disabled {
		opacity: 0.72;
		cursor: default;
	}

	.item-art {
		aspect-ratio: 1 / 1;
		border-radius: 9px;
		overflow: hidden;
		background: var(--surface-3);
		display: grid;
		place-items: center;
		font-size: 0.76rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-soft);
	}

	.item-art img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.art-placeholder {
		font-size: 2.5rem;
		font-weight: 700;
		font-family: var(--font-display);
		color: var(--text-soft);
		opacity: 0.5;
		text-transform: uppercase;
		user-select: none;
	}

	.item-meta .title {
		font-weight: 650;
		line-height: 1.3;
	}

	.item-meta .subtitle {
		margin-top: 0.15rem;
		font-size: 0.82rem;
		color: var(--text-soft);
		line-height: 1.33;
	}

	@media (max-width: 820px) {
		/* Always show track actions on touch */
		.track-actions {
			opacity: 1;
		}
	}

	/* ── Load more bar ── */
	.load-more-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
		padding: 0.7rem 0.4rem;
		margin-top: 0.6rem;
		border-top: 1px solid var(--border);
	}

	.load-meta {
		font-size: 0.78rem;
		color: var(--text-soft);
		font-family: var(--font-mono);
	}

	.load-actions {
		display: flex;
		gap: 0.4rem;
	}

	.load-actions button {
		padding: 0.42rem 0.85rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface-2);
		color: var(--text);
		font-size: 0.82rem;
		font-weight: 600;
		cursor: pointer;
	}

	.load-actions button:hover:not(:disabled) {
		background: var(--surface-3);
		border-color: var(--accent-2);
	}

	.load-actions button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
