# Code Review - 2026-05-02

## Scope
Reviewed the backend Roon integration, HTTP API, Socket.IO API, Svelte UI flows for browse/search/queue/zones, shared types, tests, and current handoff docs. This review focuses on correctness, runtime failure modes, security posture, and gaps that matter for Browse, Search, Queue Management, and Zone Switching.

## Validation
- `npm run build` passed.
- `npm test -- --runInBand` passed with 2 suites and 25 tests.
- `npm run lint` passed for backend TypeScript.
- `npm --prefix ui run check` passed with 0 errors and 0 warnings.
- `npm --prefix ui run build` passed.

## Findings

### 1. P1 High - The app exposes unauthenticated Roon control on the network by default
Evidence: `src/config/env.ts:36`, `.env.example:2`, `src/server/socket/index.ts:35`, `src/server/socket/index.ts:37`

The default host is `0.0.0.0`, there is no authentication or authorization middleware on the REST routes, and Socket.IO allows `CLIENT_ORIGIN` to default to `*`. Any client that can reach the VM can control transport, browse the library, subscribe to queues, and fetch artwork. A malicious website loaded by a user on the same network may also be able to open a Socket.IO connection to the controller because the socket CORS origin is wide open.

Recommendation: default to `127.0.0.1` for development, require an explicit `HOST=0.0.0.0` opt-in for LAN exposure, add an optional shared secret or reverse-proxy auth path before installer work resumes, and restrict Socket.IO origins to a configured allowlist.

Suggested tests: route tests that reject missing auth when auth is enabled, and a Socket.IO connection test that verifies disallowed origins are rejected.

### 2. P1 High - Socket acknowledgement errors are swallowed by the UI
Evidence: `src/server/socket/index.ts:44`, `src/server/socket/index.ts:51`, `src/server/socket/index.ts:72`, `src/server/socket/index.ts:79`, `ui/src/routes/+layout.svelte:76`, `ui/src/routes/+layout.svelte:81`, `ui/src/routes/+layout.svelte:84`, `ui/src/routes/queue/+page.svelte:51`, `ui/src/routes/queue/+page.svelte:76`, `ui/src/routes/queue/+page.svelte:102`

When an ack callback is supplied, the server returns `{ error }` through the ack and does not emit the corresponding `transport:error` or `queue:error` event. The play bar and queue UI resolve the ack promise without inspecting the ack payload, so rejected Roon commands are treated as successful and no visible feedback is shown.

Impact: play/pause, previous/next, queue play-from-here, and queue settings can fail silently. This is especially risky while debugging zone switching or queue state because the UI can look responsive while commands are being rejected.

Recommendation: introduce a typed socket ack shape such as `{ success: true } | { error: string }`, centralize `emitWithAck` on the client, and surface ack errors through `pushCommandFeedback`. Alternatively, emit the error event even when an ack exists, but still fix the clients to inspect ack results.

Suggested tests: Socket.IO tests for failed transport and queue commands with ack callbacks, plus UI/component tests that assert a toast or error state is shown for ack errors.

### 3. P1 High - Socket reconnect can leave the UI stuck in an offline state
Evidence: `ui/src/lib/socket/register.ts:156`, `ui/src/lib/socket/register.ts:157`, `ui/src/lib/socket/register.ts:158`, `ui/src/lib/socket/register.ts:159`, `ui/src/lib/socket/register.ts:160`, `ui/src/lib/socket/register.ts:161`, `src/server/socket/index.ts:86`, `src/server/socket/index.ts:88`, `src/server/socket/index.ts:92`, `ui/src/routes/+layout.svelte:31`, `ui/src/routes/+layout.svelte:35`

The frontend treats any Socket.IO disconnect as a Roon core disconnect and clears core, zones, now-playing, queue, and browse state. On a new socket connection, the server hydrates zones and now-playing but does not emit the current core status. The initial REST hydration only runs once on layout mount.

Impact: a transient WebSocket disconnect can make the UI show `Offline` even though the Roon Core is still paired. The UI may not recover until Roon emits another core-status event.

Recommendation: either emit current core status during `io.on("connection")` or have the client call `initializeStores(fetch)` on socket `connect` and `reconnect`. Also consider distinguishing socket connectivity from Roon core status in stores and UI copy.

Suggested tests: frontend store/socket tests for disconnect followed by reconnect while `/api/core` remains paired, and a backend socket connection test that validates initial core-status hydration.

### 4. P2 Medium - REST and socket payload validation is too weak for numeric and enum fields
Evidence: `src/server/http/routes/transport.ts:114`, `src/server/http/routes/transport.ts:118`, `src/server/http/routes/transport.ts:136`, `src/server/http/routes/transport.ts:140`, `src/server/http/routes/transport.ts:213`, `src/server/http/routes/transport.ts:222`, `src/server/socket/index.ts:192`, `src/server/socket/index.ts:218`, `src/server/http/routes/image.ts:20`, `src/server/http/routes/image.ts:21`, `src/server/http/routes/image.ts:22`

Several handlers cast request bodies or query strings to TypeScript types without runtime validation. Examples include `seek` accepting non-numeric REST values as long as `seconds !== undefined`, volume accepting any defined value on REST, queue subscription passing arbitrary `max_item_count`, and image scale accepting any query string cast to the union type. Socket seek and volume check `typeof number` but do not reject `NaN`, `Infinity`, negative seek positions, or out-of-range volumes.

Impact: malformed clients can push bad data into Roon API calls, produce confusing RoonOperationError paths, or create cache/service edge cases. TypeScript annotations do not protect these runtime boundaries.

Recommendation: add shared validators for finite numbers, positive integers, bounded volume based on output metadata where available, allowed loop modes, allowed image scale values, and positive image dimensions. Return consistent 400 JSON errors before calling Roon.

Suggested tests: HTTP route validation tests for strings, `NaN`, negative values, bad scale values, invalid queue counts, and invalid settings payloads. Mirror the same cases for Socket.IO payloads.

### 5. P2 Medium - Unknown API routes return frontend HTML when a UI build exists
Evidence: `src/server/http/app.ts:42`, `src/server/http/app.ts:44`, `src/server/http/app.ts:46`, `src/server/http/app.ts:47`, `ui/src/lib/api/client.ts:40`, `ui/src/lib/api/client.ts:51`

The SPA fallback catches every unmatched request after API routers. In production, an unknown `/api/...` route can return `index.html` with a 200 status instead of JSON 404. The frontend API client then attempts `response.json()` on HTML, which becomes an unstructured parse failure rather than a useful API error.

Impact: typos, stale frontend endpoints, or integration mistakes look like client-side parse errors instead of explicit backend 404s.

Recommendation: add an `/api` 404 JSON handler before the static fallback, or make the fallback skip paths beginning with `/api/`.

Suggested tests: HTTP tests for unknown `/api/nope` returning 404 JSON and unknown frontend paths returning `index.html`.

### 6. P2 Medium - Browse and search load entire result sets synchronously
Evidence: `src/core/roon/BrowseService.ts:315`, `src/core/roon/BrowseService.ts:329`, `src/core/roon/BrowseService.ts:332`, `src/core/roon/BrowseService.ts:341`, `ui/src/routes/library/+page.svelte:337`, `ui/src/routes/library/+page.svelte:341`, `ui/src/routes/library/+page.svelte:349`, `ui/src/routes/library/+page.svelte:351`, `ui/src/routes/library/+page.svelte:179`, `ui/src/routes/library/+page.svelte:183`, `ui/src/routes/library/+page.svelte:197`

`loadItemsForList` loops from the current offset to `totalCount` in batches of 100 and accumulates all items before returning. Search result navigation also re-runs the whole search session before opening a clicked result. This supports alphabetic jump lists and avoids stale Roon search stacks, but it means broad searches and large library lists can trigger many sequential Roon calls before the UI updates.

Impact: large libraries can make Browse/Search feel frozen, and repeated search-result clicks can repeat expensive work. This is likely to surface under the user's Browse and Search priorities.

Recommendation: add a paging or virtualized browse model while preserving the full-list jump UX. A practical compromise is to load the first page immediately, background-load subsequent batches with cancellation, and expose explicit loading/progress state.

Suggested tests: a BrowseService test with a large `list.count`, plus a manual live-Core test against a large album/track library measuring initial render time and repeated search result click latency.

### 7. P2 Medium - Search UI truncates accessible results and does not label stale result context
Evidence: `ui/src/lib/components/Search.svelte:65`, `ui/src/lib/components/Search.svelte:67`, `ui/src/lib/components/Search.svelte:68`, `ui/src/lib/stores/browseStore.ts:45`, `ui/src/lib/stores/browseStore.ts:48`, `ui/src/lib/stores/browseStore.ts:56`, `ui/src/lib/stores/browseStore.ts:59`

The search component stores all search results but renders only the first eight with no "show all", paging, type grouping, or query label. The store keeps `lastSearch` and `lastSearchQuery`, but the component only shows a count. After navigation or zone changes, results can remain visible without enough context to tell which query or zone produced them.

Impact: users cannot reach result 9 or later through the current search UI, and stale-looking results are easy to click during browse/search transitions.

Recommendation: display the submitted query, show all results or paginate them, group by result type if useful, and clear or refresh search results when the active zone changes if zone-scoped search behavior differs.

Suggested tests: component tests for result counts above eight, query labeling, and zone-change behavior.

### 8. P2 Medium - Pairing token file permissions rely on process umask
Evidence: `src/core/roon/RoonClient.ts:152`, `src/core/roon/RoonClient.ts:154`, `src/core/roon/RoonClient.ts:159`

The Roon pairing token is written with `fs.writeFileSync` and default file mode. Depending on the service user and system umask, the token may be readable by other local users.

Impact: a local user with read access to the token can reuse the extension's Roon pairing identity. This is lower risk than network exposure but becomes relevant when installing as a system service on a shared VM.

Recommendation: create the token directory with restrictive permissions where possible and write the token file with mode `0o600`. Installer documentation should also state the expected service user and token path permissions.

Suggested tests: unit test `persistToken` through a test-accessible wrapper or integration test to assert the file mode on POSIX systems.

### 9. P2 Medium - Image cache paths are built from unsanitized route parameters
Evidence: `src/server/http/routes/image.ts:17`, `src/server/http/routes/image.ts:19`, `src/core/roon/ImageService.ts:65`, `src/core/roon/ImageService.ts:66`, `src/core/roon/ImageService.ts:69`, `src/core/roon/ImageService.ts:75`, `src/core/roon/ImageService.ts:88`

The raw `:key` route parameter is used as part of the cache filename. Express route parameters can include encoded characters, and `path.join(cacheDir, cacheKey)` will honor path separators if they reach `imageKey`. The current route normally limits unencoded slashes, but encoded separators and unusual key characters should not be trusted at a filesystem boundary.

Impact: malformed image keys can produce cache misses, failed writes, unexpected subpaths, or in the worst case cache reads/writes outside the intended directory if a decoded separator is accepted.

Recommendation: hash `imageKey + scale + width + height` into a fixed cache filename, validate the scale and dimensions, and avoid using remote or user-controlled identifiers directly as filesystem paths.

Suggested tests: route/service tests with encoded slash, dot-dot, long key, invalid scale, and non-integer width/height inputs.

### 10. P3 Low - Pending play-bar searches can be dropped during socket reconnect
Evidence: `ui/src/routes/library/+page.svelte:48`, `ui/src/routes/library/+page.svelte:50`, `ui/src/routes/library/+page.svelte:52`, `ui/src/routes/library/+page.svelte:54`, `ui/src/routes/library/+page.svelte:56`

The Library page consumes `pendingSearchStore` and clears it before confirming a live socket is available. If the user clicks an artist/track search link from the play bar during a reconnect window, the pending search is lost silently.

Impact: an intermittent connection can make a user action disappear without feedback.

Recommendation: keep the pending search until the socket emit succeeds, retry it on socket reconnect, or show command feedback when the socket is unavailable.

Suggested tests: store/component test where `pendingSearchStore` is set while `getSocket()` returns null.

### 11. P3 Low - Zone subscription idempotency is guarded outside the service and may duplicate after repeated paired events
Evidence: `src/server/server.ts:50`, `src/server/server.ts:52`, `src/server/server.ts:58`, `src/server/server.ts:71`, `src/server/server.ts:74`, `src/server/server.ts:75`, `src/core/roon/TransportService.ts:343`, `src/core/roon/TransportService.ts:346`, `src/core/roon/TransportService.ts:385`, `src/core/roon/TransportService.ts:386`

`TransportService.subscribeZones()` itself is not idempotent and does not store an unsubscribe handle or internal subscribed flag. The caller owns the `zonesSubscribed` guard, but resets it on every paired event before calling `subscribeZones()` again. `resetState()` clears cached zones and queues, but does not unsubscribe from zone callbacks.

Impact: if the Roon API can emit repeated paired callbacks without a full service teardown, duplicate zone listeners could cause duplicate zone events and repeated queue subscription attempts. This may be rare, but it is hard to diagnose once the app runs as a long-lived service.

Recommendation: move zone-subscription idempotency into `TransportService`, store an unsubscribe handle if the API exposes one, and add logging/tests around repeated paired/unpaired transitions.

Suggested tests: mock `subscribe_zones` and assert repeated paired events create only one active callback.

### 12. P3 Low - Test coverage misses the riskiest integration paths
Evidence: `src/core/roon/__tests__/BrowseService.test.ts`, `src/core/roon/__tests__/TransportService.test.ts`

Current automated tests cover service-level behavior well enough for recent browse/search regression work, but there are no tests for Socket.IO ack behavior, HTTP route validation, API fallback behavior, frontend search-result navigation, queue UI actions, reconnect hydration, or theme/zone switching flows.

Impact: the highest-priority user flows can regress while unit tests still pass.

Recommendation: add targeted integration tests before broad UI redesign work. The first useful set is socket command ack errors, `/api` 404 behavior, reconnect hydration, search result click flow, and queue action error feedback.

Suggested tests: Jest tests for backend routes and sockets, plus Svelte/component or browser tests for Library/Search/Queue flows.

## Positive Observations
- The recent browse/search state separation is directionally correct and directly addresses the reported search-result stack corruption. Relevant code: `ui/src/lib/browseSessions.ts`, `ui/src/routes/library/+page.svelte:179`, `src/core/roon/BrowseService.ts:302`.
- REST-initiated browse actions no longer broadcast globally through the server, which avoids quick-play helper calls overwriting client browse state. Relevant code: `src/server/server.ts:121`.
- Queue subscriptions are idempotent per zone and can request large snapshots for the user's full-queue requirement. Relevant code: `src/core/roon/TransportService.ts:263`, `src/core/roon/TransportService.ts:604`.
- The project has a straightforward validation path and all current validation commands passed during this review.

## Recommended Fix Order
1. Lock down network exposure and Socket.IO origin/auth before installer or autostart work resumes.
2. Fix socket ack handling so failed transport and queue commands surface reliably.
3. Fix reconnect hydration so socket disconnects do not masquerade as Roon core disconnects.
4. Add shared runtime validators for REST and socket payloads.
5. Add `/api` 404 JSON handling before the SPA fallback.
6. Improve Search and Browse scalability with visible paging/progress while preserving Roon-style full browsing.
7. Add integration tests for the exact Browse, Search, Queue, and Zone Switching flows listed above.

## Open Questions
- Should LAN access be a first-class supported mode, or should the default product assume localhost plus a reverse proxy?
- Should search results be global to the library or scoped by active zone/output for action availability?
- What maximum library size should the UI be expected to browse without virtualized lists or background loading?
- Is installer hardening expected to include auth/token setup, or should auth remain a reverse-proxy concern?
