<script lang="ts">
	import { SEARCH_SESSION_KEY } from '$lib/browseSessions';
	import { browseStore, setSearchError, setSearchLoading } from '$lib/stores/browseStore';
	import { selectedZoneStore } from '$lib/stores/selectedZoneStore';
	import { getSocket } from '$lib/socket/client';
	import { emitIfConnected } from '$lib/socket/emit';
	import ItemGrid from './ItemGrid.svelte';
	import type { BrowseItem, BrowseSearchOptions, SearchResult } from '@shared/types';

	type SearchMode = 'full' | 'input' | 'results';
	let {
		onResultClick,
		onSubmit,
		mode = 'full'
	}: {
		onResultClick?: (result: SearchResult) => void;
		/**
		 * Optional submit interceptor. When provided, the component calls
		 * this with the query string and skips its own socket emission.
		 * Lets the layout-level `<Search mode="input" />` redirect cross-route
		 * submissions through `pendingSearchStore` + `goto('/library')` so
		 * the user lands somewhere that actually renders the results.
		 */
		onSubmit?: (query: string) => void;
		mode?: SearchMode;
	} = $props();

	let searchQuery = $state('');
	let socket = $state(getSocket());

	/**
	 * Per-group pagination state. Tracks how many items of each result type
	 * are currently revealed; "Show more" bumps the count by PAGE_SIZE.
	 */
	const PAGE_SIZE = 12;
	let pageSize: Record<string, number> = $state({});
	let lastQueryDisplayed = $state<string | null>(null);

	function search() {
		const query = searchQuery.trim();
		if (!query) {
			return;
		}

		// Layout-level submit interceptor (header input). It routes the
		// query through `pendingSearchStore` + `goto('/library')` so a
		// search from /queue lands on /library where results render.
		if (onSubmit) {
			onSubmit(query);
			return;
		}

		const liveSocket = socket ?? getSocket();
		socket = liveSocket;

		if (!liveSocket) {
			setSearchError('Realtime connection is unavailable.');
			return;
		}

		const options: BrowseSearchOptions = {
			input: query,
			zoneId: $selectedZoneStore || undefined,
			multiSessionKey: SEARCH_SESSION_KEY,
			popAll: true
		};
		// emitIfConnected fails fast if the socket dropped; without
		// it socket.io would buffer the emit and replay on reconnect,
		// landing stale search results when the user has moved on.
		if (
			!emitIfConnected(liveSocket, 'browse:search', options, {
				source: 'browse',
				command: 'browse:search'
			})
		) {
			return;
		}
		setSearchLoading(query);
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			search();
		}
	}

	// Reset per-group pagination whenever a new query lands.
	$effect(() => {
		const q = $browseStore.lastSearchQuery;
		if (q !== lastQueryDisplayed) {
			pageSize = {};
			lastQueryDisplayed = q;
		}
	});

	// Display order for resultType groups.
	const TYPE_ORDER: ReadonlyArray<SearchResult['resultType']> = [
		'artist',
		'album',
		'track',
		'playlist',
		'composer',
		'genre',
		'label',
		'radio',
		'unknown'
	];

	const TYPE_LABELS: Record<SearchResult['resultType'], string> = {
		artist: 'Artists',
		album: 'Albums',
		track: 'Tracks',
		playlist: 'Playlists',
		composer: 'Composers',
		genre: 'Genres',
		label: 'Labels',
		radio: 'Radio',
		unknown: 'Other'
	};

	const grouped = $derived.by(() => {
		const buckets = new Map<SearchResult['resultType'], SearchResult[]>();
		for (const r of $browseStore.lastSearch ?? []) {
			const list = buckets.get(r.resultType) ?? [];
			list.push(r);
			buckets.set(r.resultType, list);
		}
		return TYPE_ORDER.filter((t) => buckets.has(t)).map((t) => ({
			type: t,
			label: TYPE_LABELS[t],
			items: buckets.get(t) ?? []
		}));
	});

	function shownCount(type: string, total: number): number {
		const current = pageSize[type] ?? PAGE_SIZE;
		return Math.min(current, total);
	}

	function showMore(type: string) {
		const current = pageSize[type] ?? PAGE_SIZE;
		pageSize = { ...pageSize, [type]: current + PAGE_SIZE };
	}

	// ItemGrid types its callback as BrowseItem (the broader type).
	// Items are SearchResult[] here, so the cast back is safe.
	//
	// Every result type — including tracks — renders through ItemGrid.
	// A search "track" result isn't an album-ordered track listing:
	// it can be playable (hint: action_list) or navigable, and the
	// caller's onResultClick decides which. A TrackList row with a
	// hardcoded "Play" button would misrepresent the navigable case.
	function handleClick(item: BrowseItem) {
		onResultClick?.(item as SearchResult);
	}
</script>

<div class="search-shell" class:input-only={mode === 'input'}>
	{#if mode !== 'results'}
		<div class="search-row">
			<label class="visually-hidden" for="library-search">Search library</label>
			<input
				id="library-search"
				type="text"
				bind:value={searchQuery}
				onkeydown={handleKeydown}
				placeholder="Search artists, albums, tracks"
				spellcheck="false"
			/>
			<button type="button" onclick={search} disabled={!searchQuery.trim()}>Search</button>
		</div>
	{/if}

	{#if mode !== 'input'}
	{#if $browseStore.searchLoading}
		<p class="loading">Searching...</p>
	{:else if $browseStore.searchError}
		<div class="error">
			<p>{$browseStore.searchError}</p>
		</div>
	{:else if $browseStore.lastSearch}
		<div class="results">
			<p class="result-count">
				{$browseStore.lastSearch.length} results
				{#if $browseStore.lastSearchQuery}
					for <strong>"{$browseStore.lastSearchQuery}"</strong>
				{/if}
			</p>
			{#each grouped as group}
				{@const visible = group.items.slice(0, shownCount(group.type, group.items.length))}
				<section class="group">
					<header class="group-header">
						<h3>{group.label}</h3>
						<span class="group-count">
							{shownCount(group.type, group.items.length)} of {group.items.length}
						</span>
					</header>
					<ItemGrid items={visible} onItemClick={handleClick} />
					{#if group.items.length > shownCount(group.type, group.items.length)}
						<button type="button" class="show-more" onclick={() => showMore(group.type)}>
							Show more {group.label.toLowerCase()}
						</button>
					{/if}
				</section>
			{/each}
		</div>
	{/if}
	{/if}
</div>

<style>
	.search-shell {
		display: flex;
		flex-direction: column;
		gap: 0.8rem;
	}

	.search-shell.input-only {
		gap: 0;
	}

	.search-row {
		display: flex;
		gap: 0.45rem;
	}

	.search-shell.input-only .search-row input {
		padding: 0.4rem 0.6rem;
		font-size: 0.9rem;
	}

	.search-shell.input-only .search-row button {
		padding: 0.4rem 0.85rem;
		font-size: 0.85rem;
	}

	.search-row input {
		flex: 1;
		padding: 0.62rem 0.72rem;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--surface-2);
	}

	.search-row button {
		padding: 0.6rem 1rem;
		border: 1px solid var(--accent);
		border-radius: 10px;
		background: linear-gradient(100deg, var(--accent), var(--accent-2));
		color: #fff;
		font-weight: 600;
	}

	.search-row button:disabled {
		opacity: 0.48;
		cursor: not-allowed;
	}

	.loading {
		font-size: 0.88rem;
		color: var(--text-soft);
	}

	.error {
		padding: 0.65rem;
		border-radius: 10px;
		background: rgba(255, 124, 124, 0.1);
		border: 1px solid rgba(255, 124, 124, 0.45);
		color: #ffb3b3;
	}

	.results {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}

	.result-count {
		font-size: 0.8rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-soft);
	}

	.result-count strong {
		color: var(--text);
		text-transform: none;
		letter-spacing: 0;
	}

	.group {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}

	.group-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.6rem;
	}

	.group-header h3 {
		font-family: var(--font-display);
		font-size: 0.92rem;
		margin: 0;
	}

	.group-count {
		font-size: 0.72rem;
		font-family: var(--font-mono);
		color: var(--text-soft);
	}

	.show-more {
		align-self: flex-start;
		padding: 0.36rem 0.7rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface-2);
		color: var(--text);
		font-size: 0.78rem;
		cursor: pointer;
	}

	.show-more:hover {
		background: var(--surface-3);
		border-color: var(--accent-2);
	}
</style>
