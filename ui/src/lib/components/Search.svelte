<script lang="ts">
	import { browseStore, setBrowseError, setBrowseLoading } from '$lib/stores/browseStore';
	import { selectedZoneStore } from '$lib/stores/selectedZoneStore';
	import { getSocket } from '$lib/socket/client';
	import type { BrowseSearchOptions, SearchResult } from '@shared/types';

	let { onResultClick }: { onResultClick?: (result: SearchResult) => void } = $props();

	let searchQuery = $state('');
	let socket = $state(getSocket());

	function search() {
		const query = searchQuery.trim();
		if (!query) {
			return;
		}

		const liveSocket = socket ?? getSocket();
		socket = liveSocket;

		if (!liveSocket) {
			setBrowseError('Realtime connection is unavailable.');
			return;
		}

		const options: BrowseSearchOptions = {
			input: query,
			zoneId: $selectedZoneStore || undefined
		};
		setBrowseLoading('search');
		liveSocket.emit('browse:search', options);
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			search();
		}
	}
</script>

<div class="search-shell">
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

	{#if $browseStore.loading && $browseStore.hierarchy === 'search'}
		<p class="loading">Searching...</p>
	{:else if $browseStore.error && $browseStore.hierarchy === 'search'}
		<div class="error">
			<p>{$browseStore.error}</p>
		</div>
	{:else if $browseStore.lastSearch}
		<div class="results">
			<p class="result-count">{$browseStore.lastSearch.length} results</p>
			{#each $browseStore.lastSearch.slice(0, 8) as result}
				<button
					type="button"
					class="result-item"
					disabled={!result.itemKey}
					onclick={() => onResultClick?.(result)}
				>
					{#if result.imageKey}
						<img src="/api/image/{result.imageKey}?scale=fit&width=120&height=120" alt={result.title} />
					{:else}
						<div class="result-fallback">{result.resultType}</div>
					{/if}
					<div class="result-meta">
						<p class="title">{result.title}</p>
						<p class="type">{result.resultType}</p>
						{#if result.subtitle}
							<p class="subtitle">{result.subtitle}</p>
						{/if}
					</div>
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.search-shell {
		display: flex;
		flex-direction: column;
		gap: 0.8rem;
	}

	.search-row {
		display: flex;
		gap: 0.45rem;
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
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
		gap: 0.6rem;
	}

	.result-count {
		grid-column: 1 / -1;
		font-size: 0.8rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-soft);
	}

	.result-item {
		display: grid;
		grid-template-columns: 52px 1fr;
		gap: 0.55rem;
		padding: 0.5rem;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--surface-2);
		text-align: left;
		color: var(--text);
		cursor: pointer;
	}

	.result-item:hover:not(:disabled) {
		border-color: var(--accent-2);
	}

	.result-item:disabled {
		opacity: 0.65;
		cursor: default;
	}

	.result-item img,
	.result-fallback {
		width: 52px;
		height: 52px;
		border-radius: 8px;
	}

	.result-item img {
		object-fit: cover;
	}

	.result-fallback {
		display: grid;
		place-items: center;
		background: var(--surface-3);
		font-size: 0.68rem;
		text-transform: uppercase;
		color: var(--text-soft);
	}

	.result-meta .title {
		font-weight: 650;
		line-height: 1.25;
	}

	.result-meta .type {
		font-size: 0.72rem;
		margin-top: 0.12rem;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--text-soft);
	}

	.result-meta .subtitle {
		margin-top: 0.2rem;
		font-size: 0.8rem;
		color: var(--text-soft);
	}
</style>
