<script lang="ts">
	import '../app.css';
	import { page } from '$app/stores';
	import { onMount, untrack } from 'svelte';
	import { coreStore, isCorePaired } from '$lib/stores/coreStore';
	import {
		initializeStores,
		clearCommandFeedback,
		nowPlayingList,
		selectedZoneStore,
		setSelectedZone,
		themeStore,
		toggleTheme,
		initializeTheme,
		pushCommandFeedback,
		pendingSearchStore,
		browseNavStore,
		socketStatusStore,
		exploreRailStore,
		resolveExploreRail,
		invalidateExploreRail,
		pushHistory,
		resetHistory,
		type ExploreRailEntry
	} from '$lib/stores';
	import {
		browseStore,
		setBrowseLoading,
		setBrowseResult,
		setSearchLoading,
		snapshotBrowseState,
		restoreBrowseStateIfUnchanged,
		type BrowseStateSnapshot
	} from '$lib/stores/browseStore';
	import { SEARCH_SESSION_KEY } from '$lib/browseSessions';
	import { goto } from '$app/navigation';
	import { zonesStore, zoneMapStore } from '$lib/stores/zonesStore';
	import { registerSocketHandlers } from '$lib/socket/register';
	import { getSocket } from '$lib/socket/client';
	import { emitWithAck } from '$lib/socket/emit';
	import { browse as apiBrowse } from '$lib/api/client';
	import { get } from 'svelte/store';
	import ErrorToast from '$lib/components/ErrorToast.svelte';
	import Search from '$lib/components/Search.svelte';
	import NowPlayingOverlay from '$lib/components/NowPlayingOverlay.svelte';
	import { openNowPlayingOverlay } from '$lib/stores/nowPlayingOverlayStore';
	import ZoneGroupingModal from '$lib/components/ZoneGroupingModal.svelte';
	import { openZoneGrouping } from '$lib/stores/zoneGroupingStore';
	import { imageUrl } from '$lib/imageUrl';
	import type {
		TransportControlRequest,
		SeekRequest,
		VolumeRequest,
		ZoneOutput
	} from '@shared/types';

	let { children } = $props();

	let socket = $state(getSocket());
	let commandInFlight = $state(false);
	let railNavInFlight = $state(false);
	let mobileNavOpen = $state(false);

	onMount(() => {
		socket = getSocket();
		initializeTheme();
		const cleanupSocket = registerSocketHandlers();
		void initializeStores(fetch);

		return () => {
			cleanupSocket();
			clearCommandFeedback();
		};
	});

	// Resolve the Explore rail at mount and whenever Roon Core (re)pairs.
	// Cached itemKeys go stale on Core restart, so a reconnect must
	// trigger a fresh resolve. `invalidateExploreRail` runs on un-pair to
	// clear visibly-stale entries during the reconnect window.
	$effect(() => {
		const status = $coreStore.status;
		// Read inside untrack so we don't loop on entries changes.
		untrack(() => {
			if (status === 'paired') {
				void resolveExploreRail(fetch);
			} else if (status === 'discovering' || status === 'unpaired') {
				invalidateExploreRail();
			}
		});
	});

	$effect(() => {
		const zones = $zonesStore;
		const selected = $selectedZoneStore;
		if (zones.length === 0) {
			// Don't clear the persisted choice — the zone may reappear after a
			// Roon Core reconnect. Just leave selected as-is so it rehydrates.
			return;
		}
		if (!selected || !zones.some((z) => z.zone_id === selected)) {
			setSelectedZone(zones[0].zone_id);
		}
	});

	const connectedLabel = $derived(
		$socketStatusStore === 'connecting'
			? 'Connecting…'
			: $socketStatusStore === 'disconnected'
				? 'Disconnected'
				: $isCorePaired
					? 'Connected'
					: 'Searching for Core…'
	);
	const connectedGood = $derived($socketStatusStore === 'connected' && $isCorePaired);
	const activeZone = $derived($selectedZoneStore ? $zoneMapStore.get($selectedZoneStore) : undefined);
	const nowPlaying = $derived(
		$selectedZoneStore ? $nowPlayingList.find((t) => t.zone_id === $selectedZoneStore) : undefined
	);

	// Group rail entries by their parent label for sectioned rendering.
	// Top-level entries have labelPath length 1; nested entries (today
	// only Library children) have length 2 with the parent at index 0.
	const railSections = $derived.by(() => {
		const sections = new Map<string | null, ExploreRailEntry[]>();
		for (const entry of $exploreRailStore.entries) {
			const parent = entry.labelPath.length > 1 ? entry.labelPath[0] : null;
			const list = sections.get(parent) ?? [];
			list.push(entry);
			sections.set(parent, list);
		}
		return sections;
	});

	const railTopLevel = $derived(railSections.get(null) ?? []);
	const railLibrary = $derived(railSections.get('Library') ?? []);

	function getLiveSocket() {
		const s = socket ?? getSocket();
		socket = s;
		if (!s) {
			pushCommandFeedback({ source: 'transport', command: 'socket', message: 'Realtime connection unavailable.' });
			return null;
		}
		return s;
	}

	async function sendCommand(event: string, payload: TransportControlRequest) {
		const s = getLiveSocket();
		if (!s || commandInFlight) return;
		commandInFlight = true;
		try {
			await emitWithAck(s, event, payload, {
				timeoutMs: 3000,
				feedback: { source: 'transport', command: event }
			});
		} finally {
			commandInFlight = false;
		}
	}

	function playPause() {
		if ($selectedZoneStore) void sendCommand('transport:play-pause', { zone_id: $selectedZoneStore });
	}
	function next() {
		if ($selectedZoneStore) void sendCommand('transport:next', { zone_id: $selectedZoneStore });
	}
	function previous() {
		if ($selectedZoneStore) void sendCommand('transport:previous', { zone_id: $selectedZoneStore });
	}

	/**
	 * Ungroup the active zone. Roon's ungroup_outputs takes the list
	 * of outputs to split off; passing all-but-the-first effectively
	 * dissolves the group while keeping the first output as its own
	 * zone. The button only renders when the active zone has >1
	 * output (a single-output "zone" is already ungrouped).
	 */
	async function ungroupCurrent() {
		const z = activeZone;
		if (!z || !z.outputs || z.outputs.length < 2 || commandInFlight) return;
		const s = getLiveSocket();
		if (!s) return;
		commandInFlight = true;
		try {
			await emitWithAck(
				s,
				'transport:ungroup',
				{ output_ids: z.outputs.slice(1).map((o) => o.output_id) },
				{
					timeoutMs: 5000,
					feedback: { source: 'transport', command: 'transport:ungroup' }
				}
			);
		} finally {
			commandInFlight = false;
		}
	}

	const isPlaying = $derived(activeZone?.state === 'playing');
	const canPlay = $derived(!!(activeZone?.is_play_allowed || activeZone?.is_pause_allowed));
	const canPrev = $derived(!!activeZone?.is_previous_allowed);
	const canNext = $derived(!!activeZone?.is_next_allowed);
	const canSeek = $derived(!!activeZone?.is_seek_allowed);
	const seekPosition = $derived(activeZone?.seek_position ?? 0);
	const duration = $derived(nowPlaying?.duration ?? 0);
	const progress = $derived(duration > 0 ? Math.min(seekPosition / duration, 1) : 0);

	function formatTime(seconds: number): string {
		if (!seconds || seconds < 0) return '0:00';
		const whole = Math.floor(seconds);
		const m = Math.floor(whole / 60);
		const s = whole % 60;
		return `${m}:${String(s).padStart(2, '0')}`;
	}

	function seekTo(e: MouseEvent) {
		if (!canSeek || !duration || !$selectedZoneStore) return;
		const bar = e.currentTarget as HTMLElement;
		const rect = bar.getBoundingClientRect();
		const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
		const seconds = Math.floor(fraction * duration);
		const s = getLiveSocket();
		if (s) {
			void emitWithAck(s, 'transport:seek', { zone_id: $selectedZoneStore, seconds } satisfies SeekRequest, {
				feedback: { source: 'transport', command: 'transport:seek' }
			});
		}
	}

	// Volume control. We target the first output that has a volume control —
	// fixed-volume DACs (most of yours) report no volume settings, so the
	// slider just hides. Multi-output zones still get a working slider for
	// the first controllable endpoint.
	const volumeOutput = $derived<ZoneOutput | undefined>(
		activeZone?.outputs?.find((o) => o.volume !== undefined)
	);
	const volumeIsIncremental = $derived(volumeOutput?.volume?.type === 'incremental');

	function sendVolume(value: number) {
		const out = volumeOutput;
		if (!out?.volume) return;
		const s = getLiveSocket();
		if (!s) return;
		void emitWithAck(s, 'transport:volume', { output_id: out.output_id, value } satisfies VolumeRequest, {
			feedback: { source: 'transport', command: 'transport:volume' }
		});
	}

	// rAF-throttled volume slider. Native range inputs fire `input` on
	// every pixel of drag — without throttling we flood Roon with
	// commands AND get a stale-ack toast storm. We coalesce to one
	// emit per animation frame (max 60Hz) and always send the LATEST
	// pending value, including the final drag position when the user
	// releases. The +/- buttons stay as direct sendVolume() calls;
	// they're discrete clicks, not drag, so no need to throttle.
	let pendingVolume: number | null = null;
	let volumeRafId: number | null = null;

	function flushVolume() {
		volumeRafId = null;
		if (pendingVolume === null) return;
		const value = pendingVolume;
		pendingVolume = null;
		sendVolume(value);
	}

	function onVolumeSlide(e: Event) {
		const target = e.currentTarget as HTMLInputElement;
		const value = Number(target.value);
		if (!Number.isFinite(value)) return;
		pendingVolume = value;
		if (volumeRafId === null) {
			volumeRafId = requestAnimationFrame(flushVolume);
		}
	}

	function onVolumeStep(delta: number) {
		// For incremental outputs, send the step delta directly. The backend
		// detects the type and switches to Roon's `relative` mode.
		sendVolume(delta);
	}

	function searchInLibrary(query: string) {
		pendingSearchStore.set(query);
		void goto('/library');
	}

	let playBarNavInFlight = $state(false);

	/**
	 * Resolve a play-bar link (artist name / album name) to a real
	 * Roon page via the search hierarchy. Searches Roon for the
	 * input, finds the first matching result by itemType, and
	 * navigates the right pane to it. Falls back to opening the raw
	 * search results page (via `pendingSearchStore`) on miss so the
	 * user still gets *something* useful.
	 */
	/**
	 * Roon's `item_type` / `item_subtype` come back raw — sometimes
	 * plural (`albums`), sometimes capitalized (`Album`). Normalize
	 * the same way `BrowseService.inferSearchType` does so the
	 * matcher accepts singular and plural variants regardless of case.
	 */
	function itemTypeMatches(actual: string | undefined, expectedSingular: string): boolean {
		const a = (actual ?? '').toLowerCase();
		if (!a) return false;
		const e = expectedSingular.toLowerCase();
		return a === e || a === `${e}s`;
	}

	async function resolveAndNavigate(opts: {
		input: string;
		expectedItemType: string;
		matchSubtitle?: string;
		breadcrumb: { title: string; itemType: string };
	}): Promise<void> {
		if (playBarNavInFlight) return;
		playBarNavInFlight = true;
		try {
			const zoneId = $selectedZoneStore || undefined;
			const onLibrary = $page.url.pathname === '/library';

			const search = await apiBrowse(fetch, {
				hierarchy: 'search',
				input: opts.input,
				zoneId,
				multiSessionKey: SEARCH_SESSION_KEY,
				popAll: true
			});

			const targetLower = opts.input.toLowerCase();
			const subtitleLower = opts.matchSubtitle?.toLowerCase();

			const match = search.items.find((candidate) => {
				if (!candidate.itemKey) return false;
				if (!itemTypeMatches(candidate.itemType, opts.expectedItemType)) return false;
				if ((candidate.title ?? '').toLowerCase() !== targetLower) return false;
				if (subtitleLower) {
					const sub = (candidate.subtitle ?? '').toLowerCase();
					if (!sub.includes(subtitleLower)) return false;
				}
				return true;
			});

			if (!match?.itemKey) {
				// Couldn't pin the entity — fall back to showing search results.
				searchInLibrary(opts.input);
				return;
			}

			// Drill into the matched entity BEFORE mutating visible
			// state. The old code set setSearchLoading + resetHistory
			// + pushHistory before this call; a drill failure left
			// searchLoading stuck true, the prior back stack wiped, and
			// (off-library) a staged search-rooted history step without
			// a goto. The first apiBrowse already returned successfully,
			// so the drill is the only remaining failure point — defer
			// all state mutation until it succeeds.
			const result = await apiBrowse(fetch, {
				hierarchy: 'search',
				itemKey: match.itemKey,
				zoneId,
				multiSessionKey: SEARCH_SESSION_KEY
			});

			// Drill succeeded — atomic commit of search context +
			// history + pane. setSearchLoading also re-seeds
			// lastSearchQuery so Search.svelte's "for X" label and the
			// library page's forward-nav reads match the entity we just
			// opened. On /library setBrowseResult flips searchLoading
			// back to false; the off-library path leaves it set briefly
			// until mount's restoreBrowse renders the result.
			setSearchLoading(opts.input);
			resetHistory();
			pushHistory(
				{ hierarchy: 'search', itemKey: match.itemKey, zoneId, multiSessionKey: SEARCH_SESSION_KEY },
				opts.input,
				{
					title: opts.breadcrumb.title,
					subtitle: match.subtitle,
					imageKey: match.imageKey,
					// Persist the ACTUAL Roon-supplied itemType, not the
					// expected singular. The expected was just an input to
					// matching; storing it would lose plural/case info that
					// the live result happened to have. matchBreadcrumb
					// normalizes during compare, so either form works on
					// remount, but recording reality keeps the breadcrumb
					// honest.
					itemType: match.itemType ?? opts.breadcrumb.itemType
				}
			);

			if (onLibrary) {
				setBrowseResult(result, 'search');
			} else {
				void goto('/library');
			}
		} catch (err) {
			pushCommandFeedback({
				source: 'browse',
				command: 'play-bar',
				message: `Couldn't open: ${(err as Error).message}`
			});
			// No restore needed: we deferred all visible-state mutation
			// until after the drill succeeded, so a failure of either
			// apiBrowse leaves history + browseStore untouched.
		} finally {
			playBarNavInFlight = false;
		}
	}

	function openArtistPage(name: string): void {
		if (!name) return;
		void resolveAndNavigate({
			input: name,
			expectedItemType: 'artist',
			breadcrumb: { title: name, itemType: 'artist' }
		});
	}

	function openAlbumOfNowPlaying(): void {
		const album = nowPlaying?.album;
		const artist = nowPlaying?.artist;
		if (!album) return;
		void resolveAndNavigate({
			input: album,
			expectedItemType: 'album',
			matchSubtitle: artist,
			breadcrumb: { title: album, itemType: 'album' }
		});
	}

	/**
	 * Navigate the right pane to a rail entry. Always does a label-walk
	 * (REST drill from root, matching by title at each level). PR1
	 * intentionally skips the cached-key fast path documented in the
	 * UX overhaul plan — label-walk is correct and 2-3 calls is fast on
	 * LAN. The fast-path optimization can land in a follow-up PR.
	 *
	 * The walk pushes history with breadcrumbs as it goes, so a later
	 * route remount can replay via Phase A's restore. If we're not on
	 * /library, the goto kicks Library's mount, which calls
	 * restoreBrowse — that flow re-walks via the persisted history and
	 * delivers the result through the normal browseStore path.
	 */
	async function navigateToRailEntry(entry: ExploreRailEntry): Promise<void> {
		if (railNavInFlight) return;
		railNavInFlight = true;
		mobileNavOpen = false;

		const onLibrary = $page.url.pathname === '/library';
		const zoneId = $selectedZoneStore || undefined;

		// Snapshot the prior browse state so a mid-walk failure can
		// restore it. The old code mutated visible state up-front
		// (setBrowseLoading + resetHistory) BEFORE the first apiBrowse;
		// a failure left the pane stuck in "loading" with the user's
		// back stack wiped. Now state mutations are deferred until the
		// whole label-walk succeeds — on any failure (catch OR stale-
		// label early return), we revert via conditional restore.
		//
		// Two snapshots are needed for the conditional-restore
		// strategy. `priorSnapshot` records what we want to roll back
		// TO. `afterLoadingSnapshot` (captured below, immediately after
		// setBrowseLoading) records what we mutated TO. On rollback,
		// only fields whose current value still equals
		// `afterLoadingSnapshot` are restored — anything an
		// independent writer touched mid-await (e.g. a search-result
		// socket landing during the REST walk) is preserved.
		// Full-state restore (M-1 reopen #2) wiped those independent
		// updates; this conditional restore is M-1 reopen #3.
		const priorSnapshot = onLibrary ? snapshotBrowseState(get(browseStore)) : null;
		let afterLoadingSnapshot: BrowseStateSnapshot | null = null;

		const restorePriorView = () => {
			if (!onLibrary || !priorSnapshot || !afterLoadingSnapshot) return;
			restoreBrowseStateIfUnchanged(priorSnapshot, afterLoadingSnapshot);
		};

		try {
			if (onLibrary) {
				setBrowseLoading('browse');
				afterLoadingSnapshot = snapshotBrowseState(get(browseStore));
			}

			// Fast-path: rail resolver populates `cachedKey` (the leaf
			// Roon itemKey) and `cachedAncestorKeys` (the keys for the
			// ancestor steps in labelPath). On click we walk the
			// cached chain — popAll + drill each ancestor + drill the
			// leaf — skipping the label-scan step the slow path does
			// between drills.
			//
			// Roon's browse session is stack-based: each drill pushes
			// a level. We MUST drill every ancestor, not just the leaf
			// directly: skipping ancestors would leave the Roon session
			// at `root → leaf` while UI history pushed
			// `root → ancestor → leaf`, and a subsequent Back's
			// popLevel=1 would diverge the two stacks. REST call count
			// matches the label walk; the win is purely "no result
			// parsing / label matching" + "known-good keys".
			//
			// On any drill failure (most likely a stale cached key
			// after a Core restart) we fall through to the label-walk,
			// which re-discovers via title matching. The resolver
			// re-runs on the next core-status: paired anyway.
			const canTryFastPath =
				entry.cachedKey !== undefined &&
				entry.cachedAncestorKeys !== undefined &&
				entry.cachedAncestorKeys.length === entry.labelPath.length - 1;

			if (canTryFastPath) {
				try {
					await apiBrowse(fetch, {
						hierarchy: 'browse',
						zoneId,
						popAll: true
					});
					const allKeys = [...entry.cachedAncestorKeys!, entry.cachedKey!];
					let result: Awaited<ReturnType<typeof apiBrowse>> | undefined;
					for (const key of allKeys) {
						result = await apiBrowse(fetch, {
							hierarchy: 'browse',
							zoneId,
							itemKey: key
						});
					}

					// Fast-path succeeded — commit history (one step
					// per labelPath segment, using the cached key chain).
					resetHistory();
					for (let i = 0; i < entry.labelPath.length; i++) {
						pushHistory(
							{ hierarchy: 'browse', itemKey: allKeys[i], zoneId },
							undefined,
							{ title: entry.labelPath[i] }
						);
					}

					if (onLibrary) {
						setBrowseResult(result!, 'browse');
					} else {
						void goto('/library');
					}
					return;
				} catch {
					// Fast path failed — most likely stale cached key
					// after a Core restart. Silently fall through to
					// the label-walk; the rail will be re-resolved on
					// the next core-status: paired.
				}
			}

			let cur = await apiBrowse(fetch, {
				hierarchy: 'browse',
				zoneId,
				popAll: true
			});

			// Collect the walk into a local plan; history isn't mutated
			// until every drill succeeds. Each drill's apiBrowse is the
			// next failure point — losing history mid-walk leaves the
			// user worse off than a clean rollback.
			const plan: Array<{
				itemKey: string;
				label: string;
				subtitle?: string;
				imageKey?: string;
				itemType?: string;
			}> = [];

			for (const label of entry.labelPath) {
				const match = cur.items.find((it) => it.title === label);
				if (!match?.itemKey) {
					pushCommandFeedback({
						source: 'browse',
						command: 'rail',
						message: `Rail entry "${label}" no longer in results — refreshing.`
					});
					// Stale label set; refresh the rail and restore the
					// prior view (we haven't committed any new state yet).
					void resolveExploreRail(fetch);
					restorePriorView();
					return;
				}
				cur = await apiBrowse(fetch, {
					hierarchy: 'browse',
					zoneId,
					itemKey: match.itemKey
				});
				plan.push({
					itemKey: match.itemKey,
					label,
					subtitle: match.subtitle,
					imageKey: match.imageKey,
					itemType: match.itemType
				});
			}

			// Walk succeeded — commit history + pane in one batch so a
			// failure above has had no visible effect.
			resetHistory();
			for (const step of plan) {
				pushHistory(
					{ hierarchy: 'browse', itemKey: step.itemKey, zoneId },
					undefined,
					{
						title: step.label,
						subtitle: step.subtitle,
						imageKey: step.imageKey,
						itemType: step.itemType
					}
				);
			}

			if (onLibrary) {
				// Push the result into the browseStore so the right pane
				// updates without a route remount.
				setBrowseResult(cur, 'browse');
			} else {
				// goto /library; mount runs restoreBrowse which walks the
				// freshly-pushed history and arrives at the same place.
				void goto('/library');
			}
		} catch (err) {
			pushCommandFeedback({
				source: 'browse',
				command: 'rail',
				message: `Rail navigation failed: ${(err as Error).message}`
			});
			restorePriorView();
		} finally {
			railNavInFlight = false;
		}
	}

	function toggleMobileNav() {
		mobileNavOpen = !mobileNavOpen;
	}
</script>

<div class="app-root" class:mobile-nav-open={mobileNavOpen}>
	<div class="main-area">
		<aside class="sidebar" class:open={mobileNavOpen}>
			<div class="brand-block">
				<p class="eyebrow">Roon Controller</p>
			</div>

			<nav class="explore" aria-label="Explore">
				{#if $exploreRailStore.loading && $exploreRailStore.entries.length === 0}
					<div class="rail-skeleton">
						<span class="skel-row"></span>
						<span class="skel-row"></span>
						<span class="skel-row"></span>
						<span class="skel-row"></span>
					</div>
				{:else if $exploreRailStore.error}
					<p class="rail-error">{$exploreRailStore.error}</p>
				{:else}
					{#if railLibrary.length > 0}
						<div class="rail-section">
							<h3 class="rail-section-header">Library</h3>
							{#each railLibrary as entry}
								<button
									type="button"
									class="rail-link"
									class:muted={entry.isEmpty}
									disabled={railNavInFlight}
									onclick={() => navigateToRailEntry(entry)}
								>{entry.label}</button>
							{/each}
						</div>
					{/if}

					{#if railTopLevel.length > 0}
						<div class="rail-section">
							{#each railTopLevel as entry}
								<button
									type="button"
									class="rail-link top"
									class:muted={entry.isEmpty}
									disabled={railNavInFlight}
									onclick={() => navigateToRailEntry(entry)}
								>{entry.label}</button>
							{/each}
						</div>
					{/if}
				{/if}
			</nav>

			<div class="sidebar-footer">
				<div class="status card">
					<p class="status-value" class:good={connectedGood}>{connectedLabel}</p>
					<p class="status-core">{$coreStore.core?.displayName ?? '—'}</p>
					<p class="status-version">{$coreStore.core?.displayVersion ?? ''}</p>
				</div>
			</div>
		</aside>

		{#if mobileNavOpen}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="sidebar-scrim" onclick={toggleMobileNav}></div>
		{/if}

		<section class="workspace">
			<header class="workspace-header">
			<button
				type="button"
				class="hamburger"
				aria-label="Toggle navigation"
				onclick={toggleMobileNav}
			>☰</button>

			{#if $page.url.pathname === '/library'}
				<div class="nav-btns">
					<button
						type="button"
						class="nav-btn"
						onclick={$browseNavStore.back}
						disabled={!$browseNavStore.canBack}
						aria-label="Back"
						title="Back"
					>←</button>
					<button
						type="button"
						class="nav-btn"
						onclick={$browseNavStore.home}
						aria-label="Home"
						title="Browse home"
					>⌂</button>
					<button
						type="button"
						class="nav-btn"
						onclick={$browseNavStore.forward}
						disabled={!$browseNavStore.canForward}
						aria-label="Forward"
						title="Forward"
					>→</button>
				</div>
			{:else}
				<span class="nav-spacer"></span>
			{/if}

			<div class="header-search">
				<Search mode="input" onSubmit={searchInLibrary} />
			</div>

			<button
				type="button"
				class="theme-toggle"
				title="Toggle theme"
				onclick={toggleTheme}
				aria-label="Toggle theme"
			>{$themeStore === 'dark' ? '☀' : '☾'}</button>
		</header>

			<main class="workspace-main">
				{@render children()}
			</main>
		</section>
	</div>

	<footer class="play-bar card" aria-label="Playback controls">
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="pb-progress-bar" class:seekable={canSeek} onclick={seekTo}>
		<div class="pb-progress-fill" style="width: {progress * 100}%"></div>
	</div>
	<div class="pb-track">
		<button
			type="button"
			class="pb-art pb-art-button"
			onclick={openNowPlayingOverlay}
			disabled={!nowPlaying?.title}
			aria-label="Open now playing"
		>
			{#if nowPlaying?.image_key}
				<img src={imageUrl(nowPlaying.image_key, { width: 80, height: 80 })} alt="Artwork" />
			{/if}
		</button>
		<div class="pb-meta">
			{#if nowPlaying?.title}
				<button type="button" class="pb-title pb-link" onclick={openNowPlayingOverlay}>{nowPlaying.title}</button>
			{:else}
				<p class="pb-title">Nothing playing</p>
			{/if}
			{#if nowPlaying?.artist}
				<button type="button" class="pb-sub pb-link" disabled={playBarNavInFlight} onclick={() => openArtistPage(nowPlaying!.artist!)}>{nowPlaying.artist}</button>
			{:else}
				<p class="pb-sub"></p>
			{/if}
			<span class="pb-time">{formatTime(seekPosition)} / {formatTime(duration)}</span>
		</div>
	</div>

	<div class="pb-controls">
		<button type="button" class="ctrl-btn" onclick={previous} disabled={!canPrev || commandInFlight} aria-label="Previous">⏮</button>
		<button type="button" class="ctrl-btn primary" onclick={playPause} disabled={!canPlay || commandInFlight} aria-label={isPlaying ? 'Pause' : 'Play'}>
			{isPlaying ? '⏸' : '▶'}
		</button>
		<button type="button" class="ctrl-btn" onclick={next} disabled={!canNext || commandInFlight} aria-label="Next">⏭</button>
	</div>

	<div class="pb-right">
		{#if volumeOutput?.volume}
			{#if volumeIsIncremental}
				<div class="vol-incremental" title="Volume ({volumeOutput.display_name})">
					<button type="button" class="vol-step" onclick={() => onVolumeStep(-1)} aria-label="Volume down">−</button>
					<span class="vol-icon">🔊</span>
					<button type="button" class="vol-step" onclick={() => onVolumeStep(1)} aria-label="Volume up">+</button>
				</div>
			{:else}
				<label class="vol-slider" title="Volume ({volumeOutput.display_name})">
					<span class="vol-icon" aria-hidden="true">🔊</span>
					<input
						type="range"
						min={volumeOutput.volume.min}
						max={volumeOutput.volume.max}
						step={volumeOutput.volume.step ?? 1}
						value={volumeOutput.volume.value}
						oninput={onVolumeSlide}
						aria-label="Volume"
					/>
				</label>
			{/if}
		{/if}
		<label class="visually-hidden" for="footer-zone">Zone</label>
		<select
			id="footer-zone"
			class="zone-select"
			value={$selectedZoneStore}
			onchange={(e) => setSelectedZone((e.target as HTMLSelectElement).value)}
		>
			{#if $zonesStore.length === 0}
				<option value="">No zones</option>
			{:else}
				{#each $zonesStore as zone}
					<option value={zone.zone_id}>{zone.display_name}</option>
				{/each}
			{/if}
		</select>
		<button
			type="button"
			class="zone-action-btn"
			onclick={openZoneGrouping}
			disabled={$zonesStore.length === 0}
			aria-label="Group zones"
			title="Group zones"
		>⛓</button>
		{#if activeZone?.outputs && activeZone.outputs.length > 1}
			<button
				type="button"
				class="zone-action-btn"
				onclick={ungroupCurrent}
				disabled={commandInFlight}
				aria-label="Ungroup current zone"
				title="Ungroup current zone"
			>⊟</button>
		{/if}
		<a href="/queue" class="queue-btn" data-sveltekit-preload-data="hover">Queue</a>
	</div>
	</footer>
</div>

<NowPlayingOverlay onOpenAlbum={openAlbumOfNowPlaying} />
<ZoneGroupingModal />
<ErrorToast />

<style>
	/* App-level: lock the viewport so only the workspace-main scrolls.
	   The sidebar, sticky header, and play bar stay fixed; the right
	   pane is the only scrollable surface. */
	:global(html),
	:global(body) {
		height: 100%;
		margin: 0;
		overflow: hidden;
	}

	.app-root {
		display: grid;
		grid-template-rows: 1fr auto;
		height: 100vh;
	}

	.main-area {
		display: grid;
		grid-template-columns: 200px 1fr;
		min-height: 0;
		overflow: hidden;
	}

	/* ── Sidebar ── */
	.sidebar {
		background: var(--sidebar-bg);
		color: var(--sidebar-text);
		padding: 1rem 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		border-right: 1px solid var(--sidebar-border);
		min-height: 0;
		overflow: hidden; /* internal scrolling only on .explore */
	}

	.brand-block {
		padding: 0.2rem 0.3rem 0;
	}

	.eyebrow {
		font-size: 0.74rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		opacity: 0.65;
		font-family: var(--font-display);
	}

	.explore {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}

	.rail-section {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.rail-section-header {
		font-size: 0.7rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		opacity: 0.55;
		margin: 0.4rem 0.5rem 0.2rem;
		font-family: var(--font-display);
	}

	.rail-link {
		display: block;
		text-align: left;
		padding: 0.45rem 0.7rem;
		padding-left: 1.6rem;
		border-radius: 8px;
		background: transparent;
		border: 1px solid transparent;
		color: var(--sidebar-text);
		font-size: 0.88rem;
		cursor: pointer;
		transition: background 120ms ease;
	}

	.rail-link.top {
		font-weight: 500;
		padding-left: 0.7rem;
	}

	.rail-link:hover:not(:disabled) {
		background: var(--sidebar-hover-bg);
	}

	.rail-link:disabled {
		opacity: 0.45;
		cursor: default;
	}

	.rail-link.muted {
		opacity: 0.5;
	}

	.rail-skeleton {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 0.5rem;
	}

	.skel-row {
		height: 1.1rem;
		border-radius: 6px;
		background: linear-gradient(
			90deg,
			rgba(255, 255, 255, 0.05) 0%,
			rgba(255, 255, 255, 0.12) 50%,
			rgba(255, 255, 255, 0.05) 100%
		);
		animation: rail-shimmer 1.4s linear infinite;
	}

	@keyframes rail-shimmer {
		0% { background-position: -100px 0; }
		100% { background-position: 200px 0; }
	}

	.rail-error {
		font-size: 0.8rem;
		color: var(--text-soft);
		padding: 0.5rem;
	}

	.sidebar-footer {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding-top: 0.4rem;
		border-top: 1px solid var(--sidebar-border);
	}

	.status {
		background: var(--sidebar-card-bg);
		border-color: var(--sidebar-card-border);
		color: var(--sidebar-text);
		padding: 0.55rem 0.65rem;
		border-radius: 9px;
	}

	.status-value {
		font-weight: 700;
		font-size: 0.82rem;
	}

	.status-value.good {
		color: #89f0b4;
	}

	.status-core {
		margin-top: 0.2rem;
		font-weight: 600;
		font-size: 0.82rem;
	}

	.status-version {
		font-size: 0.72rem;
		opacity: 0.62;
		margin-top: 0.05rem;
	}

	.sidebar-scrim {
		display: none;
	}

	/* ── Workspace ── */
	.workspace {
		display: flex;
		flex-direction: column;
		min-height: 0;
		min-width: 0;
		overflow: hidden;
	}

	.workspace-header {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.5rem 0.9rem;
		border-bottom: 1px solid var(--border);
		background: var(--surface-1);
		flex-shrink: 0; /* doesn't scroll with workspace-main */
	}

	.hamburger {
		display: none;
		font-size: 1.1rem;
		line-height: 1;
		padding: 0.3rem 0.55rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface-2);
		color: var(--text);
		cursor: pointer;
	}

	.nav-btns {
		display: flex;
		gap: 0.2rem;
	}

	.nav-spacer {
		width: 0;
	}

	.nav-btn {
		width: 2rem;
		height: 2rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface-2);
		color: var(--text);
		font-size: 1rem;
		display: grid;
		place-items: center;
		cursor: pointer;
		transition: background 120ms ease;
	}

	.nav-btn:hover:not(:disabled) {
		background: var(--surface-3);
	}

	.nav-btn:disabled {
		opacity: 0.35;
		cursor: default;
	}

	.header-search {
		flex: 0 0 auto;
		width: 360px;
		max-width: 50vw;
		margin-left: auto; /* push search + theme toggle to the right */
	}

	.theme-toggle {
		font-size: 1.1rem;
		line-height: 1;
		padding: 0.3rem 0.4rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface-2);
		color: var(--text);
		cursor: pointer;
		transition: background 120ms ease;
	}

	.theme-toggle:hover {
		background: var(--surface-3);
	}

	.workspace-main {
		flex: 1;
		min-height: 0;
		overflow-y: auto; /* the only scrolling surface */
		overflow-x: hidden; /* never let inner content cause page-wide horizontal scroll */
		padding: 0.9rem;
		animation: rise-in 320ms ease;
	}

	/* Cap the inner content so wide screens don't stretch grids
	   edge-to-edge, but let the scroll container itself fill. */
	.workspace-main > :global(*) {
		max-width: 1440px;
		margin: 0 auto;
	}

	/* ── Play bar (persistent footer) ── */
	.play-bar {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
		align-items: center;
		gap: 0.6rem;
		padding: 0 1rem 0.5rem;
		background: var(--mini-player-bg);
		border-color: var(--mini-player-border);
		color: var(--mini-player-text);
		margin: 0.4rem;
		border-radius: 14px;
		overflow: hidden;
	}

	.pb-progress-bar {
		grid-column: 1 / -1;
		height: 3px;
		background: rgba(255, 255, 255, 0.1);
		cursor: default;
		margin-bottom: 0.3rem;
	}

	.pb-progress-bar.seekable {
		cursor: pointer;
	}

	.pb-progress-bar.seekable:hover {
		height: 5px;
	}

	.pb-progress-fill {
		height: 100%;
		background: linear-gradient(90deg, var(--accent), var(--accent-2));
		transition: width 0.8s linear;
	}

	.pb-time {
		font-size: 0.72rem;
		font-family: var(--font-mono);
		opacity: 0.55;
		margin-top: 0.1rem;
	}

	.pb-track {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		min-width: 0;
	}

	.pb-art {
		width: 48px;
		height: 48px;
		border-radius: 8px;
		overflow: hidden;
		background: rgba(255, 255, 255, 0.08);
		flex-shrink: 0;
	}

	/* Override button defaults: the pb-art is now a button (clickable to
	   open the now-playing overlay), but it must look identical to the
	   old non-clickable square. */
	.pb-art-button {
		padding: 0;
		border: 0;
		color: inherit;
		cursor: pointer;
		display: block;
	}
	.pb-art-button:disabled {
		cursor: default;
	}
	.pb-art-button:not(:disabled):hover {
		outline: 2px solid var(--accent, #6cf);
		outline-offset: 2px;
	}

	.pb-art img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.pb-meta {
		min-width: 0;
	}

	.pb-title {
		font-weight: 650;
		font-size: 0.9rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.pb-sub {
		font-size: 0.8rem;
		opacity: 0.78;
		margin-top: 0.08rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.pb-link {
		display: block;
		background: none;
		border: none;
		padding: 0;
		text-align: left;
		color: inherit;
		cursor: pointer;
		max-width: 100%;
	}

	.pb-link:hover {
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.pb-controls {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.ctrl-btn {
		width: 2.4rem;
		height: 2.4rem;
		border-radius: 50%;
		border: 1px solid rgba(255, 255, 255, 0.15);
		background: rgba(255, 255, 255, 0.08);
		color: inherit;
		font-size: 1rem;
		display: grid;
		place-items: center;
		cursor: pointer;
		transition: background 120ms ease;
	}

	.ctrl-btn:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.16);
	}

	.ctrl-btn.primary {
		width: 2.8rem;
		height: 2.8rem;
		background: linear-gradient(135deg, var(--accent), var(--accent-2));
		border-color: transparent;
		font-size: 1.05rem;
	}

	.ctrl-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.pb-right {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		justify-content: flex-end;
	}

	.queue-btn {
		padding: 0.38rem 0.8rem;
		border-radius: 9px;
		border: 1px solid rgba(255, 255, 255, 0.2);
		background: rgba(255, 255, 255, 0.1);
		color: inherit;
		font-size: 0.85rem;
		white-space: nowrap;
		transition: background 120ms ease;
	}

	.zone-select {
		padding: 0.38rem 0.5rem;
		border-radius: 9px;
		border: 1px solid rgba(255, 255, 255, 0.18);
		background: rgba(255, 255, 255, 0.1);
		color: inherit;
		font-size: 0.85rem;
		max-width: 160px;
	}

	/* Group / ungroup icon buttons sit between the zone selector
	   and the queue link. Square-ish so the emoji glyph centers. */
	.zone-action-btn {
		padding: 0.32rem 0.55rem;
		border-radius: 9px;
		border: 1px solid rgba(255, 255, 255, 0.18);
		background: rgba(255, 255, 255, 0.07);
		color: inherit;
		font-size: 0.9rem;
		line-height: 1;
		cursor: pointer;
	}
	.zone-action-btn:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.14);
	}
	.zone-action-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.queue-btn:hover {
		background: rgba(255, 255, 255, 0.18);
	}

	.vol-slider {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.25rem 0.5rem;
		border-radius: 9px;
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid rgba(255, 255, 255, 0.15);
	}

	.vol-slider input[type='range'] {
		width: 100px;
		accent-color: var(--accent);
	}

	.vol-incremental {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.25rem 0.4rem;
		border-radius: 9px;
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid rgba(255, 255, 255, 0.15);
	}

	.vol-step {
		width: 1.6rem;
		height: 1.6rem;
		border-radius: 6px;
		border: 1px solid rgba(255, 255, 255, 0.2);
		background: rgba(255, 255, 255, 0.08);
		color: inherit;
		font-size: 0.95rem;
		line-height: 1;
		cursor: pointer;
	}

	.vol-step:hover {
		background: rgba(255, 255, 255, 0.18);
	}

	.vol-icon {
		font-size: 0.9rem;
		opacity: 0.85;
	}

	/* ── Responsive ── */
	@media (max-width: 1020px) {
		.main-area {
			grid-template-columns: 1fr;
		}

		.sidebar {
			position: fixed;
			top: 0;
			left: 0;
			bottom: 0;
			width: 240px;
			z-index: 12;
			transform: translateX(-100%);
			transition: transform 220ms ease;
		}

		.sidebar.open {
			transform: translateX(0);
			box-shadow: 4px 0 24px rgba(0, 0, 0, 0.35);
		}

		.sidebar-scrim {
			display: block;
			position: fixed;
			inset: 0;
			background: rgba(0, 0, 0, 0.5);
			z-index: 11;
			animation: scrim-fade 200ms ease;
		}

		@keyframes scrim-fade {
			from { opacity: 0; }
			to { opacity: 1; }
		}

		.hamburger {
			display: grid;
			place-items: center;
		}
	}

	@media (max-width: 680px) {
		.play-bar {
			grid-template-columns: 1fr auto;
			grid-template-rows: auto auto;
		}

		.pb-right {
			grid-column: 1 / -1;
			justify-content: flex-start;
		}

		.header-search {
			max-width: none;
		}
	}
</style>
