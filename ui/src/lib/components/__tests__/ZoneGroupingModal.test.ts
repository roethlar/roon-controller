import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { tick } from 'svelte';
import ZoneGroupingModal from '../ZoneGroupingModal.svelte';
import { createFakeSocket } from '../../../test/fixtures/socket';

const fakeSocket = createFakeSocket();
vi.mock('$lib/socket/client', () => ({
	getSocket: () => fakeSocket
}));

vi.mock('$lib/socket/emit', () => ({
	emitWithAck: vi.fn().mockResolvedValue({ success: true })
}));

import { emitWithAck } from '$lib/socket/emit';
import {
	zoneGroupingStore,
	openZoneGrouping,
	closeZoneGrouping
} from '$lib/stores/zoneGroupingStore';
import { setSelectedZone } from '$lib/stores/selectedZoneStore';
import { setZonesSnapshot } from '$lib/stores/zonesStore';
import type { Zone } from '@shared/types';

function makeZone(over: Partial<Zone> = {}): Zone {
	return {
		zone_id: over.zone_id ?? 'zone-a',
		display_name: over.display_name ?? 'Main',
		state: over.state ?? 'playing',
		seek_position: 0,
		is_play_allowed: true,
		is_pause_allowed: true,
		is_previous_allowed: true,
		is_next_allowed: true,
		is_seek_allowed: true,
		outputs: over.outputs ?? []
	};
}

beforeEach(() => {
	vi.mocked(emitWithAck).mockReset();
	vi.mocked(emitWithAck).mockResolvedValue({ success: true });
	closeZoneGrouping();
	setZonesSnapshot([]);
	setSelectedZone('');
});

function seedTwoZones() {
	setZonesSnapshot([
		makeZone({
			zone_id: 'zone-a',
			display_name: 'Living Room',
			outputs: [{ output_id: 'out-a', display_name: 'Speakers' }]
		}),
		makeZone({
			zone_id: 'zone-b',
			display_name: 'Kitchen',
			outputs: [{ output_id: 'out-b', display_name: 'Sonos' }]
		})
	]);
	setSelectedZone('zone-a');
}

describe('ZoneGroupingModal', () => {
	it('renders nothing when closed', () => {
		seedTwoZones();
		render(ZoneGroupingModal);
		expect(screen.queryByRole('dialog', { name: 'Group zones' })).toBeNull();
	});

	it('renders one row per unique output across all zones when open', async () => {
		seedTwoZones();
		render(ZoneGroupingModal);
		openZoneGrouping();
		await tick();

		expect(screen.getByText('Speakers')).toBeInTheDocument();
		expect(screen.getByText('Sonos')).toBeInTheDocument();
		// Zone names are shown as secondary labels.
		expect(screen.getByText('Living Room')).toBeInTheDocument();
		expect(screen.getByText('Kitchen')).toBeInTheDocument();
	});

	it('pre-checks the active zone outputs and leaves others unchecked', async () => {
		seedTwoZones();
		render(ZoneGroupingModal);
		openZoneGrouping();
		await tick();

		const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
		// First row is 'out-a' (Living Room is selected zone) → checked.
		expect(checkboxes[0].checked).toBe(true);
		// Second row 'out-b' (Kitchen) → not checked.
		expect(checkboxes[1].checked).toBe(false);
	});

	it('Group button is disabled until 2+ outputs are checked', async () => {
		setZonesSnapshot([
			makeZone({
				zone_id: 'zone-a',
				outputs: [
					{ output_id: 'out-a', display_name: 'A' },
					{ output_id: 'out-b', display_name: 'B' }
				]
			})
		]);
		setSelectedZone('');
		render(ZoneGroupingModal);
		openZoneGrouping();
		await tick();

		// No active zone → nothing pre-checked.
		const groupBtn = screen.getByRole('button', { name: 'Group selected outputs' });
		expect(groupBtn).toBeDisabled();

		const checkboxes = screen.getAllByRole('checkbox');
		await fireEvent.click(checkboxes[0]);
		// One checked → still disabled.
		expect(groupBtn).toBeDisabled();

		await fireEvent.click(checkboxes[1]);
		// Two checked → enabled.
		expect(groupBtn).not.toBeDisabled();
	});

	it('Save emits transport:group with the checked output_ids', async () => {
		seedTwoZones();
		render(ZoneGroupingModal);
		openZoneGrouping();
		await tick();

		// Active zone 'zone-a' has out-a pre-checked. Add out-b.
		const checkboxes = screen.getAllByRole('checkbox');
		await fireEvent.click(checkboxes[1]);

		await fireEvent.click(screen.getByRole('button', { name: 'Group selected outputs' }));

		await waitFor(() => {
			expect(emitWithAck).toHaveBeenCalledWith(
				fakeSocket,
				'transport:group',
				expect.objectContaining({
					output_ids: expect.arrayContaining(['out-a', 'out-b'])
				}),
				expect.any(Object)
			);
		});
	});

	it('closes the overlay after a successful save', async () => {
		seedTwoZones();
		render(ZoneGroupingModal);
		openZoneGrouping();
		await tick();

		const checkboxes = screen.getAllByRole('checkbox');
		await fireEvent.click(checkboxes[1]);
		await fireEvent.click(screen.getByRole('button', { name: 'Group selected outputs' }));

		await waitFor(() => {
			expect(get(zoneGroupingStore)).toBe(false);
		});
	});

	it('Cancel closes without emitting', async () => {
		seedTwoZones();
		render(ZoneGroupingModal);
		openZoneGrouping();
		await tick();

		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(get(zoneGroupingStore)).toBe(false);
		expect(emitWithAck).not.toHaveBeenCalled();
	});

	it('Esc closes without emitting', async () => {
		seedTwoZones();
		render(ZoneGroupingModal);
		openZoneGrouping();
		await tick();

		await fireEvent.keyDown(window, { key: 'Escape' });
		expect(get(zoneGroupingStore)).toBe(false);
		expect(emitWithAck).not.toHaveBeenCalled();
	});

	it('shows empty state when no zones / outputs are available', async () => {
		// setZonesSnapshot([]) already in beforeEach.
		render(ZoneGroupingModal);
		openZoneGrouping();
		await tick();

		expect(screen.getByText('No outputs available.')).toBeInTheDocument();
		// Group button stays disabled.
		expect(screen.getByRole('button', { name: 'Group selected outputs' })).toBeDisabled();
	});
});
