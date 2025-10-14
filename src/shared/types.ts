/**
 * Shared TypeScript interfaces for Roon Controller
 *
 * This file contains all data contracts used between:
 * - Backend services (Transport, Browse, Image)
 * - REST API endpoints
 * - Socket.IO events
 * - Frontend (SvelteKit)
 */

// ========================================
// Transport Types (A.2 - Claude)
// ========================================

/**
 * Playback state for a zone
 */
export type PlaybackState = 'playing' | 'paused' | 'stopped' | 'loading';

/**
 * Loop mode for playback
 */
export type LoopMode = 'disabled' | 'loop' | 'loop_one';

/**
 * Roon zone representation
 */
export interface Zone {
  /** Unique zone identifier */
  zone_id: string;

  /** Human-readable zone name */
  display_name: string;

  /** Current playback state */
  state: PlaybackState;

  /** Seek position in seconds (if available) */
  seek_position?: number;

  /** Whether zone is currently playing */
  is_play_allowed: boolean;

  /** Whether pause is allowed */
  is_pause_allowed: boolean;

  /** Whether previous track is allowed */
  is_previous_allowed: boolean;

  /** Whether next track is allowed */
  is_next_allowed: boolean;

  /** Whether seek is allowed */
  is_seek_allowed: boolean;

  /** Current volume settings */
  outputs?: ZoneOutput[];
}

/**
 * Zone output (speaker/endpoint)
 */
export interface ZoneOutput {
  /** Output identifier */
  output_id: string;

  /** Output name */
  display_name: string;

  /** Volume level (0-100, null if fixed volume) */
  volume?: VolumeSettings;
}

/**
 * Volume control settings
 */
export interface VolumeSettings {
  /** Volume type */
  type: 'number' | 'incremental';

  /** Minimum volume value */
  min: number;

  /** Maximum volume value */
  max: number;

  /** Current volume value */
  value: number;

  /** Current step for incremental volume */
  step?: number;

  /** Whether volume is muted */
  is_muted: boolean;
}

/**
 * Currently playing track information
 */
export interface NowPlaying {
  /** Zone identifier */
  zone_id: string;

  /** Track title */
  title?: string;

  /** Primary artist */
  artist?: string;

  /** Album name */
  album?: string;

  /** Album artist */
  album_artist?: string;

  /** Track duration in seconds */
  duration?: number;

  /** Current seek position in seconds */
  seek_position?: number;

  /** Image key for artwork */
  image_key?: string;

  /** Track number on album */
  track_number?: number;

  /** Disc number */
  disc_number?: number;

  /** Release year */
  year?: number;

  /** Current playback state */
  state: PlaybackState;

  /** Loop mode */
  loop?: LoopMode;

  /** Shuffle enabled */
  shuffle?: boolean;
}

// ========================================
// Browse Types (A.3 - Reserved for Codex)
// ========================================

/**
 * Options for initiating a browse operation
 */
export interface BrowseOptions {
  /** Roon browse hierarchy (e.g., "browse", "search") */
  hierarchy: string;

  /** Zone or output identifier to scope results */
  zoneId?: string;

  /** Item key to drill down into */
  itemKey?: string;

  /** Optional search/input text */
  input?: string;

  /** Result offset for pagination */
  offset?: number;

  /** Display offset override */
  setDisplayOffset?: number;

  /** Refresh the hierarchy */
  refresh?: boolean;
}

/**
 * Options for loading additional items within a hierarchy
 */
export interface BrowseLoadOptions {
  /** Roon browse hierarchy */
  hierarchy: string;

  /** Zone or output identifier */
  zoneId?: string;

  /** Item key to load */
  itemKey: string;

  /** Result offset for pagination */
  offset?: number;
}

/**
 * Options for popping the browse stack
 */
export interface BrowsePopOptions {
  /** Roon browse hierarchy */
  hierarchy: string;

  /** Zone or output identifier */
  zoneId?: string;

  /** Number of levels to pop (defaults to 1) */
  levels?: number;
}

/**
 * Normalized browse item returned from Roon
 */
export interface BrowseItem {
  /** Item title */
  title: string;

  /** Additional subtitle/description */
  subtitle?: string;

  /** Roon-provided item key for drilldown */
  itemKey?: string;

  /** Hint for UI (e.g., "track", "album") */
  hint?: string;

  /** Artwork key that can be resolved via ImageService */
  imageKey?: string;

  /** Indicates if item supports load */
  isLoadable: boolean;

  /** Indicates if item supports play */
  isPlayable: boolean;

  /** Optional content group type */
  itemType?: string;
}

/**
 * Response payload for browse and load operations
 */
export interface BrowseResult {
  /** Result title */
  title?: string;

  /** Current hierarchy level */
  level: number;

  /** Offset applied when fetching items */
  offset: number;

  /** Number of items returned */
  count: number;

  /** Total number of items available */
  totalCount?: number;

  /** Normalized items */
  items: BrowseItem[];
}

/**
 * Options for performing a search within the browse hierarchy
 */
export interface BrowseSearchOptions {
  /** Zone or output identifier */
  zoneId?: string;

  /** Search query */
  input: string;

  /** Result offset for pagination */
  offset?: number;
}

/**
 * Normalized search result item
 */
export interface SearchResult extends BrowseItem {
  /** High-level type classification */
  resultType: 'artist' | 'album' | 'track' | 'playlist' | 'genre' | 'composer' | 'label' | 'radio' | 'unknown';
}

// ========================================
// API Request/Response Types (B.1 - REST)
// ========================================

/**
 * Transport control request payload
 */
export interface TransportControlRequest {
  zone_id: string;
}

/**
 * Seek request payload
 */
export interface SeekRequest {
  zone_id: string;
  seconds: number;
}

/**
 * Volume control request payload
 */
export interface VolumeRequest {
  output_id: string;
  value: number;
}

/**
 * Standard success response
 */
export interface SuccessResponse {
  success: true;
}

/**
 * Error response
 */
export interface ErrorResponse {
  error: string;
  details?: string;
}

/**
 * Core status response
 */
export interface CoreStatusResponse {
  status: 'discovering' | 'paired' | 'unpaired';
  core?: {
    id: string;
    displayName: string;
    displayVersion: string;
  };
}

/**
 * Zones list response
 */
export interface ZonesResponse {
  zones: Zone[];
}

/**
 * Single zone response
 */
export interface ZoneResponse {
  zone: Zone | null;
}

// ========================================
// Error Types (B.3 - Implemented)
// ========================================

// See src/core/roon/errors.ts for complete error hierarchy:
// - RoonError (base class)
// - CoreUnpairedError
// - ServiceUnavailableError
// - ImageNotFoundError
// - RoonOperationError
