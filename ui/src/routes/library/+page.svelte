<script lang="ts">
	import { onMount } from 'svelte';
	import Search from '$lib/components/Search.svelte';
	import { browseStore, setBrowseError, setBrowseLoading } from '$lib/stores/browseStore';
	import { selectedZoneStore } from '$lib/stores/selectedZoneStore';
	import { pushCommandFeedback, pendingSearchStore, browseNavStore } from '$lib/stores';
	import { getSocket } from '$lib/socket/client';
	import { browse as apiBrowse } from '$lib/api/client';
	import type { BrowseItem, BrowseOptions, BrowsePopOptions, SearchResult } from '@shared/types';

	let socket = $state(getSocket());
	let quickPlayInFlight = $state(false);
	/** Options used to navigate forward to each level — used to restore on Back. */
	let historyStack: BrowseOptions[] = $state([]);
	/** Options available to re-navigate after pressing Back. */
	let forwardStack: BrowseOptions[] = $state([]);

	onMount(() => {
		socket = getSocket();
		setBrowseLoading('browse');
		browse({ hierarchy: 'browse' });

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

	const noop = () => {};

	// Keep nav store in sync with navigation state
	$effect(() => {
		browseNavStore.update((s) => ({
			...s,
			canBack: !!$browseStore.current && $browseStore.current.level > 0,
			canForward: forwardStack.length > 0
		}));
	});

	// React to search requests set by the play bar (track/artist links)
	$effect(() => {
		const query = $pendingSearchStore;
		if (query) {
			pendingSearchStore.set(null);
			setBrowseLoading('search');
			const liveSocket = socket ?? getSocket();
			socket = liveSocket;
			if (liveSocket) {
				liveSocket.emit('browse:search', { input: query, zoneId: $selectedZoneStore || undefined });
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

	function browse(options: BrowseOptions) {
		const scopedOptions: BrowseOptions = {
			...options,
			zoneId: options.zoneId ?? ($selectedZoneStore || undefined)
		};

		setBrowseLoading(scopedOptions.hierarchy ?? 'browse');
		emitBrowse('browse:browse', scopedOptions);
	}

	function pop() {
		// Move top of history to forward stack so Forward can replay it
		const top = historyStack[historyStack.length - 1];
		if (top) {
			forwardStack = [...forwardStack, top];
			historyStack = historyStack.slice(0, -1);
		}
		const options: BrowsePopOptions = {
			hierarchy: $browseStore.hierarchy,
			zoneId: $selectedZoneStore || undefined
		};
		setBrowseLoading(options.hierarchy);
		emitBrowse('browse:pop', options);
	}

	/** Internal pop used by quickPlay — does not touch history/forward stacks. */
	function popInternal() {
		emitBrowse('browse:pop', {
			hierarchy: $browseStore.hierarchy,
			zoneId: $selectedZoneStore || undefined
		});
	}

	function forward() {
		if (forwardStack.length === 0) return;
		const opts = forwardStack[forwardStack.length - 1];
		forwardStack = forwardStack.slice(0, -1);
		historyStack = [...historyStack, opts];
		browse(opts);
	}

	function resetRoot() {
		historyStack = [];
		forwardStack = [];
		browse({ hierarchy: 'browse', popAll: true });
	}

	/** Navigate into a list item (hierarchy drill-down). */
	function navigate(item: BrowseItem) {
		if (!item.itemKey) return;
		const opts: BrowseOptions = {
			hierarchy: $browseStore.hierarchy,
			itemKey: item.itemKey,
			zoneId: $selectedZoneStore || undefined
		};
		historyStack = [...historyStack, opts];
		forwardStack = [];
		browse(opts);
	}

	/** Open an item's action menu (e.g. Play Now / Play Next / Add to Queue). */
	function openActionMenu(item: BrowseItem) {
		if (!item.itemKey) return;
		browse({
			hierarchy: $browseStore.hierarchy,
			itemKey: item.itemKey,
			zoneId: $selectedZoneStore || undefined
		});
	}

	function handleSearchResultClick(result: SearchResult) {
		if (result.hint === 'action_list') {
			void quickPlay(result);
		} else {
			navigate(result);
		}
	}

	/** Search for an artist by name (from album subtitle). */
	function searchArtist(name: string) {
		const liveSocket = socket ?? getSocket();
		socket = liveSocket;
		if (!liveSocket) return;
		setBrowseLoading('search');
		liveSocket.emit('browse:search', { input: name, zoneId: $selectedZoneStore || undefined });
	}

	/**
	 * Immediately play a track-level item without navigating into its action menu.
	 * Uses a separate browse session (multiSessionKey) so main navigation is undisturbed.
	 * Flow: browse(itemKey) → find first action ("Play Now") → browse(actionKey) → plays.
	 */
	async function quickPlay(item: BrowseItem) {
		if (!item.itemKey) return;

		const zoneId = $selectedZoneStore || undefined;
		if (!zoneId) {
			pushCommandFeedback({ source: 'browse', command: 'play', message: 'Select a zone to play.' });
			return;
		}

		const hierarchyAtStart = $browseStore.hierarchy;
		quickPlayInFlight = true;
		try {
			// Browse into the track to get its action list (Play Now, Play Next, etc.)
			// Uses the main Roon session via REST — no socket broadcast with the current server setup.
			const actionResult = await apiBrowse(fetch, {
				hierarchy: hierarchyAtStart,
				itemKey: item.itemKey,
				zoneId
			});

			const playAction = actionResult.items.find((i) => i.isPlayable || i.hint === 'action');
			if (!playAction?.itemKey) {
				// No direct action — fall back to showing the action menu
				navigate(item);
				return;
			}

			// Execute Play Now
			await apiBrowse(fetch, {
				hierarchy: hierarchyAtStart,
				itemKey: playAction.itemKey,
				zoneId
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
			void quickPlay(item);
			return;
		}

		navigate(item);
	}

	/** True when the current level is a track listing (all items are action_list). */
	const isTrackList = $derived(
		!!$browseStore.current &&
		$browseStore.current.items.length > 0 &&
		$browseStore.current.items.every((i) => i.hint === 'action_list')
	);

	/**
	 * In a mixed list (e.g. artist page): action_list items like "Play Artist" shown as pill buttons.
	 * In a pure tracklist: album-level actions like "Play Album" (items not starting with a digit).
	 */
	const pageActions = $derived(
		isTrackList
			? $browseStore.current!.items.filter((i) => !/^\d/.test(i.title))
			: ($browseStore.current?.items.filter((i) => i.hint === 'action_list') ?? [])
	);

	/** Individual tracks — items whose titles start with a track number like "1. Title". */
	const trackItems = $derived(
		isTrackList
			? $browseStore.current!.items.filter((i) => /^\d/.test(i.title))
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

	function jumpTo(letter: string) {
		const el = document.getElementById(`jump-${letter}`);
		if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
	<section class="search-panel card">
		<h2>Search</h2>
		<Search onResultClick={handleSearchResultClick} />
	</section>

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
						{#each listItems as item}
							<li>
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
			{/if}
		{:else}
			<p class="loading">No content loaded.</p>
		{/if}
	</section>
</div>

<style>
	.library-shell {
		display: grid;
		gap: 0.85rem;
	}

	.search-panel {
		padding: 0.85rem;
		background: var(--surface);
	}

	.search-panel h2 {
		font-family: var(--font-display);
		font-size: 0.95rem;
		margin-bottom: 0.58rem;
	}

	.results-panel {
		padding: 0.85rem;
		background: var(--surface);
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
</style>
