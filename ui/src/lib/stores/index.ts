export { coreStore, isCorePaired, loadCoreStatus, setCoreStatus } from './coreStore';
export { zonesStore, zoneMapStore, loadZones, setZonesSnapshot, upsertZone, removeZone, updateSeekPosition } from './zonesStore';
export { nowPlayingStore, nowPlayingList, setNowPlaying, removeNowPlaying, resetNowPlaying } from './nowPlayingStore';
export { queueStore, setQueueSnapshot, clearQueue, resetQueue } from './queueStore';
export { selectedZoneStore, setSelectedZone } from './selectedZoneStore';
export { themeStore, initializeTheme, setTheme, toggleTheme } from './themeStore';
export {
	browseStore,
	setBrowseResult,
	setBrowseLoading,
	setBrowseError,
	setSearchResults,
	resetBrowse
} from './browseStore';
export {
	commandFeedbackStore,
	pushCommandFeedback,
	clearCommandFeedback
} from './commandFeedbackStore';
export { pendingSearchStore } from './pendingSearchStore';
export { browseNavStore } from './browseNavStore';

import { loadCoreStatus } from './coreStore';
import { loadZones } from './zonesStore';

export async function initializeStores(fetchFn: typeof fetch): Promise<void> {
	await Promise.all([loadCoreStatus(fetchFn), loadZones(fetchFn)]);
}
