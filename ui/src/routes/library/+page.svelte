<script lang="ts">
	import { browseStore, setBrowseLoading } from '$lib/stores/browseStore';
	import { getSocket } from '$lib/socket/client';
	import type { BrowseOptions, BrowseLoadOptions, BrowsePopOptions } from '@shared/types';

	let socket = $state(getSocket());

	$effect(() => {
		// Load library root on mount
		setBrowseLoading('browse');
		browse({ hierarchy: 'browse' });
	});

	function browse(options: BrowseOptions) {
		setBrowseLoading(options.hierarchy ?? 'browse');
		socket.emit('browse:browse', options);
	}

	function load(itemKey: string) {
		const options: BrowseLoadOptions = {
			hierarchy: $browseStore.hierarchy,
			itemKey
		};
		setBrowseLoading(options.hierarchy);
		socket.emit('browse:load', options);
	}

	function pop() {
		const options: BrowsePopOptions = {
			hierarchy: $browseStore.hierarchy
		};
		setBrowseLoading(options.hierarchy);
		socket.emit('browse:pop', options);
	}

	function handleItemClick(item: any) {
		if (item.itemKey && item.isLoadable) {
			load(item.itemKey);
		}
	}
</script>

<div class="library">
	<h1>Library</h1>

	{#if $browseStore.loading}
		<p>Loading...</p>
	{:else if $browseStore.error}
		<div class="error">
			<p>Error: {$browseStore.error}</p>
		</div>
	{:else if $browseStore.current}
		<div class="browse-header">
			<button onclick={pop} disabled={$browseStore.current.level <= 1}>← Back</button>
			<h2>{$browseStore.current.title || 'Browse'}</h2>
		</div>

		<div class="breadcrumb">
			Level: {$browseStore.current.level} | Items: {$browseStore.current.count}
			{#if $browseStore.current.totalCount}
				of {$browseStore.current.totalCount}
			{/if}
		</div>

		<div class="items">
			{#each $browseStore.current.items as item}
				<div
					class="item"
					class:clickable={item.isLoadable}
					onclick={() => handleItemClick(item)}
					role="button"
					tabindex="0"
				>
					{#if item.imageKey}
						<img src="/api/image/{item.imageKey}?scale=fit&width=80&height=80" alt={item.title} />
					{/if}
					<div class="item-text">
						<p class="item-title">{item.title}</p>
						{#if item.subtitle}
							<p class="item-subtitle">{item.subtitle}</p>
						{/if}
					</div>
					{#if item.isLoadable}
						<span class="arrow">→</span>
					{/if}
				</div>
			{/each}
		</div>
	{:else}
		<p>No content loaded</p>
	{/if}
</div>

<style>
	.library {
		max-width: 900px;
		margin: 0 auto;
		padding: 2rem;
	}

	.error {
		padding: 1rem;
		background: #fee;
		border: 1px solid #fcc;
		border-radius: 4px;
		color: #c00;
	}

	.browse-header {
		display: flex;
		align-items: center;
		gap: 1rem;
		margin-bottom: 1rem;
	}

	.browse-header button {
		padding: 0.5rem 1rem;
		background: #007bff;
		color: white;
		border: none;
		border-radius: 4px;
		cursor: pointer;
	}

	.browse-header button:disabled {
		background: #ccc;
		cursor: not-allowed;
	}

	.breadcrumb {
		color: #666;
		margin-bottom: 1.5rem;
		font-size: 0.9rem;
	}

	.items {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.item {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0.75rem;
		border: 1px solid #ddd;
		border-radius: 4px;
		background: white;
	}

	.item.clickable {
		cursor: pointer;
	}

	.item.clickable:hover {
		background: #f8f9fa;
		border-color: #007bff;
	}

	.item img {
		width: 60px;
		height: 60px;
		object-fit: cover;
		border-radius: 4px;
	}

	.item-text {
		flex: 1;
	}

	.item-title {
		font-weight: bold;
		margin: 0;
	}

	.item-subtitle {
		color: #666;
		font-size: 0.9rem;
		margin: 0.25rem 0 0 0;
	}

	.arrow {
		color: #007bff;
		font-size: 1.5rem;
	}
</style>
