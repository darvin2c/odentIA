import type { Auth } from "@odentia/auth"
import { type Db, sendDemoTask, withOrgContext } from "@odentia/db"
import { message } from "@odentia/db/schema/crm"
import { auditEvent, branch, orgProfile } from "@odentia/db/schema/org"
import type { MailboxEnv, Storage } from "@odentia/services"
import { and, eq, gt, inArray, sql } from "drizzle-orm"
import { type Context, Hono } from "hono"
import { cors } from "hono/cors"
import { requestId } from "hono/request-id"
import { streamSSE } from "hono/streaming"
import postgres from "postgres"
import { z } from "zod"
import { canAccess, orgContextOf, requireOrgContext, requireSession } from "./lib/context.js"
import { errorBody } from "./lib/error.js"
import { createAgentRoute } from "./routes/agent.js"
import { createAgendaRoute, createAppointmentsRoute } from "./routes/appointments.js"
import { createCie10Route } from "./routes/cie10.js"
import { createConnectionsRoute } from "./routes/connections.js"
import { createContactsRoute } from "./routes/contacts.js"
import { createConversationsRoute } from "./routes/conversations.js"
import { createFieldsRoute } from "./routes/fields.js"
import { createPatientRegistrationRoute } from "./routes/patient-registration.js"
import { createPatientsRoute } from "./routes/patients.js"
import { createPipelinesRoute } from "./routes/pipelines.js"
import {
  createPublicPatientRegistrationRoute,
  type RegistrationRemoteAddress,
} from "./routes/public-patient-registration.js"
import { createServicesRoute } from "./routes/services.js"
import { createTasksRoute } from "./routes/tasks.js"
import { createWebhooksRoute } from "./routes/webhooks.js"
import { createWorkspaceRoute } from "./routes/workspace.js"
import { createInventoryRoute } from "./routes/inventory.js"
import { createOpportunitiesRoute } from "./routes/opportunities.js"
import { createAgentKnowledgeRoute } from "./routes/agent-knowledge.js"
import { createAgentOpsRoute } from "./routes/agent-ops.js"
import { createFinanceRoute } from "./routes/finance.js"
import { createAutomationsRoute, createPublicAutomationsRoute } from "./routes/automations.js"
import { createClinicalFormsRoute } from "./routes/clinical-forms.js"
import { createPortalRoute } from "./routes/portal.js"
import { createPublicPortalRoute } from "./routes/public-portal.js"
import { createWebchatPublicRoute, createWebchatAdminRoute } from "./routes/webchat.js"
import { createMailboxesRoute } from "./routes/mailboxes.js"

export interface AppDeps {
  auth: Auth
  db: Db
  /**
   * Rol owner (bypasea RLS): USO LIMITADO a rutas webhook — leer la conexión
   * por id sin org, ledger de dedupe y encolado. Nunca datos de tenant.
   */
  ownerDb: Db
  /** Clave AES-256-GCM para configs de conexión (SECRETS_KEY). */
  secretsKey: Buffer
  storage: Storage
  /** CHANNEL_VALIDATE_EXTERNAL !== 'false': validar contra el proveedor real. */
  validateExternal: boolean
  /** Base pública del API para webhookUrl (BETTER_AUTH_URL). */
  webhookBaseUrl: string
  trustedOrigins: string[]
  cookieDomain: string
  webURL: string
  /** Conexión dedicada LISTEN (postgres.js crudo). */
  listenUrl: string
  registrationRemoteAddress?: RegistrationRemoteAddress
  agentModelName?: string
  llmApiKey?: string
  llmBaseUrl?: string
  mailbox?: MailboxEnv
}
const branchInput = z.object({
  name: z.string().min(1).max(120),
  addressLine1: z.string().max(200).nullish(),
  addressLine2: z.string().max(200).nullish(),
  department: z.string().max(80).nullish(),
  province: z.string().max(80).nullish(),
  district: z.string().max(80).nullish(),
  ubigeo: z.string().length(6).nullish(),
  phone: z.string().max(30).nullish(),
  email: z.string().email().nullish(),
  mapsUrl: z.string().url().nullish(),
  // `null` = hereda la zona horaria de la organización (columna nullable).
  timezone: z.string().max(60).nullish(),
})

const branchPatch = branchInput.partial()

const orgProfileInput = z.object({
  legalName: z.string().min(1).max(200),
  tradeName: z.string().max(200).optional(),
  fiscalDocType: z.string().max(20).optional(),
  fiscalDocNumber: z.string().max(20).optional(),
  billingEmail: z.string().email().optional(),
  fiscalAddress: z.string().max(300).optional(),
  countryCode: z.string().length(2).optional(),
  currency: z.string().length(3).optional(),
  timezone: z.string().max(60).optional(),
  locale: z.string().max(20).optional(),
})

const demoTaskInput = z.object({
  message: z.string().min(1).max(200),
})

interface NotifyPayload {
  orgId: string
  kind: string
  taskId?: string | number
  conversationId?: string
  messageId?: string
  at: string
}

type AuditRow = typeof auditEvent.$inferSelect

/**
 * Reconstruye el payload SSE desde una fila de audit_event (replay).
 * Nunca expone contenido: solo referencias (mismo invariante que NOTIFY).
 */
async function toReplayPayload(
  db: Db,
  orgId: string,
  event: AuditRow,
): Promise<NotifyPayload | null> {
  const at = event.createdAt.toISOString()
  if (event.action === "demo_task.done") {
    return { orgId, kind: "demo_task.done", taskId: event.entityId ?? "", at }
  }
  if (event.action === "message.created" || event.action === "message.updated") {
    if (!event.entityId) return null
    const found = await withOrgContext(db, orgId, (tx) =>
      tx
        .select({ conversationId: message.conversationId })
        .from(message)
        .where(and(eq(message.id, event.entityId as string), eq(message.organizationId, orgId)))
        .limit(1),
    )
    const conversationId = found[0]?.conversationId
    if (!conversationId) return null
    return { orgId, kind: event.action, conversationId, messageId: event.entityId, at }
  }
  if (event.action === "conversation.updated") {
    if (!event.entityId) return null
    return { orgId, kind: "conversation.updated", conversationId: event.entityId, at }
  }
  return null
}

export function createApp(deps: AppDeps) {
  const { auth, db } = deps
  // El puerto es opcional: prod sirve en 443 (sin puerto en Origin) y el
  // harness e2e expone el proxy en :4463.
  const tenantOrigin = new RegExp(
    `^https://[a-z0-9-]+\\.${deps.cookieDomain.replaceAll(".", "\\.")}(:\\d+)?$`,
  )

  const app = new Hono()

  app.use("*", requestId())
  app.use(
    "*",
    cors({
      origin: (origin) =>
        deps.trustedOrigins.includes(origin) || tenantOrigin.test(origin) ? origin : "",
      credentials: true,
    }),
  )

  app.onError((err, c) => {
    console.error(err)
    return c.json(errorBody(c, "INTERNAL", "Error interno"), 500)
  })
  app.notFound((c) => c.json(errorBody(c, "NOT_FOUND", "Recurso no encontrado"), 404))

  app.get("/health", async (c) => {
    await db.execute(sql`select 1`)
    return c.json({ ok: true })
  })

  // Subdominios reservados: nunca son slugs de tenant (colisionarían con app./api./www.).
  const RESERVED_SLUGS: Record<string, true> = { api: true, app: true, www: true }
  app.use("/api/auth/organization/create", async (c, next) => {
    if (c.req.method !== "POST") return next()
    const body = (await c.req.raw
      .clone()
      .json()
      .catch(() => null)) as { slug?: unknown } | null
    const slug = typeof body?.slug === "string" ? body.slug : ""
    if (RESERVED_SLUGS[slug]) {
      return c.json(errorBody(c, "RESERVED_SLUG", "Ese subdominio está reservado"), 400)
    }
    return next()
  })

  // Better Auth: montado ANTES de los guards.
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))

  app.route(
    "/api/public/patient-registration",
    createPublicPatientRegistrationRoute({
      db: deps.db,
      remoteAddress: deps.registrationRemoteAddress,
    }),
  )
  app.route("/api/public/portal", createPublicPortalRoute({ db, ownerDb: deps.ownerDb, storage: deps.storage }))
  app.route("/api/public/automations", createPublicAutomationsRoute({ db, ownerDb: deps.ownerDb }))
  app.route("/api/webchat", createWebchatPublicRoute({ ownerDb: deps.ownerDb, db, secretsKey: deps.secretsKey, cookieDomain: deps.cookieDomain }))
  app.route("/api/mail", createMailboxesRoute({ auth, db, ownerDb: deps.ownerDb, secretsKey: deps.secretsKey, webUrl: deps.webURL, mailbox: deps.mailbox ?? {} }))

  // Rutas de usuario (sin contexto de organización).
  const userScoped = new Hono()
  userScoped.use("*", requireSession(deps))

  const AVATAR_MIME: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
  }
  const AVATAR_MAX_BYTES = 2 * 1024 * 1024

  userScoped.post("/uploads/avatar", async (c) => {
    const form = await c.req.formData().catch(() => null)
    const file = form?.get("file")
    if (!(file instanceof File)) {
      return c.json(errorBody(c, "VALIDATION", "Adjunta un archivo"), 400)
    }
    const ext = AVATAR_MIME[file.type]
    if (!ext) {
      return c.json(errorBody(c, "VALIDATION", "Solo se admiten PNG, JPG o WebP"), 400)
    }
    if (file.size > AVATAR_MAX_BYTES) {
      return c.json(errorBody(c, "VALIDATION", "La imagen no puede superar 2 MB"), 400)
    }
    const userId = (c as Context).get("userId") as string
    const previousImage = (c as Context).get("userImage") as string | null
    const { url } = await deps.storage.putAvatar({
      userId,
      body: Buffer.from(await file.arrayBuffer()),
      contentType: file.type,
      ext,
    })
    if (previousImage) {
      await deps.storage.deleteByUrl(previousImage).catch(() => {})
    }
    return c.json({ data: { url } }, 201)
  })

  // Webhooks de proveedor ANTES que los routers con guards: el use("*") de
  // userScoped/guarded también casa /api/webhooks/* y respondería 401.
  app.route(
    "/api/webhooks",
    createWebhooksRoute({ ownerDb: deps.ownerDb, db: deps.db, secretsKey: deps.secretsKey }),
  )

  app.route("/api", userScoped)

  // Guards para el resto de /api/*.
  const guarded = new Hono()
  // Los webhooks del proveedor viven bajo /api/webhooks pero son públicos
  // (firma HMAC/secret-token): `use("*")` también los alcanza, se salta aquí.
  const isWebhook = (c: Context) =>
    c.req.path.startsWith("/api/webhooks/") || c.req.path.startsWith("/webhooks/")
  guarded.use("*", async (c, next) => {
    if (isWebhook(c)) return next()
    return requireSession(deps)(c, next)
  })
  guarded.use("*", async (c, next) => {
    if (isWebhook(c)) return next()
    return requireOrgContext(deps)(c, next)
  })

  function validationError(c: Context, issues: z.ZodIssue[]) {
    return c.json(errorBody(c, "VALIDATION", issues[0]?.message ?? "Datos inválidos"), 400)
  }

  guarded.get("/org-profile", async (c) => {
    const { orgId } = orgContextOf(c)
    const row = await withOrgContext(db, orgId, async (tx) => {
      const [found] = await tx
        .select()
        .from(orgProfile)
        .where(eq(orgProfile.organizationId, orgId))
        .limit(1)
      return found ?? null
    })
    return c.json({ data: row })
  })

  guarded.put("/org-profile", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para editar el perfil"), 403)
    }
    const parsed = orgProfileInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const input = parsed.data

    const row = await withOrgContext(db, orgId, async (tx) => {
      const [upserted] = await tx
        .insert(orgProfile)
        .values({ organizationId: orgId, ...input })
        .onConflictDoUpdate({
          target: orgProfile.organizationId,
          set: { ...input, updatedAt: new Date() },
        })
        .returning()
      await tx.insert(auditEvent).values({
        organizationId: orgId,
        actorUserId: userId,
        action: "org_profile.upsert",
        entity: "org_profile",
        entityId: orgId,
        metadata: input,
      })
      return upserted
    })
    return c.json({ data: row })
  })

  guarded.get("/branches", async (c) => {
    const { orgId } = orgContextOf(c)
    const rows = await withOrgContext(db, orgId, (tx) =>
      tx.select().from(branch).where(eq(branch.organizationId, orgId)).orderBy(branch.name),
    )
    return c.json({ data: rows })
  })

  guarded.post("/branches", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para crear sucursales"), 403)
    }
    const parsed = branchInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)

    const row = await withOrgContext(db, orgId, async (tx) => {
      const [created] = await tx
        .insert(branch)
        .values({ organizationId: orgId, ...parsed.data })
        .returning()
      await tx.insert(auditEvent).values({
        organizationId: orgId,
        actorUserId: userId,
        action: "branch.create",
        entity: "branch",
        entityId: created.id,
        metadata: parsed.data,
      })
      return created
    })
    return c.json({ data: row }, 201)
  })

  guarded.patch("/branches/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para editar sucursales"), 403)
    }
    const id = c.req.param("id")
    const parsed = branchPatch.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)

    const row = await withOrgContext(db, orgId, async (tx) => {
      const [updated] = await tx
        .update(branch)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(and(eq(branch.id, id), eq(branch.organizationId, orgId)))
        .returning()
      if (updated) {
        await tx.insert(auditEvent).values({
          organizationId: orgId,
          actorUserId: userId,
          action: "branch.update",
          entity: "branch",
          entityId: id,
          metadata: parsed.data,
        })
      }
      return updated ?? null
    })
    if (!row) return c.json(errorBody(c, "NOT_FOUND", "Sucursal no encontrada"), 404)
    return c.json({ data: row })
  })

  guarded.delete("/branches/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para desactivar sucursales"), 403)
    }
    const id = c.req.param("id")
    const row = await withOrgContext(db, orgId, async (tx) => {
      const [updated] = await tx
        .update(branch)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(branch.id, id), eq(branch.organizationId, orgId)))
        .returning({ id: branch.id })
      if (updated) {
        await tx.insert(auditEvent).values({
          organizationId: orgId,
          actorUserId: userId,
          action: "branch.deactivate",
          entity: "branch",
          entityId: id,
        })
      }
      return updated ?? null
    })
    if (!row) return c.json(errorBody(c, "NOT_FOUND", "Sucursal no encontrada"), 404)
    return c.json({ data: row })
  })

  guarded.post("/demo/tasks", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = demoTaskInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const taskId = await sendDemoTask(db, {
      orgId,
      userId,
      message: parsed.data.message,
      requestedAt: new Date().toISOString(),
    })
    return c.json({ taskId }, 202)
  })

  guarded.get("/notifications/stream", async (c) => {
    const { orgId } = orgContextOf(c)
    const lastEventId = c.req.header("last-event-id")

    return streamSSE(c, async (stream) => {
      // Replay: solo si llega Last-Event-ID; si no, estrictamente en vivo.
      if (lastEventId) {
        const missed = await withOrgContext(db, orgId, (tx) =>
          tx
            .select()
            .from(auditEvent)
            .where(
              and(
                eq(auditEvent.organizationId, orgId),
                inArray(auditEvent.action, [
                  "demo_task.done",
                  "message.created",
                  "message.updated",
                  "conversation.updated",
                ]),
                gt(auditEvent.createdAt, new Date(lastEventId)),
              ),
            )
            .orderBy(auditEvent.createdAt),
        )
        for (const event of missed) {
          const replay = await toReplayPayload(db, orgId, event)
          if (!replay) continue
          await stream.writeSSE({
            id: event.createdAt.toISOString(),
            event: replay.kind,
            data: JSON.stringify(replay),
          })
        }
      }

      const listener = postgres(deps.listenUrl, { max: 1 })
      // NOTIFY nunca lleva datos clínicos: solo orgId/kind/taskId/at.
      const { unlisten } = await listener.listen("org_events", async (raw) => {
        let payload: NotifyPayload
        try {
          payload = JSON.parse(raw) as NotifyPayload
        } catch {
          return
        }
        if (payload.orgId !== orgId) return
        await stream.writeSSE({
          id: payload.at,
          event: payload.kind,
          data: JSON.stringify(payload),
        })
      })

      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: "ping", data: "" }).catch(() => undefined)
      }, 15_000)

      // Mantener el stream abierto hasta abort; cleanup en un solo handler.
      const done = Promise.withResolvers<void>()
      stream.onAbort(() => {
        clearInterval(heartbeat)
        void unlisten().then(() => listener.end())
        done.resolve()
      })
      await done.promise
    })
  })

  const crmDeps = {
    db: deps.db,
    secretsKey: deps.secretsKey,
    storage: deps.storage,
    validateExternal: deps.validateExternal,
    webhookBaseUrl: deps.webhookBaseUrl,
  }
  guarded.route(
    "/",
    createPatientRegistrationRoute({ ...crmDeps, cookieDomain: deps.cookieDomain, webURL: deps.webURL }),
  )
  guarded.route("/conversations", createConversationsRoute(crmDeps))
  guarded.route("/contacts", createContactsRoute(crmDeps))
  guarded.route("/patients", createPatientsRoute(crmDeps))
  guarded.route("/services", createServicesRoute(crmDeps))
  guarded.route("/cie10", createCie10Route(crmDeps))
  guarded.route("/pipelines", createPipelinesRoute(crmDeps))
  guarded.route("/channels/connections", createConnectionsRoute(crmDeps))
  guarded.route("/agent", createAgentRoute(crmDeps))
  guarded.route("/tasks", createTasksRoute(crmDeps))
  guarded.route("/agenda", createAgendaRoute(crmDeps))
  guarded.route("/appointments", createAppointmentsRoute(crmDeps))
  guarded.route("/fields", createFieldsRoute(crmDeps))
  guarded.route("/workspace", createWorkspaceRoute(crmDeps))
  guarded.route("/inventory", createInventoryRoute(crmDeps))
  guarded.route("/opportunities", createOpportunitiesRoute(crmDeps))
  guarded.route("/agent/knowledge", createAgentKnowledgeRoute(crmDeps))
  guarded.route("/agent", createAgentOpsRoute({ ...crmDeps, defaultModelName: deps.agentModelName, llmApiKey: deps.llmApiKey, llmBaseUrl: deps.llmBaseUrl }))
  guarded.route("/finance", createFinanceRoute(crmDeps))
  guarded.route("/automations", createAutomationsRoute(crmDeps))
  guarded.route("/clinical-forms", createClinicalFormsRoute(crmDeps))
  guarded.route("/portal", createPortalRoute({ db, webURL: deps.webURL, cookieDomain: deps.cookieDomain }))
  guarded.route("/channels/webchat", createWebchatAdminRoute(crmDeps))
  app.route("/api", guarded)
  return app
}
