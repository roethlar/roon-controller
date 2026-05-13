<script lang="ts">
	import { trackNum, trackTitle } from '$lib/trackTitle';
	import type { BrowseItem } from '@shared/types';

	let {
		items,
		onItemClick,
		onMoreClick,
		isNowPlaying,
		playDisabled = false
	}: {
		items: BrowseItem[];
		onItemClick: (item: BrowseItem) => void;
		/** When provided, renders a ⋮ button per row that calls this with the item. */
		onMoreClick?: (item: BrowseItem) => void;
		/** When true for a row, that row is highlighted as the currently-playing track. */
		isNowPlaying?: (item: BrowseItem) => boolean;
		/** Outer guard (e.g. quickPlay-in-flight) that disables all play buttons. */
		playDisabled?: boolean;
	} = $props();
</script>

<ol class="track-list">
	{#each items as item, index (item.itemKey ?? index)}
		{@const playing = isNowPlaying?.(item) ?? false}
		{@const displayTitle = trackTitle(item.title)}
		<li class="track-row" class:playing>
			<span class="track-num">
				{#if playing}
					<span class="track-now-playing" aria-label="Currently playing">♫</span>
				{:else}
					{trackNum(item.title, index)}
				{/if}
			</span>
			<div class="track-info">
				<span class="track-title">{displayTitle}</span>
				{#if item.subtitle}
					<span class="track-sub">{item.subtitle}</span>
				{/if}
			</div>
			<div class="track-actions">
				<button
					type="button"
					class="track-play"
					onclick={() => onItemClick(item)}
					disabled={!item.itemKey || playDisabled}
					aria-label="Play {displayTitle}"
					title="Play now"
				>▶</button>
				{#if item.itemKey && onMoreClick}
					<button
						type="button"
						class="track-more"
						title="More options"
						onclick={() => onMoreClick(item)}
					>⋮</button>
				{/if}
			</div>
		</li>
	{/each}
</ol>

<style>
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

	.track-row.playing {
		background: linear-gradient(
			90deg,
			color-mix(in srgb, var(--accent) 22%, transparent),
			transparent 80%
		);
	}

	.track-row.playing .track-title {
		color: var(--accent);
		font-weight: 700;
	}

	.track-now-playing {
		display: inline-block;
		font-size: 0.95rem;
		color: var(--accent);
		animation: pulse 1.6s ease-in-out infinite;
	}

	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.55; }
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

	/* Touch / narrow viewports: always show actions. Hover-reveal on
	   desktop, persistent here since there's no hover signal. */
	@media (max-width: 820px) {
		.track-actions {
			opacity: 1;
		}
	}
</style>
