<script lang="ts">
	import { onMount } from 'svelte';
	import { getSocket } from '$lib/socket/client';
	import { emitWithAck } from '$lib/socket/emit';
	import { selectedZoneStore, queueStore, setQueueSnapshot, pushCommandFeedback } from '$lib/stores';
	import { zoneMapStore } from '$lib/stores/zonesStore';
	import type { LoopModeRequest, QueueItem, ZoneQueue, ZonePlaybackSettingsRequest } from '@shared/types';

	let socket = $state(getSocket());
	let queueLoading = $state(false);
	let queueActionInFlight = $state(false);
	let settingsInFlight = $state(false);

	onMount(() => {
		socket = getSocket();
	});

	$effect(() => {
		if ($selectedZoneStore) {
			void subscribeQueue($selectedZoneStore);
		}
	});

	const activeZone = $derived($selectedZoneStore ? $zoneMapStore.get($selectedZoneStore) : undefined);
	const activeQueue = $derived($selectedZoneStore ? $queueStore[$selectedZoneStore] : undefined);
	const totalQueueSeconds = $derived((activeQueue?.items ?? []).reduce((sum, item) => sum + (item.length ?? 0), 0));

	function getLiveSocket() {
		const liveSocket = socket ?? getSocket();
		socket = liveSocket;
		if (!liveSocket) {
			pushCommandFeedback({
				source: 'queue',
				command: 'socket',
				message: 'Realtime connection is unavailable. Refresh and retry.'
			});
			return null;
		}
		return liveSocket;
	}

	async function subscribeQueue(zoneId: string) {
		const liveSocket = getLiveSocket();
		if (!liveSocket) {
			return;
		}

		queueLoading = true;
		try {
			const response = await emitWithAck<{ queue?: ZoneQueue }>(
				liveSocket,
				'queue:subscribe',
				{ zone_id: zoneId },
				{ feedback: { source: 'queue', command: 'queue:subscribe' } }
			);
			if (response.success && response.data?.queue) {
				setQueueSnapshot(response.data.queue);
			}
		} finally {
			queueLoading = false;
		}
	}

	async function playFromHere(queueItemId: number) {
		if (!$selectedZoneStore) {
			return;
		}

		const liveSocket = getLiveSocket();
		if (!liveSocket) {
			return;
		}

		queueActionInFlight = true;
		try {
			await emitWithAck(
				liveSocket,
				'queue:play-from-here',
				{ zone_id: $selectedZoneStore, queue_item_id: queueItemId },
				{ feedback: { source: 'queue', command: 'queue:play-from-here' } }
			);
		} finally {
			queueActionInFlight = false;
		}
	}

	async function updateSettings(patch: Omit<ZonePlaybackSettingsRequest, 'zone_id'>) {
		if (!$selectedZoneStore) {
			return;
		}

		const liveSocket = getLiveSocket();
		if (!liveSocket) {
			return;
		}

		settingsInFlight = true;
		try {
			await emitWithAck(
				liveSocket,
				'transport:settings',
				{ zone_id: $selectedZoneStore, ...patch },
				{ feedback: { source: 'transport', command: 'transport:settings' } }
			);
		} finally {
			settingsInFlight = false;
		}
	}

	function cycleLoop(current?: string): LoopModeRequest {
		if (current === 'disabled') {
			return 'loop';
		}
		if (current === 'loop') {
			return 'loop_one';
		}
		return 'disabled';
	}

	function itemTitle(item: QueueItem): string {
		return item.three_line?.line1 || item.two_line?.line1 || item.one_line?.line1 || `Queue item ${item.queue_item_id}`;
	}

	function itemSubtitle(item: QueueItem): string {
		return item.three_line?.line2 || item.two_line?.line2 || '';
	}

	function itemTertiary(item: QueueItem): string {
		return item.three_line?.line3 || '';
	}

	function itemDuration(seconds?: number): string {
		if (!seconds || Number.isNaN(seconds) || seconds < 0) {
			return '--:--';
		}
		const whole = Math.floor(seconds);
		const mins = Math.floor(whole / 60);
		const secs = whole % 60;
		return `${mins}:${String(secs).padStart(2, '0')}`;
	}

	function totalDurationLabel(): string {
		const seconds = totalQueueSeconds;
		if (!seconds) {
			return '--';
		}

		const hrs = Math.floor(seconds / 3600);
		const mins = Math.floor((seconds % 3600) / 60);
		if (hrs > 0) {
			return `${hrs}h ${mins}m`;
		}
		return `${mins}m`;
	}

	function isCurrentRow(index: number): boolean {
		// Roon's queue subscription delivers items starting at the currently
		// playing track (verified by capture against a live Core, May 2026).
		// When a track is consumed, Roon issues a `remove` op at index 0 so
		// the new index 0 is the new current track. Using the row index is
		// reliable; the substring-match heuristic this replaces would
		// mis-highlight whenever titles repeated.
		return index === 0;
	}
</script>

<div class="queue-layout">
	<section class="queue-panel card">
		<div class="queue-header">
			<div>
				<h2>Queue</h2>
				<p class="meta">{activeZone?.display_name || 'No active zone'} · {totalDurationLabel()} total</p>
			</div>
			<div class="queue-controls">
				<button
					type="button"
					disabled={settingsInFlight || !activeZone}
					onclick={() => {
						void updateSettings({ shuffle: !activeZone?.settings?.shuffle });
					}}
					class:active={Boolean(activeZone?.settings?.shuffle)}
				>
					Shuffle
				</button>
				<button
					type="button"
					disabled={settingsInFlight || !activeZone}
					onclick={() => {
						void updateSettings({ auto_radio: !activeZone?.settings?.auto_radio });
					}}
					class:active={Boolean(activeZone?.settings?.auto_radio)}
				>
					Auto Radio
				</button>
				<button
					type="button"
					disabled={settingsInFlight || !activeZone}
					onclick={() => {
						void updateSettings({ loop: cycleLoop(activeZone?.settings?.loop) });
					}}
				>
					Loop: {activeZone?.settings?.loop || 'disabled'}
				</button>
			</div>
		</div>

		{#if queueLoading}
			<p class="placeholder-copy">Loading queue...</p>
		{:else if !activeQueue || activeQueue.items.length === 0}
			<p class="placeholder-copy">Queue is empty for this zone.</p>
		{:else}
			<div class="queue-list">
				{#each activeQueue.items as item, index}
					<article class="queue-item" class:current={isCurrentRow(index)}>
						<div class="item-art">
							{#if item.image_key}
								<img src="/api/image/{item.image_key}?scale=fit&width=120&height=120" alt={itemTitle(item)} />
							{:else}
								<div class="fallback">#{item.queue_item_id}</div>
							{/if}
						</div>
						<div class="item-body">
							<p class="title">{itemTitle(item)}</p>
							{#if itemSubtitle(item)}
								<p class="subtitle">{itemSubtitle(item)}</p>
							{/if}
							{#if itemTertiary(item)}
								<p class="tertiary">{itemTertiary(item)}</p>
							{/if}
						</div>
						<div class="item-actions">
							<span>{itemDuration(item.length)}</span>
							<button
								type="button"
								onclick={() => {
									void playFromHere(item.queue_item_id);
								}}
								disabled={queueActionInFlight}
							>
								Play Here
							</button>
						</div>
					</article>
				{/each}
			</div>
		{/if}
	</section>

	<section class="up-next card">
		<h2>Queue Controls</h2>
		<ul>
			<li>Live queue subscription per active zone</li>
			<li>Dynamic high-cap queue sizing for long/full queues</li>
			<li>Play-from-here for any queue item</li>
			<li>Shuffle / Loop / Auto Radio controls</li>
			<li>Zone-scoped queue updates across app</li>
		</ul>
		<p>
			Note: The public Roon Transport API does not expose direct remove/reorder endpoints; this UI implements all currently available queue controls.
		</p>
	</section>
</div>

<style>
	.queue-layout {
		display: grid;
		grid-template-columns: 1.2fr 0.8fr;
		gap: 0.85rem;
	}

	.queue-panel,
	.up-next {
		padding: 0.85rem;
		background: var(--surface);
	}

	.queue-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 0.75rem;
		margin-bottom: 0.8rem;
	}

	.queue-header h2,
	.up-next h2 {
		font-family: var(--font-display);
		font-size: 1.05rem;
	}

	.meta {
		margin-top: 0.2rem;
		font-size: 0.82rem;
		color: var(--text-soft);
	}

	.queue-controls {
		display: flex;
		gap: 0.42rem;
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	.queue-controls button {
		padding: 0.42rem 0.6rem;
		border: 1px solid var(--border);
		border-radius: 9px;
		background: var(--surface-2);
		font-size: 0.8rem;
	}

	.queue-controls button.active {
		border-color: var(--accent-2);
		background: rgba(95, 109, 240, 0.2);
	}

	.queue-controls button:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.placeholder-copy,
	.up-next p,
	.up-next li {
		color: var(--text-soft);
	}

	.queue-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.queue-item {
		display: grid;
		grid-template-columns: 58px 1fr auto;
		gap: 0.62rem;
		padding: 0.5rem;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--surface-2);
	}

	.queue-item.current {
		border-color: var(--accent-2);
		background: rgba(95, 109, 240, 0.15);
	}

	.item-art {
		width: 58px;
		height: 58px;
		border-radius: 8px;
		overflow: hidden;
		background: var(--surface-3);
	}

	.item-art img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.fallback {
		display: grid;
		place-items: center;
		height: 100%;
		font-size: 0.72rem;
		color: var(--text-soft);
	}

	.item-body {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 0.1rem;
	}

	.item-body .title {
		font-weight: 640;
		line-height: 1.25;
	}

	.item-body .subtitle,
	.item-body .tertiary {
		font-size: 0.79rem;
		line-height: 1.28;
		color: var(--text-soft);
	}

	.item-actions {
		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: flex-end;
		gap: 0.28rem;
	}

	.item-actions span {
		font-family: var(--font-mono);
		font-size: 0.76rem;
		color: var(--text-soft);
	}

	.item-actions button {
		padding: 0.35rem 0.58rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface-3);
		font-size: 0.76rem;
	}

	.item-actions button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.up-next {
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
	}

	.up-next ul {
		margin: 0;
		padding-left: 1.08rem;
		display: flex;
		flex-direction: column;
		gap: 0.38rem;
	}

	@media (max-width: 980px) {
		.queue-layout {
			grid-template-columns: 1fr;
		}
	}

	@media (max-width: 700px) {
		.queue-header {
			flex-direction: column;
		}

		.queue-controls {
			justify-content: flex-start;
		}

		.queue-item {
			grid-template-columns: 1fr;
		}

		.item-actions {
			align-items: flex-start;
			flex-direction: row;
			justify-content: flex-start;
		}
	}
</style>
