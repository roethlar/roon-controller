import { getSocket } from './client';
import { get } from 'svelte/store';
import {
	setCoreStatus,
	setZonesSnapshot,
	upsertZone,
	removeZone,
	setNowPlaying,
	removeNowPlaying,
	resetNowPlaying,
	setQueueSnapshot,
	clearQueue,
	resetQueue,
	setBrowseResult,
	setSearchResults,
	setBrowseError,
	resetBrowse,
	pushCommandFeedback,
	nowPlayingStore
} from '../stores';
import type {
	CoreStatusResponse,
	Zone,
	BrowseResult,
	SearchResult,
	NowPlaying,
	ZoneQueue
} from '@shared/types';

interface CoreStatusEvent {
	coreStatus: CoreStatusResponse['status'];
	coreInfo?: {
		id: string;
		displayName: string;
		displayVersion: string;
	};
}

interface ZonesEvent {
	zones: Zone[];
}

interface ZoneUpdatedEvent {
	zone: Zone;
}

interface ZoneRemovedEvent {
	zone_id: string;
}

interface CommandErrorEvent {
	command: string;
	error: string;
}

type CleanupFn = () => void;

export function registerSocketHandlers(): CleanupFn {
	const socket = getSocket();
	if (!socket) {
		return () => {
			/* noop */
		};
	}

	const handleCoreStatus = (payload: CoreStatusEvent) => {
		const response: CoreStatusResponse = {
			status: payload.coreStatus,
			core: payload.coreInfo
				? {
					id: payload.coreInfo.id,
					displayName: payload.coreInfo.displayName,
					displayVersion: payload.coreInfo.displayVersion
				}
				: undefined
		};
		setCoreStatus(response);
	};

	const handleZonesSnapshot = (payload: ZonesEvent) => {
		setZonesSnapshot(payload.zones);
		const activeZones = new Set(payload.zones.map((zone) => zone.zone_id));
		const currentNowPlaying = get(nowPlayingStore);
		Object.keys(currentNowPlaying).forEach((zoneId) => {
			if (!activeZones.has(zoneId)) {
				removeNowPlaying(zoneId);
			}
		});
	};

	const handleZoneUpdated = (payload: ZoneUpdatedEvent) => {
		upsertZone(payload.zone);
	};

	const handleZoneRemoved = (payload: ZoneRemovedEvent) => {
		removeZone(payload.zone_id);
		removeNowPlaying(payload.zone_id);
		clearQueue(payload.zone_id);
	};

	const handleQueueUpdated = (payload: { queue: ZoneQueue }) => {
		setQueueSnapshot(payload.queue);
	};

	const handleNowPlaying = (payload: { zone_id: string; now_playing: NowPlaying | null }) => {
		if (payload.now_playing) {
			setNowPlaying(payload.zone_id, payload.now_playing);
		} else {
			removeNowPlaying(payload.zone_id);
		}
	};

	const handleBrowseResult = (result: BrowseResult) => {
		setBrowseResult(result);
	};

	const handleSearchResult = (results: SearchResult[]) => {
		setSearchResults(results);
	};

	const handleTransportError = (payload: CommandErrorEvent) => {
		pushCommandFeedback({
			source: 'transport',
			command: payload.command,
			message: payload.error
		});
	};

	const handleBrowseError = (payload: CommandErrorEvent) => {
		setBrowseError(payload.error);
		pushCommandFeedback({
			source: 'browse',
			command: payload.command,
			message: payload.error
		});
	};

	const handleQueueError = (payload: CommandErrorEvent) => {
		pushCommandFeedback({
			source: 'queue',
			command: payload.command,
			message: payload.error
		});
	};

	const handleDisconnect = () => {
		setCoreStatus({ status: 'unpaired' });
		setZonesSnapshot([]);
		resetNowPlaying();
		resetQueue();
		resetBrowse();
	};

	const listeners: Array<[string, (...args: any[]) => void]> = [
		['core-status', handleCoreStatus],
		['zones', handleZonesSnapshot],
		['zone-updated', handleZoneUpdated],
		['zone-removed', handleZoneRemoved],
		['now-playing-updated', handleNowPlaying],
		['queue-updated', handleQueueUpdated],
		['browse-result', handleBrowseResult],
		['search-result', handleSearchResult],
		['transport:error', handleTransportError],
		['browse:error', handleBrowseError],
		['queue:error', handleQueueError]
	];

	listeners.forEach(([event, handler]) => {
		socket.on(event, handler);
	});

	socket.on('disconnect', handleDisconnect);

	return () => {
		listeners.forEach(([event, handler]) => {
			socket.off(event, handler);
		});
		socket.off('disconnect', handleDisconnect);
	};
}
