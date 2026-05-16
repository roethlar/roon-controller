import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { tick } from 'svelte';
import NowPlayingOverlay from '../NowPlayingOverlay.svelte';
import { createFakeSocket } from '../../../test/fixtures/socket';

// Mock socket client BEFORE importing the component (vi.mock factories
// are lazy but the captured fakeSocket must be initialized at the time
// they fire). Same pattern as the layout test harness.
const fakeSocket = createFakeSocket();
vi.mock('$lib/socket/client', () => ({
	getSocket: () => fakeSocket
}));

vi.mock('$lib/socket/emit', () => ({
	emitWithAck: vi.fn().mockResolvedValue({ success: true })
}));

import { emitWithAck } from '$lib/socket/emit';
import {
	nowPlayingOverlayStore,
	openNowPlayingOverlay,
	closeNowPlayingOverlay
} from '$lib/stores/nowPlayingOverlayStore';
import { setNowPlaying, resetNowPlaying } from '$lib/stores/nowPlayingStore';
import { setSelectedZone } from '$lib/stores/selectedZoneStore';
import { setZonesSnapshot } from '$lib/stores/zonesStore';
import type { Zone } from '@shared/types';

function makeZone(over: Partial<Zone> = {}): Zone {
	return {
		zone_id: over.zone_id ?? 'zone-a',
		display_name: over.display_name ?? 'Main',
		state: over.state ?? 'playing',
		seek_position: over.seek_position ?? 0,
		is_play_allowed: over.is_play_allowed ?? true,
		is_pause_allowed: over.is_pause_allowed ?? true,
		is_previous_allowed: over.is_previous_allowed ?? true,
		is_next_allowed: over.is_next_allowed ?? true,
		is_seek_allowed: over.is_seek_allowed ?? true,
		queue_items_remaining: over.queue_items_remaining,
		outputs: over.outputs ?? []
	};
}

beforeEach(() => {
	vi.mocked(emitWithAck).mockReset();
	vi.mocked(emitWithAck).mockResolvedValue({ success: true });
	fakeSocket.emit.mockReset();
	closeNowPlayingOverlay();
	resetNowPlaying();
	setSelectedZone('');
	setZonesSnapshot([]);
});

function seedActiveZone() {
	setZonesSnapshot([
		makeZone({
			zone_id: 'zone-a',
			outputs: [
				{
					output_id: 'out-a',
					display_name: 'Main',
					volume: { type: 'number', min: 0, max: 100, value: 40, step: 1, is_muted: false }
				}
			]
		})
	]);
	setSelectedZone('zone-a');
	setNowPlaying('zone-a', {
		zone_id: 'zone-a',
		state: 'playing',
		title: 'Cornflake Girl',
		artist: 'Tori Amos',
		album: 'Under the Pink',
		image_key: 'img-1',
		duration: 240,
		seek_position: 60
	});
}

describe('NowPlayingOverlay', () => {
	it('renders nothing when overlay store is closed', () => {
		seedActiveZone();
		// Default state: closed.
		render(NowPlayingOverlay);
		expect(screen.queryByRole('dialog', { name: 'Now playing' })).toBeNull();
	});

	it('renders track metadata when open', async () => {
		seedActiveZone();
		render(NowPlayingOverlay);
		openNowPlayingOverlay();
		await tick();

		expect(screen.getByRole('dialog', { name: 'Now playing' })).toBeInTheDocument();
		expect(screen.getByText('Cornflake Girl')).toBeInTheDocument();
		expect(screen.getByText('Tori Amos')).toBeInTheDocument();
		// Album is a button (Go to album).
		expect(
			screen.getByRole('button', { name: /Go to album Under the Pink/i })
		).toBeInTheDocument();
	});

	it('shows "Nothing playing" when there is no track', async () => {
		setZonesSnapshot([makeZone({ zone_id: 'zone-a' })]);
		setSelectedZone('zone-a');
		// No setNowPlaying call.
		render(NowPlayingOverlay);
		openNowPlayingOverlay();
		await tick();

		expect(screen.getByText('Nothing playing')).toBeInTheDocument();
	});

	it('Close button closes the overlay', async () => {
		seedActiveZone();
		render(NowPlayingOverlay);
		openNowPlayingOverlay();
		await tick();
		expect(get(nowPlayingOverlayStore)).toBe(true);

		await fireEvent.click(screen.getByRole('button', { name: 'Close now playing' }));
		expect(get(nowPlayingOverlayStore)).toBe(false);
	});

	it('Backdrop click closes the overlay (clicks inside dialog do not)', async () => {
		seedActiveZone();
		render(NowPlayingOverlay);
		openNowPlayingOverlay();
		await tick();

		// Click on the dialog inner: does NOT close.
		const title = screen.getByText('Cornflake Girl');
		await fireEvent.click(title);
		expect(get(nowPlayingOverlayStore)).toBe(true);

		// Click on the backdrop (the dialog div itself): closes.
		const backdrop = screen.getByRole('dialog', { name: 'Now playing' });
		await fireEvent.click(backdrop);
		expect(get(nowPlayingOverlayStore)).toBe(false);
	});

	it('Escape key closes the overlay', async () => {
		seedActiveZone();
		render(NowPlayingOverlay);
		openNowPlayingOverlay();
		await tick();

		await fireEvent.keyDown(window, { key: 'Escape' });
		expect(get(nowPlayingOverlayStore)).toBe(false);
	});

	it('Play/Pause button emits transport:play-pause', async () => {
		seedActiveZone();
		render(NowPlayingOverlay);
		openNowPlayingOverlay();
		await tick();

		// state: 'playing' → aria-label = 'Pause'.
		await fireEvent.click(screen.getByRole('button', { name: 'Pause' }));

		await waitFor(() => {
			expect(emitWithAck).toHaveBeenCalledWith(
				fakeSocket,
				'transport:play-pause',
				expect.objectContaining({ zone_id: 'zone-a' }),
				expect.any(Object)
			);
		});
	});

	it('Next button emits transport:next', async () => {
		seedActiveZone();
		render(NowPlayingOverlay);
		openNowPlayingOverlay();
		await tick();

		await fireEvent.click(screen.getByRole('button', { name: 'Next' }));
		await waitFor(() => {
			expect(emitWithAck).toHaveBeenCalledWith(
				fakeSocket,
				'transport:next',
				expect.objectContaining({ zone_id: 'zone-a' }),
				expect.any(Object)
			);
		});
	});

	it('Album button closes overlay and invokes onOpenAlbum callback', async () => {
		seedActiveZone();
		const onOpenAlbum = vi.fn();
		render(NowPlayingOverlay, { props: { onOpenAlbum } });
		openNowPlayingOverlay();
		await tick();

		await fireEvent.click(screen.getByRole('button', { name: /Go to album/i }));

		expect(get(nowPlayingOverlayStore)).toBe(false);
		expect(onOpenAlbum).toHaveBeenCalledTimes(1);
	});

	it('Volume slider emits transport:volume for absolute zones', async () => {
		seedActiveZone();
		render(NowPlayingOverlay);
		openNowPlayingOverlay();
		await tick();

		const slider = screen.getByLabelText('Volume') as HTMLInputElement;
		slider.value = '70';
		await fireEvent.input(slider);

		expect(emitWithAck).toHaveBeenCalledWith(
			fakeSocket,
			'transport:volume',
			expect.objectContaining({ output_id: 'out-a', value: 70 }),
			expect.any(Object)
		);
	});
});
