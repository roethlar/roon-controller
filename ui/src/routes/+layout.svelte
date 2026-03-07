<script lang="ts">
	import '../app.css';
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
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
		browseNavStore
	} from '$lib/stores';
	import { goto } from '$app/navigation';
	import { zonesStore, zoneMapStore } from '$lib/stores/zonesStore';
	import { registerSocketHandlers } from '$lib/socket/register';
	import { getSocket } from '$lib/socket/client';
	import ErrorToast from '$lib/components/ErrorToast.svelte';
	import type { TransportControlRequest } from '@shared/types';

	let { children } = $props();

	let socket = $state(getSocket());
	let commandInFlight = $state(false);

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

	$effect(() => {
		const zones = $zonesStore;
		const selected = $selectedZoneStore;
		if (zones.length === 0) {
			if (selected) setSelectedZone('');
			return;
		}
		if (!selected || !zones.some((z) => z.zone_id === selected)) {
			setSelectedZone(zones[0].zone_id);
		}
	});

	const navItems = [
		{ path: '/library', label: 'Browse' },
		{ path: '/queue', label: 'Queue' }
	];

	const connectedLabel = $derived($isCorePaired ? 'Connected' : 'Offline');
	const activeZone = $derived($selectedZoneStore ? $zoneMapStore.get($selectedZoneStore) : undefined);
	const nowPlaying = $derived(
		$selectedZoneStore ? $nowPlayingList.find((t) => t.zone_id === $selectedZoneStore) : undefined
	);

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
			await new Promise<void>((resolve) => {
				let done = false;
				const timer = setTimeout(() => { if (!done) { done = true; resolve(); } }, 3000);
				s.emit(event, payload, () => { if (!done) { done = true; clearTimeout(timer); resolve(); } });
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

	const isPlaying = $derived(activeZone?.state === 'playing');
	const canPlay = $derived(!!(activeZone?.is_play_allowed || activeZone?.is_pause_allowed));
	const canPrev = $derived(!!activeZone?.is_previous_allowed);
	const canNext = $derived(!!activeZone?.is_next_allowed);

	function searchInLibrary(query: string) {
		pendingSearchStore.set(query);
		goto('/library');
	}
</script>

<div class="shell">
	<aside class="sidebar">
		<div class="brand-block">
			<p class="eyebrow">Roon Controller</p>
		</div>

		<div class="status card">
			<p class="status-value" class:good={$isCorePaired}>{connectedLabel}</p>
			<p class="status-core">{$coreStore.core?.displayName ?? 'Searching…'}</p>
			<p class="status-version">{$coreStore.core?.displayVersion ?? ''}</p>
		</div>

		<nav class="nav card" aria-label="Primary">
			{#each navItems as item}
				<a
					href={item.path}
					class="nav-link"
					class:active={$page.url.pathname === item.path}
					data-sveltekit-preload-data="hover"
				>{item.label}</a>
			{/each}
		</nav>
	</aside>

	<section class="workspace">
		<header class="workspace-header">
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
				<span></span>
			{/if}
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
	<div class="pb-track">
		<div class="pb-art">
			{#if nowPlaying?.image_key}
				<img src="/api/image/{nowPlaying.image_key}?scale=fit&width=80&height=80" alt="Artwork" />
			{/if}
		</div>
		<div class="pb-meta">
			{#if nowPlaying?.title}
				<button type="button" class="pb-title pb-link" onclick={() => nowPlaying?.album && searchInLibrary(nowPlaying.album)}>{nowPlaying.title}</button>
			{:else}
				<p class="pb-title">Nothing playing</p>
			{/if}
			{#if nowPlaying?.artist}
				<button type="button" class="pb-sub pb-link" onclick={() => searchInLibrary(nowPlaying!.artist!)}>{nowPlaying.artist}</button>
			{:else}
				<p class="pb-sub"></p>
			{/if}
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
		<label class="visually-hidden" for="footer-zone">Zone</label>
		<select
			id="footer-zone"
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
		<a href="/queue" class="queue-btn" data-sveltekit-preload-data="hover">Queue</a>
	</div>
</footer>

<ErrorToast />

<style>
	.shell {
		display: grid;
		grid-template-columns: 240px 1fr;
		min-height: calc(100vh - 76px);
	}

	/* ── Sidebar ── */
	.sidebar {
		background: var(--sidebar-bg);
		color: var(--sidebar-text);
		padding: 1rem 0.85rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		border-right: 1px solid var(--sidebar-border);
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

	.status,
	.nav {
		background: var(--sidebar-card-bg);
		border-color: var(--sidebar-card-border);
		color: var(--sidebar-text);
	}

	.status {
		padding: 0.75rem;
	}

	.status-value {
		font-weight: 700;
		font-size: 0.88rem;
	}

	.status-value.good {
		color: #89f0b4;
	}

	.status-core {
		margin-top: 0.3rem;
		font-weight: 600;
		font-size: 0.9rem;
	}

	.status-version {
		font-size: 0.78rem;
		opacity: 0.68;
		margin-top: 0.1rem;
	}

	.nav {
		padding: 0.4rem;
		display: flex;
		flex-direction: column;
		gap: 0.28rem;
	}

	.nav-link {
		display: block;
		padding: 0.58rem 0.65rem;
		border-radius: 9px;
		color: var(--sidebar-text);
		font-size: 0.9rem;
	}

	.nav-link:hover {
		background: var(--sidebar-hover-bg);
	}

	.nav-link.active {
		background: var(--sidebar-active-bg);
		border: 1px solid var(--sidebar-active-border);
	}

	/* ── Workspace ── */
	.workspace {
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	.workspace-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.55rem 0.9rem;
		border-bottom: 1px solid var(--border);
	}

	.nav-btns {
		display: flex;
		gap: 0.2rem;
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
		padding: 0.9rem;
		animation: rise-in 320ms ease;
	}

	/* ── Play bar (persistent footer) ── */
	.play-bar {
		position: sticky;
		bottom: 0;
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
		align-items: center;
		gap: 0.6rem;
		padding: 0.5rem 1rem;
		background: var(--mini-player-bg);
		border-color: var(--mini-player-border);
		color: var(--mini-player-text);
		margin: 0.4rem;
		border-radius: 14px;
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

	.pb-right select {
		padding: 0.38rem 0.5rem;
		border-radius: 9px;
		border: 1px solid rgba(255, 255, 255, 0.18);
		background: rgba(255, 255, 255, 0.1);
		color: inherit;
		font-size: 0.85rem;
		max-width: 160px;
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

	.queue-btn:hover {
		background: rgba(255, 255, 255, 0.18);
	}

	/* ── Responsive ── */
	@media (max-width: 1020px) {
		.shell {
			grid-template-columns: 1fr;
		}

		.sidebar {
			padding-bottom: 0.6rem;
		}

		.nav {
			flex-direction: row;
		}

		.nav-link {
			flex: 1;
			text-align: center;
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

		.pb-right select {
			flex: 1;
			max-width: none;
		}
	}
</style>
