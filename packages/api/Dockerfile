# openagent.email API — built and run with Bun (no transpile step; src is TS).
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile || bun install --production

FROM oven/bun:1
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3100
CMD ["bun", "run", "src/main.ts"]
