FROM oven/bun:1-alpine AS builder
WORKDIR /app

COPY tsconfig.base.json .
COPY packages/signalling-server/package.json packages/signalling-server/
COPY packages/signalling-server/tsconfig.json packages/signalling-server/
COPY packages/signalling-server/src packages/signalling-server/src

WORKDIR /app/packages/signalling-server
RUN bun install --frozen-lockfile
RUN bunx tsup src/index.ts --format cjs --clean

FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY packages/signalling-server/package.json .
RUN bun install --production

# Run on Node: Bun's built-in `ws` shim ignores maxPayload.
FROM node:22-alpine
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/packages/signalling-server/package.json .
COPY --from=builder /app/packages/signalling-server/dist ./dist

USER node

ENV PORT=8080
EXPOSE $PORT

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

CMD ["node", "dist/index.js"]
