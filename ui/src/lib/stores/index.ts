export { coreStore, isCorePaired, loadCoreStatus, setCoreStatus } from './coreStore';
export { zonesStore, zoneMapStore, loadZones, setZonesSnapshot, upsertZone, removeZone } from './zonesStore';
export { nowPlayingStore, nowPlayingList, setNowPlaying, removeNowPlaying, resetNowPlaying } from './nowPlayingStore';
export {
	browseStore,
	setBrowseResult,
	setBrowseLoading,
	setBrowseError,
	setSearchResults,
	resetBrowse,
	setBrowseHierarchy
} from './browseStore';
export {
	commandFeedbackStore,
	pushCommandFeedback,
	clearCommandFeedback
} from './commandFeedbackStore';

import { loadCoreStatus } from './coreStore';
import { loadZones } from './zonesStore';

export async function initializeStores(fetchFn: typeof fetch): Promise<void> {
	await Promise.all([loadCoreStatus(fetchFn), loadZones(fetchFn)]);
}
