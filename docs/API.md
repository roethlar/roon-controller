# Roon Controller API Reference

## REST Endpoints

Base URL: `http://localhost:3333/api`

### Core Status

#### GET /core
Get Roon core connection status

**Response**:
```json
{
  "status": "paired",
  "core": {
    "id": "core-id",
    "displayName": "Roon Core",
    "displayVersion": "1.8"
  }
}
```

**Status Values**: `discovering`, `paired`, `unpaired`

---

### Zones

#### GET /zones
List all available zones

**Response**:
```json
{
  "zones": [
    {
      "zone_id": "zone-1",
      "display_name": "Living Room",
      "state": "playing",
      "is_play_allowed": true,
      "is_pause_allowed": true,
      "is_next_allowed": true,
      "is_previous_allowed": true,
      "outputs": [...]
    }
  ]
}
```

#### GET /zones/:id
Get specific zone by ID

**Response**:
```json
{
  "zone": { /* Zone object or null */ }
}
```

---

### Transport Controls

All transport endpoints are POST requests with JSON bodies.

#### POST /transport/play-pause
Toggle play/pause

**Request**:
```json
{
  "zone_id": "zone-1"
}
```

**Response**:
```json
{
  "success": true
}
```

#### POST /transport/next
Skip to next track

**Request**: `{ "zone_id": "zone-1" }`

#### POST /transport/previous
Skip to previous track

**Request**: `{ "zone_id": "zone-1" }`

#### POST /transport/stop
Stop playback

**Request**: `{ "zone_id": "zone-1" }`

#### POST /transport/seek
Seek to position

**Request**:
```json
{
  "zone_id": "zone-1",
  "seconds": 120
}
```

#### POST /transport/volume
Set volume

**Request**:
```json
{
  "output_id": "output-1",
  "value": 50
}
```

---

### Browse & Search

#### POST /browse
Navigate browse hierarchy

**Request**:
```json
{
  "hierarchy": "browse",
  "itemKey": "optional-item-key",
  "offset": 0
}
```

**Response**:
```json
{
  "title": "Artists",
  "level": 1,
  "offset": 0,
  "count": 50,
  "totalCount": 500,
  "items": [
    {
      "title": "Artist Name",
      "subtitle": "100 albums",
      "itemKey": "key-123",
      "imageKey": "img-key",
      "isLoadable": true,
      "isPlayable": false
    }
  ]
}
```

#### POST /browse/load
Load item details

**Request**:
```json
{
  "hierarchy": "browse",
  "itemKey": "key-123"
}
```

#### POST /browse/pop
Go back in hierarchy

**Request**:
```json
{
  "hierarchy": "browse",
  "levels": 1
}
```

#### POST /browse/search
Search library

**Request**:
```json
{
  "input": "search query",
  "offset": 0
}
```

**Response**: Array of SearchResult with `resultType` field

---

### Image

#### GET /image/:key
Stream artwork by image key

**Query Parameters**:
- `scale` (optional): `fit`, `fill`, or `stretch`
- `width` (optional): Width in pixels
- `height` (optional): Height in pixels

**Note**: When `scale` is provided, both `width` and `height` are required.

**Example**:
```
GET /api/image/abc123?scale=fit&width=300&height=300
```

**Response**: Image stream with appropriate Content-Type and cache headers

---

## WebSocket Events

Connect to: `ws://localhost:3333/socket.io`

### Server → Client Events

#### core-status
Core connection status changed

**Payload**:
```json
{
  "coreStatus": "paired",
  "coreInfo": {
    "id": "core-id",
    "displayName": "Roon Core",
    "displayVersion": "1.8"
  }
}
```

#### zones
Complete zones snapshot

**Payload**:
```json
{
  "zones": [/* Array of Zone objects */]
}
```

#### zone-updated
Single zone update

**Payload**:
```json
{
  "zone": {/* Zone object */}
}
```

#### now-playing-updated
Now playing track changed

**Payload**:
```json
{
  "zone_id": "zone-1",
  "now_playing": {
    "title": "Track Title",
    "artist": "Artist Name",
    "album": "Album Name",
    "image_key": "img-key",
    "duration": 240,
    "seek_position": 30,
    "state": "playing"
  }
}
```

#### browse-result
Browse operation result

**Payload**: BrowseResult object

#### search-result
Search operation result

**Payload**: Array of SearchResult objects

#### transport:error
Transport command failed

**Payload**:
```json
{
  "command": "transport:play-pause",
  "error": "Error message"
}
```

#### browse:error
Browse command failed

**Payload**:
```json
{
  "command": "browse:browse",
  "error": "Error message"
}
```

---

### Client → Server Commands

All commands support optional acknowledgment callbacks.

#### transport:play-pause
**Payload**: `{ "zone_id": "zone-1" }`

#### transport:next
**Payload**: `{ "zone_id": "zone-1" }`

#### transport:previous
**Payload**: `{ "zone_id": "zone-1" }`

#### transport:stop
**Payload**: `{ "zone_id": "zone-1" }`

#### transport:seek
**Payload**: `{ "zone_id": "zone-1", "seconds": 120 }`

#### transport:volume
**Payload**: `{ "output_id": "output-1", "value": 50 }`

#### browse:browse
**Payload**: BrowseOptions object

#### browse:load
**Payload**: BrowseLoadOptions object

#### browse:pop
**Payload**: BrowsePopOptions object

#### browse:search
**Payload**: BrowseSearchOptions object

---

## Error Handling

All endpoints return errors in this format:

```json
{
  "error": "Error message",
  "details": "ERROR_CODE"
}
```

### HTTP Status Codes

- `200` - Success
- `400` - Bad Request (invalid parameters)
- `404` - Not Found (image not found)
- `500` - Internal Server Error
- `503` - Service Unavailable (core not paired)

### Error Codes

- `CORE_UNPAIRED` - Roon core not connected
- `SERVICE_UNAVAILABLE` - Required Roon service unavailable
- `IMAGE_NOT_FOUND` - Image key invalid
- `OPERATION_FAILED` - Roon operation failed

---

## Type Definitions

All TypeScript interfaces are available in `src/shared/types.ts` and can be imported in the frontend via the `@shared` alias.
