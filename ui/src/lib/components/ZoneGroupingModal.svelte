<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { get } from 'svelte/store';
	import { zoneGroupingStore, closeZoneGrouping } from '$lib/stores/zoneGroupingStore';
	import { zonesStore } from '$lib/stores/zonesStore';
	import { selectedZoneStore } from '$lib/stores/selectedZoneStore';
	import { pushCommandFeedback } from '$lib/stores/commandFeedbackStore';
	import { getSocket } from '$lib/socket/client';
	import { emitWithAck } from '$lib/socket/emit';

	/**
	 * Flattens all zones to a single { output_id, display_name,
	 * zone_id, zone_name } list so the user picks across zones.
	 * Each unique output appears once. The active zone's first
	 * output is pre-checked so saving without changes is a no-op
	 * (the user is implicitly grouping "the current zone" with
	 * whatever else they tick).
	 */
	const allOutputs = $derived.by(() => {
		const seen = new Set<string>();
		const items: Array<{
			output_id: string;
			display_name: string;
			zone_id: string;
			zone_name: string;
		}> = [];
		for (const zone of $zonesStore) {
			for (const out of zone.outputs ?? []) {
				if (!out.output_id || seen.has(out.output_id)) continue;
				seen.add(out.output_id);
				items.push({
					output_id: out.output_id,
					display_name: out.display_name,
					zone_id: zone.zone_id,
					zone_name: zone.display_name
				});
			}
		}
		return items;
	});

	const activeZone = $derived(
		$selectedZoneStore ? $zonesStore.find((z) => z.zone_id === $selectedZoneStore) : undefined
	);

	let selectedOutputs = $state<Set<string>>(new Set());
	let submitting = $state(false);

	// Reset selection every time the modal opens. Pre-check the
	// active zone's outputs so the user starts from a sensible base.
	$effect(() => {
		if (!$zoneGroupingStore) return;
		const next = new Set<string>();
		for (const out of activeZone?.outputs ?? []) {
			if (out.output_id) next.add(out.output_id);
		}
		selectedOutputs = next;
	});

	function toggleOutput(output_id: string): void {
		const next = new Set(selectedOutputs);
		if (next.has(output_id)) {
			next.delete(output_id);
		} else {
			next.add(output_id);
		}
		selectedOutputs = next;
	}

	async function save(): Promise<void> {
		if (selectedOutputs.size < 2 || submitting) return;
		const socket = getSocket();
		if (!socket) {
			pushCommandFeedback({
				source: 'transport',
				command: 'transport:group',
				message: 'Realtime connection unavailable.'
			});
			return;
		}
		submitting = true;
		try {
			await emitWithAck(
				socket,
				'transport:group',
				{ output_ids: Array.from(selectedOutputs) },
				{
					timeoutMs: 5000,
					feedback: { source: 'transport', command: 'transport:group' }
				}
			);
			closeZoneGrouping();
		} finally {
			submitting = false;
		}
	}

	function onBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) closeZoneGrouping();
	}

	// Esc closes; Tab cycling stays inside the dialog (same pattern
	// as NowPlayingOverlay).
	let dialogEl: HTMLDivElement | null = $state(null);
	let previouslyFocused: HTMLElement | null = null;

	onMount(() => {
		const handler = (e: KeyboardEvent) => {
			if (!get(zoneGroupingStore)) return;
			if (e.key === 'Escape') {
				closeZoneGrouping();
			} else if (e.key === 'Tab' && dialogEl) {
				const focusables = Array.from(
					dialogEl.querySelectorAll<HTMLElement>(
						'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
					)
				);
				if (focusables.length === 0) {
					e.preventDefault();
					dialogEl.focus();
					return;
				}
				const first = focusables[0];
				const last = focusables[focusables.length - 1];
				const active = document.activeElement as HTMLElement | null;
				if (e.shiftKey && active === first) {
					e.preventDefault();
					last.focus();
				} else if (!e.shiftKey && active === last) {
					e.preventDefault();
					first.focus();
				}
			}
		};
		window.addEventListener('keydown', handler);
		return () => window.removeEventListener('keydown', handler);
	});

	$effect(() => {
		const open = $zoneGroupingStore;
		if (open) {
			previouslyFocused = document.activeElement as HTMLElement | null;
			void tick().then(() => {
				if (!dialogEl) return;
				const close = dialogEl.querySelector<HTMLElement>('.zg-close');
				(close ?? dialogEl).focus();
			});
		} else if (previouslyFocused && document.body.contains(previouslyFocused)) {
			previouslyFocused.focus();
			previouslyFocused = null;
		}
	});
</script>

{#if $zoneGroupingStore}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="zg-backdrop"
		role="dialog"
		aria-modal="true"
		aria-label="Group zones"
		tabindex="-1"
		bind:this={dialogEl}
		onclick={onBackdropClick}
	>
		<div class="zg-dialog">
			<header class="zg-header">
				<h2>Group zones</h2>
				<button
					type="button"
					class="zg-close"
					onclick={closeZoneGrouping}
					aria-label="Close group zones"
				>✕</button>
			</header>

			<p class="zg-hint">
				Pick the outputs to group into one synchronized zone.
				Roon preserves the first output's queue.
			</p>

			<ul class="zg-list" aria-label="Available outputs">
				{#each allOutputs as out}
					<li>
						<label class="zg-row">
							<input
								type="checkbox"
								checked={selectedOutputs.has(out.output_id)}
								onchange={() => toggleOutput(out.output_id)}
							/>
							<span class="zg-name">{out.display_name}</span>
							<span class="zg-zone">{out.zone_name}</span>
						</label>
					</li>
				{/each}
				{#if allOutputs.length === 0}
					<li class="zg-empty">No outputs available.</li>
				{/if}
			</ul>

			<footer class="zg-footer">
				<button
					type="button"
					class="zg-btn zg-btn-secondary"
					onclick={closeZoneGrouping}
				>Cancel</button>
				<button
					type="button"
					class="zg-btn zg-btn-primary"
					onclick={save}
					disabled={selectedOutputs.size < 2 || submitting}
					aria-label="Group selected outputs"
				>{submitting ? 'Grouping…' : 'Group'}</button>
			</footer>
		</div>
	</div>
{/if}

<style>
	.zg-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.7);
		display: grid;
		place-items: center;
		z-index: 1000;
		padding: 1rem;
	}

	.zg-dialog {
		background: var(--card-bg, #1a1a1a);
		color: var(--text, #fff);
		border-radius: 12px;
		max-width: 480px;
		width: 100%;
		padding: 1.25rem;
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.zg-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.zg-header h2 {
		margin: 0;
		font-size: 1.1rem;
	}

	.zg-close {
		background: transparent;
		border: 0;
		color: inherit;
		font-size: 1.1rem;
		cursor: pointer;
		padding: 0.25rem 0.5rem;
		border-radius: 6px;
	}
	.zg-close:hover {
		background: rgba(255, 255, 255, 0.08);
	}

	.zg-hint {
		margin: 0;
		color: rgba(255, 255, 255, 0.7);
		font-size: 0.85rem;
	}

	.zg-list {
		list-style: none;
		margin: 0;
		padding: 0;
		max-height: 50vh;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.zg-row {
		display: grid;
		grid-template-columns: auto 1fr auto;
		gap: 0.6rem;
		align-items: center;
		padding: 0.55rem 0.6rem;
		border-radius: 8px;
		cursor: pointer;
		background: rgba(255, 255, 255, 0.04);
	}
	.zg-row:hover {
		background: rgba(255, 255, 255, 0.08);
	}

	.zg-name {
		font-weight: 600;
	}

	.zg-zone {
		font-size: 0.8rem;
		color: rgba(255, 255, 255, 0.55);
	}

	.zg-empty {
		padding: 1rem;
		text-align: center;
		color: rgba(255, 255, 255, 0.55);
	}

	.zg-footer {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}

	.zg-btn {
		padding: 0.5rem 1rem;
		border-radius: 8px;
		border: 0;
		cursor: pointer;
		font-weight: 600;
	}
	.zg-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.zg-btn-secondary {
		background: rgba(255, 255, 255, 0.08);
		color: inherit;
	}
	.zg-btn-primary {
		background: var(--accent, #6cf);
		color: #000;
	}
</style>
