# La imagen del servidor de gestorIA y sus migraciones (ADR 0203), aparte de la de las clínicas:
# solo instala lo que necesitan `@gestoria/api` y `@gestoria/db`. Se arma desde la raíz del
# repositorio (`docker build -f gestoria/Dockerfile .`), porque usa el mismo lockfile.

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile --filter @gestoria/api... --filter @gestoria/db...
# Sin herramientas de build ni de prueba: lo que corre con `tsx` está en `dependencies`.
RUN pnpm install --prod --frozen-lockfile --offline --ignore-scripts --filter @gestoria/api... --filter @gestoria/db...

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
CMD ["pnpm", "--filter", "@gestoria/api", "start"]
