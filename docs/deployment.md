# Deployment

## Prerequisites

- Node.js 20+
- npm 9+
- NVIDIA API key(s)

## Production Setup

### 1. Clone and Install

```bash
git clone https://github.com/your-org/nvidia-api-proxy.git
cd nvidia-api-proxy
npm install --production
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your NVIDIA API keys
```

### 3. Build and Start

```bash
npm run build
npm start
```

## PM2 (Process Manager)

```bash
npm install -g pm2

# Start
pm2 start dist/server.js --name nvidia-api-proxy

# Save process list
pm2 save

# Enable startup on boot
pm2 startup

# Monitor
pm2 monit
```

## Docker

### Build

```bash
docker build -t nvidia-api-proxy .
```

### Run

```bash
docker run -d \
  --name nvidia-api-proxy \
  -p 3000:3000 \
  --env-file .env \
  nvidia-api-proxy
```

### Docker Compose

```bash
docker-compose up -d
```

The `docker-compose.yml` includes:
- Automatic `.env` file loading
- Health check (every 30s)
- Restart policy (`unless-stopped`)
- `NODE_ENV=production`

### Verify Deployment

```bash
curl http://localhost:3000/health
# {"status":"ok","provider":"nvidia"}
```

## Reverse Proxy (Nginx)

```nginx
server {
    listen 443 ssl;
    server_name api.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
        proxy_buffering off;
    }
}
```

**Important:** `proxy_buffering off;` is required for Server-Sent Events (streaming) to work correctly.

## Health Checks

Integrate with your monitoring system using the health endpoints:

```bash
# Simple health check
curl -f http://localhost:3000/health

# Detailed health check
curl http://localhost:3000/internal/health

# Key statistics
curl http://localhost:3000/internal/keys
```
