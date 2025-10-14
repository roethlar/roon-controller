<script lang="ts">
	import { zonesStore } from '$lib/stores/zonesStore';
	import { nowPlayingStore } from '$lib/stores/nowPlayingStore';

	let selectedZoneId = $state<string>('');

	$effect(() => {
		const zones = $zonesStore;
		if (!selectedZoneId && zones.length > 0) {
			selectedZoneId = zones[0].zone_id;
		}
	});

	const nowPlaying = $derived(selectedZoneId ? $nowPlayingStore[selectedZoneId] : undefined);
</script>

<div class="queue">
	<h1>Queue</h1>

	<div class="zone-selector">
		<label for="queue-zone">Zone:</label>
		<select id="queue-zone" bind:value={selectedZoneId}>
			{#each $zonesStore as zone}
				<option value={zone.zone_id}>{zone.display_name}</option>
			{/each}
		</select>
	</div>

	{#if nowPlaying}
		<div class="current-track">
			<h2>Now Playing</h2>
			<div class="track-item current">
				{#if nowPlaying.image_key}
					<img src="/api/image/{nowPlaying.image_key}?scale=fit&width=60&height=60" alt={nowPlaying.title} />
				{/if}
				<div class="track-text">
					<p class="track-title">{nowPlaying.title || 'Unknown'}</p>
					<p class="track-artist">{nowPlaying.artist || 'Unknown Artist'}</p>
				</div>
				<span class="playing-indicator">♪</span>
			</div>
		</div>

		<div class="queue-note">
			<p>Note: Full queue management will be added in a future update.</p>
			<p>This view currently shows only the now-playing track.</p>
		</div>
	{:else}
		<p>No track currently playing</p>
	{/if}
</div>

<style>
	.queue {
		max-width: 800px;
		margin: 0 auto;
		padding: 2rem;
	}

	.zone-selector {
		margin-bottom: 2rem;
	}

	.zone-selector select {
		width: 100%;
		padding: 0.5rem;
		font-size: 1rem;
	}

	.current-track {
		margin-bottom: 2rem;
	}

	.track-item {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 1rem;
		border: 1px solid #ddd;
		border-radius: 4px;
		background: white;
	}

	.track-item.current {
		background: #f0f8ff;
		border-color: #007bff;
	}

	.track-item img {
		width: 60px;
		height: 60px;
		object-fit: cover;
		border-radius: 4px;
	}

	.track-text {
		flex: 1;
	}

	.track-title {
		font-weight: bold;
		margin: 0;
	}

	.track-artist {
		color: #666;
		font-size: 0.9rem;
		margin: 0.25rem 0 0 0;
	}

	.playing-indicator {
		color: #007bff;
		font-size: 1.5rem;
	}

	.queue-note {
		margin-top: 2rem;
		padding: 1rem;
		background: #f8f9fa;
		border-radius: 4px;
		color: #666;
		font-size: 0.9rem;
	}

	.queue-note p {
		margin: 0.5rem 0;
	}
</style>
