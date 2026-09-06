FROM node:22-alpine AS build
RUN corepack enable
ENV CI=true NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
RUN apk add --no-cache git
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @permguard/web run build

# `output: 'standalone'` in next.config.mjs is what keeps this stage small: Next
# traces the files actually imported and copies only those.
FROM node:22-alpine AS runtime
ENV NODE_ENV=production HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
