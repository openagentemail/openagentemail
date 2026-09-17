# openagent.email API — build the canonical dist artifact, then ship only it.
FROM oven/bun:1 AS production-deps
WORKDIR /app
# 强制要求 bun.lock 存在；缺失则 COPY 直接失败（fail-closed）
COPY package.json bun.lock ./
# 仅 frozen-lockfile：漂移即红，不静默降级
RUN bun install --production --frozen-lockfile

FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# 数据目录属主交给 oven/bun 自带的 bun 用户（uid/gid 1000）；既有卷须部署窗先 chown
RUN mkdir -p /app/data && chown -R bun:bun /app
USER bun
EXPOSE 3100
CMD ["bun", "dist/main.js"]
