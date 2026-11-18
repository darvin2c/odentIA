# Receta de producción para la API, el worker y las migraciones. Las pantallas (webs, panel,
# administración y app de las clínicas) se publican en Cloudflare Workers desde el CI (ADR 0136-0138).
# OpenShip construye un artefacto por servicio; cada uno cambia su comando.

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches ./patches
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/panel/package.json apps/panel/
COPY admin/apps/web/package.json admin/apps/web/
COPY apps/dental-clinic/package.json apps/dental-clinic/
COPY apps/medical-clinic/package.json apps/medical-clinic/
COPY apps/optical-clinic/package.json apps/optical-clinic/
COPY apps/web/package.json apps/web/
COPY packages/agent/package.json packages/agent/
COPY packages/auth/package.json packages/auth/
COPY shared/packages/brand-scene/package.json shared/packages/brand-scene/
COPY shared/packages/channels/package.json shared/packages/channels/
COPY packages/clinic-app/package.json packages/clinic-app/
COPY packages/clinical/package.json packages/clinical/
COPY packages/db/package.json packages/db/
COPY packages/dental/package.json packages/dental/
COPY shared/packages/mail/package.json shared/packages/mail/
COPY packages/medical/package.json packages/medical/
COPY packages/optical/package.json packages/optical/
COPY packages/services/package.json packages/services/
COPY shared/packages/ui/package.json shared/packages/ui/
COPY shared/packages/ui-patterns/package.json shared/packages/ui-patterns/
COPY e2e/package.json e2e/
COPY admin/e2e/package.json admin/e2e/
# gestorIA no entra en esta imagen (tiene la suya, gestoria/Dockerfile), pero el lockfile la nombra.
COPY gestoria/apps/api/package.json gestoria/apps/api/
COPY gestoria/apps/web/package.json gestoria/apps/web/
COPY gestoria/packages/db/package.json gestoria/packages/db/
# Instalación filtrada: solo lo que necesitan la API y el worker para ejecutar los paquetes
# fuente TS (las migraciones viven en @odentia/db, que los dos usan).
RUN pnpm install --frozen-lockfile \
  --filter @odentia/api... \
  --filter @odentia/worker...

FROM deps AS build
COPY . .
# Producción no necesita las herramientas de build, prueba ni storybook (biome,
# turbo, TypeScript, rolldown...: más de la mitad de node_modules). Se podan sin
# red y sin volver a ejecutar scripts; lo que se ejecuta con `tsx` lo declara
# en `dependencies`. Mismos filtros que la instalación de arriba.
# scripts/smoke-image.sh (en CI) arranca cada servicio de la imagen podada.
RUN pnpm install --prod --frozen-lockfile --offline --ignore-scripts \
  --filter @odentia/api... \
  --filter @odentia/worker...

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
CMD ["pnpm", "--filter", "@odentia/api", "start"]
