FROM oven/bun:1-alpine AS builder
WORKDIR /app

COPY tsconfig.base.json .
COPY packages/signalling-server/package.json packages/signalling-server/
COPY packages/signalling-server/tsconfig.json packages/signalling-server/
COPY packages/signalling-server/src packages/signalling-server/src

WORKDIR /app/packages/signalling-server
RUN bun install
RUN bunx tsup src/index.ts --format cjs --clean

FROM oven/bun:1-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app

COPY --from=builder /app/packages/signalling-server/package.json .
COPY --from=builder /app/packages/signalling-server/dist ./dist

RUN bun install --production && chown -R app:app /app

USER app

EXPOSE 8080
CMD ["bun", "dist/index.js"]
