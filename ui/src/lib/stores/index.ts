export { coreStore, isCorePaired, loadCoreStatus, setCoreStatus } from './coreStore';
export { zonesStore, zoneMapStore, loadZones, setZonesSnapshot, upsertZone, removeZone, updateSeekPosition } from './zonesStore';
export { nowPlayingStore, nowPlayingList, setNowPlaying, removeNowPlaying, resetNowPlaying } from './nowPlayingStore';
export { queueStore, setQueueSnapshot, clearQueue, resetQueue } from './queueStore';
export { selectedZoneStore, setSelectedZone } from './selectedZoneStore';
export { themeStore, initializeTheme, setTheme, toggleTheme } from './themeStore';
export {
	browseStore,
	setBrowseResult,
	appendBrowseItems,
	setBrowseLoading,
	setBrowseError,
	setSearchLoading,
	setSearchError,
	setSearchResults,
	clearSearchResults,
	resetBrowse
} from './browseStore';
export {
	commandFeedbackStore,
	pushCommandFeedback,
	clearCommandFeedback
} from './commandFeedbackStore';
export { pendingSearchStore } from './pendingSearchStore';
export { browseNavStore } from './browseNavStore';
export { socketStatusStore, setSocketStatus, type SocketStatus } from './socketStatusStore';
export {
	browseHistoryStore,
	pushHistory,
	popHistory,
	popForward,
	resetHistory,
	replaceHistory,
	type BrowseBreadcrumb,
	type BrowseHistoryStep
} from './browseHistoryStore';
export {
	exploreRailStore,
	resolveExploreRail,
	invalidateExploreRail,
	type ExploreRailEntry,
	type ExploreRailState
} from './exploreRailStore';
export {
	welcomeStatsStore,
	loadWelcomeStats,
	invalidateWelcomeStats,
	type WelcomeStats,
	type WelcomeStatsState
} from './welcomeStatsStore';
export {
	recentlyPlayedStore,
	loadRecentlyPlayed,
	applyRecentlyPlayedInserted,
	applyRecentlyPlayedCleared,
	applyClearResponse,
	resetRecentlyPlayed,
	type RecentlyPlayedState
} from './recentlyPlayedStore';

import { loadCoreStatus } from './coreStore';
import { loadZones } from './zonesStore';
import { loadRecentlyPlayed } from './recentlyPlayedStore';

export async function initializeStores(fetchFn: typeof fetch): Promise<void> {
	await Promise.all([
		loadCoreStatus(fetchFn),
		loadZones(fetchFn),
		loadRecentlyPlayed(fetchFn)
	]);
}
