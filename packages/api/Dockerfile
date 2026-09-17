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
# 只把数据目录交给 bun（uid 1000）；可执行件保持 root 所有，bun 只读执行（去掉 -R 与 /app 整树）
RUN mkdir -p /app/data && chown bun:bun /app/data
USER bun
EXPOSE 3100
CMD ["bun", "dist/main.js"]
