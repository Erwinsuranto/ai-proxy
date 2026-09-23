FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY config ./config
RUN npm run build

FROM node:20-alpine AS runner

WORKDIR /app
RUN addgroup --system app && adduser --system --ingroup app app

COPY package.json package-lock.json* ./
RUN npm ci --production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/config ./config

USER app

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/server.js"]
