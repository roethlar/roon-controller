<script lang="ts">
	import { browseStore, setBrowseLoading } from '$lib/stores/browseStore';
	import { getSocket } from '$lib/socket/client';
	import type { BrowseSearchOptions } from '@shared/types';

	let searchQuery = $state('');
	let socket = $state(getSocket());

	function search() {
		if (!searchQuery.trim()) return;

		const options: BrowseSearchOptions = {
			input: searchQuery
		};
		setBrowseLoading('search');
		socket.emit('browse:search', options);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			search();
		}
	}
</script>

<div class="search-overlay">
	<div class="search-box">
		<input
			type="text"
			bind:value={searchQuery}
			onkeydown={handleKeydown}
			placeholder="Search library..."
			autofocus
		/>
		<button onclick={search} disabled={!searchQuery.trim()}>Search</button>
	</div>

	{#if $browseStore.loading}
		<p class="loading">Searching...</p>
	{:else if $browseStore.error}
		<div class="error">
			<p>{$browseStore.error}</p>
		</div>
	{:else if $browseStore.lastSearch}
		<div class="results">
			<h3>{$browseStore.lastSearch.length} results</h3>
			{#each $browseStore.lastSearch as result}
				<div class="result-item">
					{#if result.imageKey}
						<img src="/api/image/{result.imageKey}?scale=fit&width=60&height=60" alt={result.title} />
					{/if}
					<div class="result-text">
						<p class="result-title">{result.title}</p>
						<p class="result-type">{result.resultType}</p>
						{#if result.subtitle}
							<p class="result-subtitle">{result.subtitle}</p>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.search-overlay {
		max-width: 700px;
		margin: 0 auto;
		padding: 2rem;
	}

	.search-box {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 2rem;
	}

	.search-box input {
		flex: 1;
		padding: 0.75rem;
		font-size: 1rem;
		border: 1px solid #ddd;
		border-radius: 4px;
	}

	.search-box button {
		padding: 0.75rem 1.5rem;
		background: #007bff;
		color: white;
		border: none;
		border-radius: 4px;
		cursor: pointer;
	}

	.search-box button:disabled {
		background: #ccc;
		cursor: not-allowed;
	}

	.loading {
		text-align: center;
		color: #666;
	}

	.error {
		padding: 1rem;
		background: #fee;
		border: 1px solid #fcc;
		border-radius: 4px;
		color: #c00;
	}

	.results {
		margin-top: 1rem;
	}

	.result-item {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0.75rem;
		border: 1px solid #ddd;
		border-radius: 4px;
		margin-bottom: 0.5rem;
		background: white;
		cursor: pointer;
	}

	.result-item:hover {
		background: #f8f9fa;
		border-color: #007bff;
	}

	.result-item img {
		width: 60px;
		height: 60px;
		object-fit: cover;
		border-radius: 4px;
	}

	.result-text {
		flex: 1;
	}

	.result-title {
		font-weight: bold;
		margin: 0;
	}

	.result-type {
		color: #007bff;
		font-size: 0.85rem;
		margin: 0.25rem 0;
		text-transform: capitalize;
	}

	.result-subtitle {
		color: #666;
		font-size: 0.9rem;
		margin: 0.25rem 0 0 0;
	}
</style>
