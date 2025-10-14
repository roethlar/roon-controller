# Troubleshooting Guide

## Initial Pairing with Roon Core

### First-Time Setup

When you first start the Roon Controller, it will show status: `discovering`. This means the backend is searching for your Roon Core on the network.

**To complete pairing**:

1. **Start the backend**:
   ```bash
   npm run dev
   # or
   npm start
   ```

2. **Open your Roon application** (desktop or mobile)

3. **Navigate to Settings**:
   - Click Settings icon
   - Go to **Extensions** section

4. **Authorize the controller**:
   - Look for "Custom Roon Controller" in the list
   - Click **Enable** to authorize
   - The backend will immediately receive the pairing token

5. **Verify connection**:
   - Backend logs should show: "Paired with Roon core"
   - Frontend status changes from `discovering` to `paired`
   - Token saved to `config/roon-token.json`

**Subsequent Starts**: The saved token auto-reconnects - no manual authorization needed.

---

## Common Issues

### "Status stuck on discovering"

**Possible causes**:
- Roon Core not running on network
- Firewall blocking mDNS/network discovery
- Different network subnet

**Solutions**:
1. Verify Roon Core is running (check Roon app)
2. Ensure backend and Roon Core on same network
3. Check firewall settings allow node.js network access
4. Review backend logs: `npm run dev` shows discovery attempts

### "Status shows unpaired after working"

**Cause**: Roon Core disconnected or extension was disabled

**Solutions**:
1. Check Roon Core is still running
2. Go to Roon → Settings → Extensions
3. Re-enable "Custom Roon Controller" if disabled
4. Check network connectivity

### "Controls not working / No zones shown"

**Possible causes**:
- Frontend not connected to backend
- WebSocket connection failed
- No active zones in Roon

**Solutions**:
1. Check connection indicator in nav bar (should show "Connected")
2. Open browser console, look for WebSocket errors
3. Verify backend is running on port 3333
4. Ensure at least one zone is playing in Roon
5. Check backend logs for zone subscription errors

### "Images not loading"

**Possible causes**:
- Image service not available from Core
- Invalid image keys
- CORS issues

**Solutions**:
1. Check backend logs for image service errors
2. Verify Core connection status is `paired`
3. Test direct image URL: `/api/image/{key}` in browser
4. Check browser console for CORS errors

### "Volume control not responding"

**Possible causes**:
- Output has fixed volume (not controllable)
- Output uses incremental volume (not number)

**Current limitation**: Dashboard only shows outputs with `type: 'number'` volume

**Workaround**: Use Roon app for incremental volume controls

---

## Development Issues

### "npm run build fails"

**Check**:
1. All dependencies installed: `npm install`
2. TypeScript version compatible: `npm list typescript`
3. Review build errors for missing types

### "Tests failing"

**Solutions**:
1. Clear Jest cache: `npx jest --clearCache`
2. Reinstall test dependencies: `npm install --save-dev jest ts-jest @types/jest`
3. Check test file imports match source structure

### "Frontend not connecting to backend"

**Check Vite proxy**:
1. Backend running on port 3333
2. Frontend started with: `cd ui && npm run dev`
3. Check `ui/vite.config.ts` proxy configuration

**Verify**:
```bash
# Test backend directly
curl http://localhost:3333/api/core

# Check Socket.IO
curl http://localhost:3333/socket.io/
```

---

## Docker Issues

### "Container won't start"

**Check**:
1. Port 3333 not already in use: `lsof -i :3333`
2. Volume mounts exist and have correct permissions
3. Review container logs: `docker logs roon-controller`

### "Can't connect to Roon Core from container"

**Solution**: Use `--network=host` mode on Linux:
```bash
docker run --network=host roon-controller
```

Or configure docker-compose with `network_mode: host`

**Reason**: Roon discovery uses mDNS which requires host network access

---

## Configuration Errors

### "ConfigError: PORT must be an integer"

**Fix**: Ensure PORT in .env is a valid number 1-65535

### "ConfigError: LOG_LEVEL must be one of..."

**Fix**: Use valid Pino level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`

### "ROON_TOKEN_PATH cannot be empty"

**Fix**: Either:
- Set valid path in .env: `ROON_TOKEN_PATH=./config/roon-token.json`
- Or remove variable to use default location

---

## Performance Issues

### "Slow image loading"

**Optimization**:
- Images cached for 24 hours (see Cache-Control headers)
- Use smaller dimensions: `?scale=fit&width=200&height=200`
- Consider CDN or reverse proxy caching

### "High memory usage"

**Check**:
- Number of zones being tracked
- Image cache size (handled by Roon Core)
- WebSocket connection count
- Review logs for memory leaks

---

## Getting Help

**Logs Location**:
- Development: Console output from `npm run dev`
- Docker: `docker logs roon-controller`
- Systemd: `journalctl -u roon-controller -f`
- macOS launchd: `/Library/Logs/RoonController/`

**Debug Mode**:
```bash
LOG_LEVEL=debug npm run dev
```

**Check Backend Health**:
```bash
curl http://localhost:3333/api/health
curl http://localhost:3333/api/core
```

**Useful Log Patterns**:
- "Paired with Roon core" - Successful pairing
- "Subscribed to zone updates" - Transport service active
- "Transport service not available" - Core not paired yet
- "WebSocket client connected" - Frontend connected

---

## Known Limitations

1. **Queue Management**: Currently view-only (full queue control in future update)
2. **Multi-Zone**: Single zone selector (multi-room control coming)
3. **Volume Types**: Only number-based volume shown (incremental not supported yet)
4. **Search**: Results display only (playback integration pending)
5. **Accessibility**: Minor a11y warnings in build (non-blocking for MVP)
