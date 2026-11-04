---
name: odentia-arch
description: Arquitectura de odentIA. Usar al cambiar stack, topología, tenancy, runtime, almacenamiento S3 o adaptadores de canales y pagos. No es roadmap de producto.
---

# Arquitectura de odentIA

Objetivos y restricciones globales: `AGENTS.md` raíz. Límites de aplicaciones/paquetes: sus AGENTS. Operación local: `docs/development.md`. Rutas relativas a la raíz del repositorio; no depender de artefactos privados de una sesión.

## Método

1. Identificar frontera afectada y leer su contrato y consumidores con LSP.
2. Reutilizar el servicio/adaptador existente; separar reglas de negocio de transporte y proveedor.
3. Comprobar aislamiento por organización, autorización, concurrencia e idempotencia de efectos.
4. Si cambia una decisión duradera con alternativas reales, usar `docs/decisions/README.md`; no crear ADR para una modificación rutinaria.
5. Ejecutar la integración afectada. Distinguir proveedor real, respuesta controlada y simulación en la evidencia.

## Stack y topología

- Node >=24, TypeScript strict, pnpm workspaces y Turbo. Versiones exactas: manifiestos y lockfile, no duplicarlas aquí.
- Web: TanStack Start/Router/Query/Form, Tailwind, shadcn/ui y lucide-react. Composición propia en `ui-patterns`; gráficos encapsulados en `ui`/`ui-patterns`.
- API: Hono, Zod, Drizzle; identidad/membresías mediante Better Auth y permisos canónicos del repo.
- PostgreSQL con RLS, PGMQ y pg_cron. API y worker ejecutan los mismos servicios; el modelo usa herramientas autorizadas, nunca SQL directo.
- SSE navegador y LISTEN/NOTIFY entre procesos: aviso mínimo, estado persistido en PostgreSQL y conciliación al reconectar.
- Dev/E2E con Portless; PostgreSQL, SMTP y API S3 usan sus puertos de protocolo. SSR local mediante `scripts/local-network.mjs`.
- RustFS en local (`infra/dev/compose.yaml`; MinIO se archivó en 2026) y contrato S3-compatible; R2 para almacenamiento productivo. OpenShip administra el borde HTTPS del VPS compartido. El Compose de odentIA conserva rutas estándar y su PostgreSQL independiente; operación y gate de CI en `docs/deployment.md`.

## Fronteras que revisar

- **Tenancy:** organización como aislamiento, sucursal como unidad operativa. Resolver organización y verificar membresía; un host o id del cliente por sí solo no autoriza. Aislar también cachés, búsquedas, archivos, exportaciones y memoria.
- **Archivos:** buckets privados; autorización antes de URL firmada de corta duración. Dominio sin SDK del proveedor. Validar tamaño/tipo; adjuntos externos no confiables. Localización preferida de R2 no garantiza residencia.
- **Canales:** separar canal, proveedor y conexión de organización. Adaptadores declaran capacidades y normalizan eventos/estados; añadir proveedor no reescribe CRM o agenda.
- **Correo:** SMTP transaccional de plataforma distinto de buzones de organización. OAuth requiere configuración y permisos reales; no tocar MX como requisito implícito.
- **Pagos:** separar paciente→organización de organización→SaaS. Webhooks autenticados/deduplicados; redirección no acredita pago. Conciliar resultado incierto antes de reintentar. Facturación electrónica es otra integración, por país/emisor; no afirmar cobros en línea implementados por documentar el contrato.
- **País:** idioma, moneda y zona horaria por configuración; no reinterpretar históricos al cambiarla. Reglas nacionales encapsuladas y procedencia clínica conservada.

No introducir proveedores, servicios o abstracciones por previsión. Confirmar implementación y necesidad antes de ampliar el stack.
