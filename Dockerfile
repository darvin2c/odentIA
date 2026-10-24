# Receta compartida de producción para admin, panel, platform, latidIA, web, api y worker.
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
COPY apps/admin/package.json apps/admin/
COPY apps/dental-clinic/package.json apps/dental-clinic/
COPY apps/medical-clinic/package.json apps/medical-clinic/
COPY apps/web/package.json apps/web/
COPY packages/agent/package.json packages/agent/
COPY packages/auth/package.json packages/auth/
COPY packages/brand-scene/package.json packages/brand-scene/
COPY packages/channels/package.json packages/channels/
COPY packages/clinic-app/package.json packages/clinic-app/
COPY packages/clinical/package.json packages/clinical/
COPY packages/db/package.json packages/db/
COPY packages/dental/package.json packages/dental/
COPY packages/mail/package.json packages/mail/
COPY packages/medical/package.json packages/medical/
COPY packages/services/package.json packages/services/
COPY packages/ui/package.json packages/ui/
COPY packages/ui-patterns/package.json packages/ui-patterns/
COPY e2e/package.json e2e/
# Instalación filtrada: excluye e2e; conserva las dependencias necesarias
# para construir las aplicaciones web y ejecutar los paquetes fuente TS.
RUN pnpm install --frozen-lockfile \
  --filter @odentia/api... \
  --filter @odentia/worker... \
  --filter @odentia/panel... \
  --filter @odentia/admin... \
  --filter @odentia/dental-clinic... \
  --filter @odentia/medical-clinic... \
  --filter @odentia/web...

FROM deps AS build
COPY . .
# VITE_* se incrustan en build; deben coincidir con los dominios públicos.
# La web toma de VITE_BASE_DOMAIN su dirección canónica (el dominio raíz).
ARG VITE_API_URL
ARG VITE_BASE_DOMAIN
# Dónde abre una clínica de cada producto (odentIA y latidIA); vacíos, en VITE_BASE_DOMAIN.
ARG VITE_DENTAL_DOMAIN=""
ARG VITE_MEDICAL_DOMAIN=""
# El producto del panel de este artefacto: vacío, odentIA; `medical`, el de latidIA.
ARG VITE_PRODUCT=""
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_BASE_DOMAIN=$VITE_BASE_DOMAIN
ENV VITE_DENTAL_DOMAIN=$VITE_DENTAL_DOMAIN
ENV VITE_MEDICAL_DOMAIN=$VITE_MEDICAL_DOMAIN
ENV VITE_PRODUCT=$VITE_PRODUCT
RUN pnpm --filter @odentia/admin build && pnpm --filter @odentia/panel build && pnpm --filter @odentia/dental-clinic build \
  && pnpm --filter @odentia/medical-clinic build && pnpm --filter @odentia/web build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
CMD ["pnpm", "--filter", "@odentia/api", "start"]
