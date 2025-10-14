<script lang="ts">
	import '../app.css';
	import { coreStore, isCorePaired } from '$lib/stores/coreStore';
	import { initializeStores } from '$lib/stores';
	import { onMount } from 'svelte';

	let { children } = $props();
	let currentPath = $state('/');

	onMount(() => {
		currentPath = window.location.pathname;
		initializeStores(fetch);
	});

	const navItems = [
		{ path: '/', label: 'Dashboard' },
		{ path: '/library', label: 'Library' },
		{ path: '/queue', label: 'Queue' }
	];
</script>

<div class="app-shell">
	<header>
		<nav>
			<div class="nav-brand">
				<h1>Roon Controller</h1>
			</div>
			<div class="nav-links">
				{#each navItems as item}
					<a href={item.path} class:active={currentPath === item.path}>
						{item.label}
					</a>
				{/each}
			</div>
			<div class="nav-status">
				<span class="status-indicator" class:connected={$isCorePaired}>
					{$isCorePaired ? '● Connected' : '○ Disconnected'}
				</span>
			</div>
		</nav>
	</header>

	<main>
		{@render children()}
	</main>
</div>

<style>
	.app-shell {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
	}

	header {
		background: #2c3e50;
		color: white;
		padding: 0;
		box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
	}

	nav {
		max-width: 1200px;
		margin: 0 auto;
		display: flex;
		align-items: center;
		padding: 1rem 2rem;
		gap: 2rem;
	}

	.nav-brand h1 {
		font-size: 1.5rem;
		margin: 0;
	}

	.nav-links {
		display: flex;
		gap: 1.5rem;
		flex: 1;
	}

	.nav-links a {
		color: white;
		text-decoration: none;
		padding: 0.5rem 1rem;
		border-radius: 4px;
		transition: background 0.2s;
	}

	.nav-links a:hover {
		background: rgba(255, 255, 255, 0.1);
	}

	.nav-links a.active {
		background: rgba(255, 255, 255, 0.2);
		font-weight: bold;
	}

	.nav-status {
		font-size: 0.9rem;
	}

	.status-indicator {
		padding: 0.5rem 1rem;
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.1);
	}

	.status-indicator.connected {
		color: #4caf50;
	}

	main {
		flex: 1;
		padding: 0;
	}
</style>
