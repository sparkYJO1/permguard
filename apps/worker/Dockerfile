# The build context is the repository root: this is a pnpm workspace and no app
# in it can be built without the packages it depends on. The whole workspace is
# copied rather than a hand-picked subset, because a partial workspace does not
# match the lockfile and `--frozen-lockfile` is worth more than a smaller layer.
FROM node:22-alpine AS build
RUN corepack enable
# pnpm asks before removing a modules directory and there is no terminal here to
# answer. Without this the install aborts with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY.
ENV CI=true
WORKDIR /app

# `nestjs-outbox` is a git dependency that builds itself through its `prepare`
# script — pnpm 10 runs that only for packages listed in `onlyBuiltDependencies`
# in pnpm-workspace.yaml, and needs git to fetch it in the first place.
RUN apk add --no-cache git
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @permguard/worker... run build

FROM node:22-alpine AS runtime
RUN corepack enable
ENV NODE_ENV=production CI=true
WORKDIR /app
COPY --from=build /app ./
EXPOSE 3910
CMD ["node", "apps/worker/dist/main.js"]
