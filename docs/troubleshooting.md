# Troubleshooting

## Common Issues

### 401 Unauthorized

**Cause:** Invalid or missing NVIDIA API key.

**Solution:**
```bash
# Check current configuration
echo "NVIDIA_API_KEY=$NVIDIA_API_KEY"

# Ensure key is set in .env
grep NVIDIA_API_KEY .env

# Verify key format (should start with 'nvapi-')
```

### All keys in cooldown

**Cause:** All API keys have hit rate limits (429 responses).

**Solution:**
- Wait 60 seconds for automatic cooldown recovery
- Check `GET /internal/health` for cooldown status
- Consider adding more API keys
- Reduce request rate

### Models not appearing

**Cause:** NVIDIA API unreachable or network issue.

**Solution:**
- Check `NVIDIA_BASE_URL` is correct
- Verify network connectivity to `integrate.api.nvidia.com`
- The proxy falls back to `config/models.json` automatically
- Check proxy logs for connection errors

### Slow streaming responses

**Cause:** Network latency or NVIDIA API processing time.

**Solution:**
- Use a geographically closer NVIDIA endpoint
- Check `NVIDIA_BASE_URL` configuration
- Monitor per-key latency at `GET /internal/keys`
- Ensure no proxy buffering (requires `proxy_buffering off` in nginx)

### `npm run build` fails

**Cause:** TypeScript compilation errors.

**Solution:**
```bash
# Check TypeScript version
npx tsc --version

# Clear and rebuild
rm -rf dist
npm run build
```

### Server won't start

**Cause:** Missing API keys or port in use.

**Solution:**
```bash
# Check port availability
lsof -i :3000

# Verify environment
node -e "require('dotenv').config(); console.log(process.env.NVIDIA_API_KEY ? 'Key set' : 'No key')"
```

## Logs

| Log Level | Description |
|-----------|-------------|
| `error` | Request failures and server errors |
| `warn` | Retries, cooldowns, and fallbacks |
| `info` | Normal operations (requests) |
| `debug` | (with `DEBUG=true`) Full request/response bodies |
| `trace` | (with `LOG_LEVEL=trace`) Axios internals |

## Debug Mode

Enable debug mode to see request and response details:

```env
DEBUG=true
```

For tool call debugging:

```env
DEBUG_TOOL_CALL=true
```

This writes tool call payloads to stderr for inspection.

## Getting Help

If issues persist:
1. Check all logs for error messages
2. Verify network connectivity to NVIDIA API
3. Open an issue on GitHub with:
   - Proxy version (`node -e "console.log(require('./package.json').version)"`)
   - Node.js version (`node --version`)
   - Relevant log output
   - Steps to reproduce
