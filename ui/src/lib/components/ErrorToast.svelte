<script lang="ts">
	import { commandFeedbackStore, clearCommandFeedback } from '$lib/stores/commandFeedbackStore';
	import { onMount } from 'svelte';

	let timeoutId: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		const feedback = $commandFeedbackStore;

		if (feedback) {
			// Auto-clear after 5 seconds
			if (timeoutId) clearTimeout(timeoutId);
			timeoutId = setTimeout(() => {
				clearCommandFeedback();
			}, 5000);
		}

		return () => {
			if (timeoutId) clearTimeout(timeoutId);
		};
	});

	function dismiss() {
		clearCommandFeedback();
	}
</script>

{#if $commandFeedbackStore}
	<div class="toast error-toast">
		<div class="toast-content">
			<div class="toast-header">
				<span class="toast-icon">⚠️</span>
				<strong>
					{$commandFeedbackStore.source === 'transport' ? 'Playback' :
					 $commandFeedbackStore.source === 'queue' ? 'Queue' : 'Browse'} Error
				</strong>
			</div>
			<p class="toast-message">{$commandFeedbackStore.message}</p>
			<p class="toast-command">Command: {$commandFeedbackStore.command}</p>
		</div>
		<button class="toast-dismiss" onclick={dismiss}>✕</button>
	</div>
{/if}

<style>
	.toast {
		position: fixed;
		bottom: 2rem;
		right: 2rem;
		max-width: 400px;
		background: white;
		border-radius: 8px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
		padding: 1rem;
		display: flex;
		gap: 1rem;
		animation: slideIn 0.3s ease-out;
		z-index: 1000;
	}

	@keyframes slideIn {
		from {
			transform: translateY(100%);
			opacity: 0;
		}
		to {
			transform: translateY(0);
			opacity: 1;
		}
	}

	.error-toast {
		border-left: 4px solid #dc3545;
	}

	.toast-content {
		flex: 1;
	}

	.toast-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
	}

	.toast-icon {
		font-size: 1.2rem;
	}

	.toast-header strong {
		color: #dc3545;
	}

	.toast-message {
		margin: 0.5rem 0;
		color: #333;
	}

	.toast-command {
		margin: 0.25rem 0 0 0;
		font-size: 0.85rem;
		color: #666;
		font-family: monospace;
	}

	.toast-dismiss {
		background: none;
		border: none;
		font-size: 1.5rem;
		color: #999;
		cursor: pointer;
		padding: 0;
		line-height: 1;
	}

	.toast-dismiss:hover {
		color: #333;
	}
</style>
