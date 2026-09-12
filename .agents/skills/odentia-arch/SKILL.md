---
name: odentia-arch
description: Arquitectura tecnológica de odentIA. Usar para decidir stack, topología, storage S3 (MinIO local / R2 prod), adaptadores de canales y pagos, tenancy y runtime. Solo arquitectura tecnológica, no roadmap de producto.
---

# odentIA Arch

Skill de arquitectura tecnológica. La fuente de decisiones de producto vive en `local://dentalagent-requisitos-y-etapas.md`. Este skill solo fija tecnología y reglas estructurales.

## Cuándo usar

- Elegir o validar una dependencia, servicio o proveedor.
- Añadir un canal, pasarela, país, bucket o worker.
- Configurar dev local, variables de entorno o topología de despliegue.
- Revisar cualquier cambio que toque tenancy, agenda, pagos o archivos.

## Stack fijado

- Runtime: Node.js LTS + TypeScript + pnpm workspaces + Turborepo.
- Web: TanStack Start + Router + Query + Form. UI: shadcn/ui + Tailwind + lucide-react. Tablas: TanStack Table. Gráficos: TanStack Charts (colección shadcn disponible, misma familia que el resto del stack).
- API: Hono + Zod + Drizzle. Auth: Better Auth (identidad y membresías; permisos del dominio dental aparte).
- DB: PostgreSQL última estable al implementar, versión exacta pineada en infra (no `latest` mutable). Cola: PGMQ. Programación: pg_cron.
- Agenda visual: vista propia y responsive (web/tablet/móvil). FullCalendar como opción a evaluar, no como decisión.
- Documentos PDF: `@react-pdf/renderer` (componentes React, render en servidor). Odontograma: sin decisión.
- Tiempo real bandeja: SSE al navegador + `LISTEN/NOTIFY` como aviso entre procesos. El estado vive en PostgreSQL; al reconectar se recupera. Autorizar antes de publicar; nada clínico en el payload NOTIFY.
- Correo plataforma (registro, recuperación, invitaciones): SMTP. Correo de cada organización: adaptadores desacoplados por buzón (webhook de proveedor, API del buzón existente o MTA propio); la bandeja solo recibe mensajes normalizados. Candidatos: Resend, Cloudflare Email; Gmail/Microsoft por sus APIs sin tocar MX del cliente.
- Archivos: cliente S3-compatible único. Prod: Cloudflare R2. Dev local: MinIO. Buckets privados por defecto; acceso por URLs firmadas tras autorizar.
- Borde: Portless en dev/e2e (URLs con nombre, cero config); Caddy reservado para prod. Respaldo externo cifrado + recuperación a un punto en el tiempo (candidato: pgBackRest), restauración ensayada. Supervisión contenedores: systemd/Quadlet.
- Calidad: Podman, Vitest, Testcontainers, Playwright, Mailpit, GitHub Actions. Observabilidad: Sentry + Langfuse (no son la auditoría del negocio).

## Topología

```text
Web (TanStack Start) / Portal / Widget
        │
        ▼
API (Hono): auth, webhooks, REST/SSE
        │
        ▼
Servicios de negocio (CRM, agenda, pagos, permisos, países)
        │                    ▲
        ▼                    │
PostgreSQL ◄──────── Worker (pgmq + pg_cron + LangGraph)
  │                          │
  │                          ▼
  │                   Adaptadores canales/pagos/correo
  ▼
Object storage S3 (R2 prod / MinIO dev)
```

- Tres desplegables separables: web, API, worker. Mismo código de servicios de negocio.
- Una sola implementación de reserva de cita, usada por recepción, portal y agente.
- Modelo ejecuta LangGraph; servicios autorizan y ejecutan. Sin SQL directo del modelo, sin credenciales, sin fetch arbitrario.

## Objetos: uso y modularidad

Modular: un solo servicio de archivos con cliente S3. Mismo código en dev y prod; solo cambia a qué backend apunta (MinIO local / R2 prod). El dominio nunca importa SDK de un proveedor concreto.

- Uso: todo adjunto y documento pasa por el servicio; buckets privados por defecto; entrega mediante URL firmada de corta duración emitida tras autorizar membresía y ámbito.
- Dev: MinIO con el mismo layout de buckets que prod. Prod: R2.
- R2: los `location hints` son preferencia, no garantía de residencia.
- Cada objeto pertenece a una organización; esa pertenencia nunca sale de un dato enviado por el cliente.
- Validar tipo/tamaño en servidor; adjuntos externos = no confiables; definir escaneo antes de ingesta externa.
- Aislamiento también en búsquedas, cachés, exportaciones y memoria del agente.
- La definición concreta de servicios vive en `infra/dev/compose.yaml`; este skill no la duplica.

## Tenancy multisucursal (invariantes)

- Multi-tenant por organización (el concepto que ya maneja Better Auth). La organización es la frontera de aislamiento; la sucursal, la unidad operativa. No mezclar.
- Permisos por organización y sucursal desde membresía verificada; el contexto nunca sale de un id enviado por el cliente.
- Aislamiento aplicado en servidor y reforzado en base de datos; la app opera con privilegios mínimos.
- Paciente ≠ interlocutor ≠ tutor. Teléfono compartido no identifica paciente único.
- Soporte del proveedor sin acceso clínico general; acceso excepcional autorizado, temporal y auditado.
- Cada organización se sirve en su subdominio `<slug>` (dev: `<slug>.odentia.localhost`). El slug se resuelve en el borde a organización y se verifica contra la membresía; nunca se confía solo en el host.

## Agenda (invariante dura)
Reserva transaccional sobre profesional + recurso (sillón/consultorio) + rango temporal + zona horaria. Sin doble reserva aunque haya concurrencia, con protección a nivel de base de datos.

## Canales: uso y modularidad
Modular: separar canal (WhatsApp, Telegram, correo, widget) / adaptador de proveedor (Cloud API, OpenWA, Bot API...) / conexión (cuenta o número concreto de una organización). El CRM, la bandeja y el agente solo conocen el núcleo de conversaciones; nunca el SDK del proveedor.

- Uso: cada adaptador resuelve autenticación, recepción, envío, archivos, estados y firma de eventos, y declara qué capacidades tiene (plantillas, interactivos, hilos, lectura, edición). La bandeja muestra solo lo que el proveedor soporta.
- Añadir proveedor = nuevo adaptador + registro + pruebas de contrato. Sin reescribir bandeja/CRM/agenda.
- WhatsApp oficial = opción productiva preferente. OpenWA = adaptador separado, no oficial, con sesión propia y riesgo a evaluar antes de ofrecerlo.

## Pagos: uso y modularidad

Modular: el dominio (órdenes, suscripciones, estados propios + refs externas) no depende de ninguna pasarela; cada pasarela es un adaptador que declara capacidades (único, recurrente, devolución, monedas, alta de vendedores).

- Uso: verificar firma de webhooks, deduplicar eventos y confirmar el resultado contra el proveedor. La redirección del navegador no prueba pago. Ante resultado incierto, conciliar antes de reintentar; nunca reintentar en otra pasarela un cobro incierto.
- Dos libros separados aunque compartan adaptadores: org → proveedor SaaS vs paciente → organización. Cuentas, permisos, comprobantes e informes sin mezcla. Dinero de pacientes no es MRR.
- Migración de pasarela = coexistencia controlada; tokens y suscripciones pueden exigir transferencia segura o nueva autorización.
- Facturación electrónica = integración aparte de la pasarela, por país y por emisor.

## Países (Perú primero)

- Primer pack: Perú. Idioma, moneda y zona horaria por configuración de organización/sucursal, sin valores cableados en el núcleo.
- Reglas locales encapsuladas por país: documentos (RUC en PE), territorio (departamento/provincia/distrito/UBIGEO), formatos, monedas, impuestos, comprobantes, proveedores, datos personales y conservación clínica.
- Congelar moneda/reglas vigentes en cada documento/transacción. Cambiar config no reinterpreta histórico. Nuevo país = checklist (pagos, fiscalidad, contratos, datos, clínica) antes de activar.

## Dev local mínimo para etapa 1

Runtime + pnpm + PostgreSQL/extensiones + MinIO + Mailpit + correo transaccional + secretos. Corte de integración: dos tenants aislados, registro/verificación, invitaciones, permisos, tarea durable y notificación autorizada.

## Dev URLs: Portless (dev/e2e), Caddy solo prod

- Decisión: dev y e2e local usan Portless (`https://odentia.localhost`, `https://api.odentia.localhost` por servicio). Caddy queda solo para prod, cuando haya algo que desplegar.
- Por qué: cero config frente a Caddyfile, HTTPS local con CA propia, URLs estables entre reinicios (CORS, OAuth, `.env`, `baseURL` de Playwright no se rompen), un hostname por servicio (aísla cookies/storage) y por worktree (prefijo por rama). Más simple para dev y e2e, como pedía la revisión.
- Límites: pre-1.0 (pinnear versión exacta), exige Node 24+, bindea el 443 (pide elevación) y CA a confiar por máquina. Es solo dev: no sustituye a Caddy en prod (certificados públicos, hardening, config en repo).
- Solo para HTTP: web, API, consola MinIO (`:9001`), UI Mailpit (`:8025`) vía `portless alias`. Postgres (`:5432`), SMTP (`:1025`) y API S3 (`:9000`) siguen por puerto directo — un alias HTTPS contra un puerto TCP no-protocolo-HTTP no sirve.
- CI: decidir al crear el e2e si el runner usa Portless (necesita sudo + trust) o puertos directos; local siempre Portless.

## Referencias

- Decisiones de producto y etapas: `local://dentalagent-requisitos-y-etapas.md`
- PostgreSQL: https://www.postgresql.org/
- NOTIFY: https://www.postgresql.org/docs/current/sql-notify.html
- pgBackRest: https://pgbackrest.org/
- Caddy: https://github.com/caddyserver/caddy
- Resend SMTP: https://resend.com/docs/send-with-smtp
- Leaflet quickstart: https://leafletjs.com/examples/quick-start/
- FullCalendar license: https://fullcalendar.io/license
- R2 data location: https://developers.cloudflare.com/r2/reference/data-location/
