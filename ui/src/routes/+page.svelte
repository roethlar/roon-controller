<script lang="ts">
	import { zonesStore, zoneMapStore } from '$lib/stores/zonesStore';
	import { nowPlayingStore } from '$lib/stores/nowPlayingStore';
	import { coreStore, isCorePaired } from '$lib/stores/coreStore';
	import { getSocket } from '$lib/socket/client';
	import type { TransportControlRequest, VolumeRequest } from '@shared/types';

	let selectedZoneId = $state<string>('');
	let socket = $state(getSocket());

	$effect(() => {
		const zones = $zonesStore;
		if (!selectedZoneId && zones.length > 0) {
			selectedZoneId = zones[0].zone_id;
		}
	});

	const selectedZone = $derived($zoneMapStore.get(selectedZoneId));
	const nowPlaying = $derived(selectedZoneId ? $nowPlayingStore[selectedZoneId] : undefined);
	const paired = $derived($isCorePaired);

	function sendCommand(event: string, payload: TransportControlRequest) {
		socket.emit(event, payload);
	}

	function playPause() {
		if (selectedZoneId) {
			sendCommand('transport:play-pause', { zone_id: selectedZoneId });
		}
	}

	function next() {
		if (selectedZoneId) {
			sendCommand('transport:next', { zone_id: selectedZoneId });
		}
	}

	function previous() {
		if (selectedZoneId) {
			sendCommand('transport:previous', { zone_id: selectedZoneId });
		}
	}

	function setVolume(outputId: string, value: number) {
		const payload: VolumeRequest = { output_id: outputId, value };
		socket.emit('transport:volume', payload);
	}
</script>

<div class="dashboard">
	<h1>Roon Controller</h1>

	{#if !paired}
		<div class="status">
			<p>Status: {$coreStore.status}</p>
			{#if $coreStore.status === 'discovering'}
				<p>Searching for Roon Core...</p>
			{:else if $coreStore.status === 'unpaired'}
				<p>Roon Core disconnected</p>
			{/if}
		</div>
	{:else}
		<div class="zone-selector">
			<label for="zone">Zone:</label>
			<select id="zone" bind:value={selectedZoneId}>
				{#each $zonesStore as zone}
					<option value={zone.zone_id}>{zone.display_name}</option>
				{/each}
			</select>
		</div>

		{#if nowPlaying}
			<div class="now-playing">
				<h2>Now Playing</h2>
				{#if nowPlaying.image_key}
					<img src="/api/image/{nowPlaying.image_key}?scale=fit&width=300&height=300" alt="Album art" />
				{/if}
				<div class="track-info">
					<p class="title">{nowPlaying.title || 'Unknown Track'}</p>
					<p class="artist">{nowPlaying.artist || 'Unknown Artist'}</p>
					<p class="album">{nowPlaying.album || ''}</p>
				</div>
			</div>
		{/if}

		<div class="controls">
			<button onclick={previous} disabled={!selectedZone?.is_previous_allowed}>Previous</button>
			<button onclick={playPause} disabled={!selectedZone?.is_play_allowed && !selectedZone?.is_pause_allowed}>
				{selectedZone?.state === 'playing' ? 'Pause' : 'Play'}
			</button>
			<button onclick={next} disabled={!selectedZone?.is_next_allowed}>Next</button>
		</div>

		{#if selectedZone?.outputs && selectedZone.outputs.length > 0}
			<div class="volume">
				<h3>Volume</h3>
				{#each selectedZone.outputs as output}
					{#if output.volume && output.volume.type === 'number'}
						<div class="volume-control">
							<label>{output.display_name}</label>
							<input
								type="range"
								min={output.volume.min}
								max={output.volume.max}
								value={output.volume.value}
								oninput={(e) => setVolume(output.output_id, Number((e.target as HTMLInputElement).value))}
							/>
							<span>{output.volume.value}</span>
						</div>
					{/if}
				{/each}
			</div>
		{/if}
	{/if}
</div>

<style>
	.dashboard {
		max-width: 800px;
		margin: 0 auto;
		padding: 2rem;
	}

	.status {
		text-align: center;
		padding: 2rem;
		background: #f5f5f5;
		border-radius: 8px;
	}

	.zone-selector {
		margin-bottom: 2rem;
	}

	.zone-selector select {
		width: 100%;
		padding: 0.5rem;
		font-size: 1rem;
	}

	.now-playing {
		text-align: center;
		margin-bottom: 2rem;
	}

	.now-playing img {
		max-width: 300px;
		border-radius: 8px;
		box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
	}

	.track-info {
		margin-top: 1rem;
	}

	.track-info .title {
		font-size: 1.5rem;
		font-weight: bold;
		margin: 0.5rem 0;
	}

	.track-info .artist {
		font-size: 1.2rem;
		color: #666;
		margin: 0.25rem 0;
	}

	.track-info .album {
		font-size: 1rem;
		color: #999;
	}

	.controls {
		display: flex;
		justify-content: center;
		gap: 1rem;
		margin: 2rem 0;
	}

	.controls button {
		padding: 0.75rem 1.5rem;
		font-size: 1rem;
		border: none;
		background: #007bff;
		color: white;
		border-radius: 4px;
		cursor: pointer;
	}

	.controls button:hover:not(:disabled) {
		background: #0056b3;
	}

	.controls button:disabled {
		background: #ccc;
		cursor: not-allowed;
	}

	.volume {
		margin-top: 2rem;
	}

	.volume-control {
		display: flex;
		align-items: center;
		gap: 1rem;
		margin: 1rem 0;
	}

	.volume-control label {
		min-width: 150px;
	}

	.volume-control input[type='range'] {
		flex: 1;
	}

	.volume-control span {
		min-width: 50px;
		text-align: right;
	}
</style>
