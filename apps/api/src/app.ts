import type { PlatformDecisions, PlatformLlm } from "@odentia/agent"
import type { Auth } from "@odentia/auth"
import { type Db, withOrgContext } from "@odentia/db"
import { message } from "@odentia/db/schema/crm"
import { auditEvent, branch, orgProfile } from "@odentia/db/schema/org"
import type { Mailer } from "@odentia/mail"
import { CLINIC_LOGO_MAX_BYTES, CLINIC_LOGO_MIME_EXT, clinicLogoFolder, getClinicLogo, RESERVED_ORG_SLUGS, setClinicLogo } from "@odentia/services"
import { assertSaasBranchAvailable, configurePublicLinks, CONVERSATION_STATE_ACTIONS, getBackofficeOverview, getOrganizationBillingSummary, initialOrgRegion, setOrgDiagnosisSystem, type MailboxEnv, regionPresetForCountry, type SearchEmbedder, ServiceError, setBranchActive, startSaasTrial, type Storage, ensureLibrarySpecialties, turnOnNewClinicLines, updateOrgRegion } from "@odentia/services"
import { and, eq, gt, inArray, sql } from "drizzle-orm"
import { type Context, Hono } from "hono"
import { cors } from "hono/cors"
import { requestId } from "hono/request-id"
import { streamSSE } from "hono/streaming"
import postgres from "postgres"
import { z } from "zod"
import { canAccess, orgContextOf, requireOrgContext, requireSession } from "./lib/context.js"
import { errorBody } from "./lib/error.js"
import { adminContextOf, requireAdminContext } from "./lib/admin-context.js"
import { createAdminCoreRoute, createAccountAdminAccessRoute, createAdminFactorBoundary } from "./routes/admin-core.js"
import { createAccountRoute } from "./routes/account.js"
import { createAdminOrganizationsRoute } from "./routes/admin-organizations.js"
import { createAccountBillingRoute, createSaasBillingRoute, createSaasPreAuthGuard, requireSaasAccess } from "./routes/saas-billing.js"
import { createAdminSupportRoute } from "./routes/admin-support.js"
import { createAdminConsumerComplaintsRoute } from "./routes/admin-consumer-complaints.js"
import { createAdminFoundersRoute } from "./routes/admin-founders.js"
import { createAccountSupportRoute } from "./routes/account-support.js"
import { createAgentRoute } from "./routes/agent.js"
import { createAgentAdminRoute } from "./routes/agent-admin.js"
import { createAgentKnowledgeRoute } from "./routes/agent-knowledge.js"
import { createHelpRoute } from "./routes/help.js"
import { createAgentLearningRoute } from "./routes/agent-learning.js"
import { createAgentOpsRoute } from "./routes/agent-ops.js"
import { createAgendaRoute, createAppointmentsRoute } from "./routes/appointments.js"
import { createSearchRoute } from "./routes/search.js"
import { createPublicAutomationsRoute } from "./routes/automations.js"
import { createDiagnosisCodesRoute } from "./routes/diagnosis-codes.js"
import { createClinicalFormsRoute } from "./routes/clinical-forms.js"
import { createConnectionsRoute } from "./routes/connections.js"
import { createContactsRoute } from "./routes/contacts.js"
import { createConversationsRoute } from "./routes/conversations.js"
import { createCrmWorkspaceRoute } from "./routes/crm-workspace.js"
import { createFieldsRoute } from "./routes/fields.js"
import { createFinanceRoute } from "./routes/finance.js"
import { createFinancialDocumentsRoute } from "./routes/financial-documents.js"
import { createInventoryRoute } from "./routes/inventory.js"
import { createCommissionsRoute } from "./routes/commissions.js"
import { runService } from "./routes/helpers.js"
import { createMailboxesRoute } from "./routes/mailboxes.js"
import { createOpportunitiesRoute } from "./routes/opportunities.js"
import { createPatientRegistrationRoute } from "./routes/patient-registration.js"
import { createPatientsRoute } from "./routes/patients.js"
import { createPeopleRoute } from "./routes/people.js"
import { createPaymentMethodsRoute } from "./routes/payment-methods.js"
import { createPromotionsRoute } from "./routes/promotions.js"
import { createPipelinesRoute } from "./routes/pipelines.js"
import { createPortalRoute } from "./routes/portal.js"
import {
  createPublicPatientRegistrationRoute,
  type RegistrationRemoteAddress,
} from "./routes/public-patient-registration.js"
import { createPublicBookingRoute } from "./routes/public-booking.js"
import { createPublicConsumerComplaintsRoute } from "./routes/public-consumer-complaints.js"
import { createPublicFoundersRoute } from "./routes/public-founders.js"
import { createPublicPortalRoute } from "./routes/public-portal.js"
import { createLegalRoute } from "./routes/legal.js"
import { createPublicSignUpRoute } from "./routes/public-sign-up.js"
import { createServicesRoute } from "./routes/services.js"
import { createTasksRoute } from "./routes/tasks.js"
import { createWebchatAdminRoute, createWebchatPublicRoute } from "./routes/webchat.js"
import { createWebhooksRoute } from "./routes/webhooks.js"
import { createWhatsAppSignupRoute, type MetaSignupConfig } from "./routes/whatsapp-signup.js"
import { createReportsRoute } from "./routes/reports.js"
import { createWorkspaceRoute } from "./routes/workspace.js"

export interface AppDeps {
  auth: Auth
  db: Db
  /**
   * Rol owner: webhooks y operaciones internas explícitamente autorizadas.
   * Las rutas clínicas siguen usando db + withOrgContext, nunca esta conexión.
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
  adminURL: string
  mailer: Mailer
  /** Correo de odentIA que recibe el aviso de cada hoja del Libro de Reclamaciones (COMPLAINTS_EMAIL). */
  complaintsEmail?: string | undefined
  /** Buzón que lee las respuestas a los correos de Fundadores (FOUNDERS_EMAIL). */
  foundersEmail?: string | undefined
  /** Conexión dedicada LISTEN (postgres.js crudo). */
  listenUrl: string
  registrationRemoteAddress?: RegistrationRemoteAddress
  /** Cuenta de odentIA en el proveedor del modelo (LLM_*); la organización no elige ni trae la suya. */
  llm?: PlatformLlm
  /** Credenciales de plataforma de los modelos de decisión (JEV_*, OPENAI_DECISIONS_*). */
  decisions?: PlatformDecisions
  /** Quien vectoriza para la búsqueda por significado (EMBEDDINGS_*); sin él, por palabras. */
  embedder?: SearchEmbedder
  mailbox?: MailboxEnv
  /** La app de odentIA en Meta (META_*): «Conectar con Facebook» de WhatsApp. Sin ella no hay botón. */
  metaSignup?: MetaSignupConfig | undefined
}
const branchInput = z.object({
  name: z.string().min(1).max(120),
  addressLine1: z.string().max(200).nullish(),
  addressLine2: z.string().max(200).nullish(),
  department: z.string().max(80).nullish(),
  province: z.string().max(80).nullish(),
  district: z.string().max(80).nullish(),
  phone: z.string().max(30).nullish(),
  email: z.string().email().nullish(),
  mapsUrl: z.string().url().nullish(),
  // `null` = hereda la zona horaria de la organización (columna nullable).
  timezone: z.string().max(60).nullish(),
})

const branchPatch = branchInput.partial()

const orgProfileInput = z.object({
  legalName: z.string().min(1).max(200),
  // El nombre que ve la persona en todo (decisión 19): obligatorio; ausente, queda como estaba.
  tradeName: z.string().trim().min(1, "Escribe el nombre comercial: así te verán tus pacientes").max(200).optional(),
  fiscalDocType: z.string().max(20).nullish(),
  fiscalDocNumber: z.string().max(20).nullish(),
  fiscalAddress: z.string().max(300).nullish(),
  // Teléfono para urgencias (ADR 0050), en E.164 como lo entrega el campo de teléfono.
  emergencyPhone: z.string().regex(/^\+[1-9]\d{7,14}$/, "Ingresa el teléfono con su código de país, empezando por «+»").nullish(),
  countryCode: z.string().length(2).optional(),
  currency: z.string().length(3).optional(),
  timezone: z.string().max(60).optional(),
  locale: z.string().max(100).optional(),
  receiptWidth: z.enum(["58", "80"]).optional(),
  sheetSize: z.enum(["A4", "Letter"]).optional(),
  ticketFooter: z.string().trim().min(1).max(280).optional(),
  applyCountryPreset: z.boolean().optional(),
})

/** Lo que se imprime: se edita en «Medios de pago y ticket», aparte de los datos de la clínica. */
const orgPrintingInput = z.object({
  receiptWidth: z.enum(["58", "80"]),
  sheetSize: z.enum(["A4", "Letter"]),
  ticketFooter: z.string().trim().min(1, "Escribe la frase al pie del ticket").max(280),
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
  // Cerrar, reabrir, tomar o devolver también cambian la conversación: se avisan igual.
  if ((CONVERSATION_STATE_ACTIONS as readonly string[]).includes(event.action)) {
    if (!event.entityId) return null
    return { orgId, kind: "conversation.updated", conversationId: event.entityId, at }
  }
  return null
}

export function createApp(deps: AppDeps) {
  const { auth, db } = deps
  // «Su enlace» de cada persona vive en el subdominio de su clínica: los
  // mensajes y las plantillas de WhatsApp que lo llevan leen esta dirección.
  configurePublicLinks({ webURL: deps.webURL, cookieDomain: deps.cookieDomain })
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

  // Una página de una clínica no puede usar la cookie compartida para operar
  // el backoffice. SSR solo reenvía cookies para lecturas sin Origin.
  const adminOrigin = new URL(deps.adminURL).origin
  app.use("/api/admin/*", async (c, next) => {
    const origin = c.req.header("origin")
    const readOnly = c.req.method === "GET" || c.req.method === "HEAD"
    if ((origin && origin !== adminOrigin) || (!readOnly && origin !== adminOrigin)) {
      return c.json(errorBody(c, "ADMIN_ORIGIN_REQUIRED", "Abre esta operación desde la administración de odentIA"), 403)
    }
    c.header("Cache-Control", "no-store")
    await next()
  })

  app.onError((err, c) => {
    if (err instanceof ServiceError) return c.json(errorBody(c, err.code, err.message), err.status)
    console.error(err)
    return c.json(errorBody(c, "INTERNAL", "Error interno"), 500)
  })
  app.notFound((c) => c.json(errorBody(c, "NOT_FOUND", "Recurso no encontrado"), 404))

  app.get("/health", async (c) => {
    await db.execute(sql`select 1`)
    return c.json({ ok: true })
  })

  // Subdominios reservados: nunca son slugs de tenant (la lista vive en services).
  const RESERVED_SLUGS = RESERVED_ORG_SLUGS
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

  app.use("/api/auth/organization/*", createSaasPreAuthGuard(deps))
  app.use("/api/auth/*", createAdminFactorBoundary(deps))

  // Better Auth: montado ANTES de los guards.
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))

  app.use("/api/admin/*", requireAdminContext(deps))
  app.route("/api/admin/access", createAdminCoreRoute(deps))
  app.route("/api/admin/organizations", createAdminOrganizationsRoute({
    ...deps,
    getBillingSummary: getOrganizationBillingSummary,
    startTrial: startSaasTrial,
  }))
  app.route("/api/admin/billing", createSaasBillingRoute(deps))
  app.route("/api/admin/support", createAdminSupportRoute(deps))
  app.route("/api/admin/consumer-complaints", createAdminConsumerComplaintsRoute(deps))
  app.route("/api/admin/waitlist", createAdminFoundersRoute({ ownerDb: deps.ownerDb, mailer: deps.mailer, panelURL: deps.webURL, replyTo: deps.foundersEmail }))
  app.get("/api/admin/overview", (c) => runService(c, 200, () =>
    deps.ownerDb.transaction((tx) => getBackofficeOverview(tx, adminContextOf(c))),
  ))
  app.all("/api/admin/*", (c) => c.json(errorBody(c, "NOT_FOUND", "Recurso administrativo no encontrado"), 404))
  app.route("/api/account/admin-access", createAccountAdminAccessRoute(deps))
  app.route("/api/account/billing", createAccountBillingRoute(deps))
  app.route("/api/account/support", createAccountSupportRoute(deps))
  app.route("/api/account", createAccountRoute(deps))
  app.all("/api/account/*", (c) => c.json(errorBody(c, "NOT_FOUND", "Recurso de cuenta no encontrado"), 404))

  app.route(
    "/api/public/patient-registration",
    createPublicPatientRegistrationRoute({
      db: deps.db,
      remoteAddress: deps.registrationRemoteAddress,
    }),
  )
  app.route(
    "/api/public/portal",
    createPublicPortalRoute({
      db,
      ownerDb: deps.ownerDb,
      storage: deps.storage,
      webURL: deps.webURL,
      cookieDomain: deps.cookieDomain,
    }),
  )
  // Oferta de prueba y versión de los documentos, para la pantalla de crear cuenta.
  app.route("/api/public/sign-up", createPublicSignUpRoute({ ownerDb: deps.ownerDb }))
  // Fundadores (issue 165): precios que publica la web, solicitudes de la lista de espera y la invitación.
  app.route(
    "/api/public/founders",
    createPublicFoundersRoute({
      ownerDb: deps.ownerDb,
      mailer: deps.mailer,
      remoteAddress: deps.registrationRemoteAddress,
      replyTo: deps.foundersEmail,
    }),
  )
  // Libro de Reclamaciones de odentIA.
  app.route(
    "/api/public/libro-de-reclamaciones",
    createPublicConsumerComplaintsRoute({
      ownerDb: deps.ownerDb,
      mailer: deps.mailer,
      complaintsEmail: deps.complaintsEmail,
      adminURL: deps.adminURL,
      remoteAddress: deps.registrationRemoteAddress,
    }),
  )
  app.route("/api/public/automations", createPublicAutomationsRoute({ db, ownerDb: deps.ownerDb, secretsKey: deps.secretsKey }))
  app.route(
    "/api/public/booking",
    createPublicBookingRoute({ db: deps.db, secretsKey: deps.secretsKey, remoteAddress: deps.registrationRemoteAddress }),
  )
  app.route(
    "/api/webchat",
    createWebchatPublicRoute({
      ownerDb: deps.ownerDb,
      db,
      secretsKey: deps.secretsKey,
      cookieDomain: deps.cookieDomain,
    }),
  )
  app.route(
    "/api/mail",
    createMailboxesRoute({
      auth,
      db,
      ownerDb: deps.ownerDb,
      secretsKey: deps.secretsKey,
      webUrl: deps.webURL,
      mailbox: deps.mailbox ?? {},
    }),
  )

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
      await deps.storage.deleteByUrl(previousImage, userId).catch(() => {})
    }
    return c.json({ data: { url } }, 201)
  })

  // Lo que se propone al elegir país: moneda, formato, zona y papel. Es dato
  // de referencia, no de una organización: el alta lo consulta antes de que
  // la clínica exista, por eso solo exige sesión.
  userScoped.get("/org-profile/region-defaults", (c) => {
    const parsed = z
      .object({ countryCode: z.string().regex(/^[A-Za-z]{2}$/), language: z.string().max(8).optional() })
      .safeParse(c.req.query())
    if (!parsed.success) {
      return c.json(errorBody(c, "VALIDATION", parsed.error.issues[0]?.message ?? "Datos inválidos"), 400)
    }
    return c.json({ data: regionPresetForCountry(parsed.data.countryCode, parsed.data.language) })
  })

  // Webhooks de proveedor ANTES que los routers con guards: el use("*") de
  // userScoped/guarded también casa /api/webhooks/* y respondería 401.
  app.route(
    "/api/webhooks",
    createWebhooksRoute({
      ownerDb: deps.ownerDb,
      db: deps.db,
      secretsKey: deps.secretsKey,
      metaApp: deps.metaSignup
        ? { appSecret: deps.metaSignup.appSecret, verifyToken: deps.metaSignup.webhookVerifyToken }
        : undefined,
    }),
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
  guarded.use("*", async (c, next) => {
    if (isWebhook(c) || c.req.method === "GET" || c.req.method === "HEAD" || c.req.path.startsWith("/api/help/")) return next()
    return requireSaasAccess(db, "operar")(c, next)
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
      // El logo de la clínica viaja con sus datos: se sube en «Datos de la clínica».
      return found ? { ...found, logo: await getClinicLogo(tx, orgId) } : null
    })
    return c.json({ data: row })
  })

  // El logo de la clínica (decisión 19): imagen pública, en el bucket de avatares.
  guarded.put("/org-profile/logo", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para cambiar el logo"), 403)
    }
    const form = await c.req.formData().catch(() => null)
    const file = form?.get("file")
    if (!(file instanceof File)) return c.json(errorBody(c, "VALIDATION", "Adjunta la imagen del logo"), 400)
    const ext = CLINIC_LOGO_MIME_EXT[file.type]
    if (!ext) return c.json(errorBody(c, "VALIDATION", "El logo debe ser PNG, JPG o WebP"), 400)
    if (file.size > CLINIC_LOGO_MAX_BYTES) return c.json(errorBody(c, "VALIDATION", "El logo no puede superar 2 MB"), 400)
    // Va a la carpeta de la clínica dentro del bucket público de imágenes.
    const { url } = await deps.storage.putAvatar({
      userId: clinicLogoFolder(orgId),
      body: Buffer.from(await file.arrayBuffer()),
      contentType: file.type,
      ext,
    })
    return runService(c, 200, async () => {
      const saved = await withOrgContext(db, orgId, (tx) => setClinicLogo(tx, orgId, userId, url))
      if (saved.previous) await deps.storage.deleteByUrl(saved.previous, clinicLogoFolder(orgId)).catch(() => {})
      return { logo: saved.logo }
    })
  })

  guarded.delete("/org-profile/logo", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para cambiar el logo"), 403)
    }
    return runService(c, 200, async () => {
      const saved = await withOrgContext(db, orgId, (tx) => setClinicLogo(tx, orgId, userId, null))
      if (saved.previous) await deps.storage.deleteByUrl(saved.previous, clinicLogoFolder(orgId)).catch(() => {})
      return { logo: null }
    })
  })

  guarded.put("/org-profile", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para editar el perfil"), 403)
    }
    const parsed = orgProfileInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const input = parsed.data

    return runService(c, 200, () => withOrgContext(db, orgId, async (tx) => {
      const [current] = await tx
        .select({ id: orgProfile.organizationId })
        .from(orgProfile)
        .where(eq(orgProfile.organizationId, orgId))
        .for("update")
      const { countryCode, currency, timezone, locale, receiptWidth, sheetSize, ticketFooter, applyCountryPreset, ...identity } = input
      if (current) {
        await tx
          .update(orgProfile)
          .set({ ...identity, updatedAt: new Date() })
          .where(eq(orgProfile.organizationId, orgId))
      } else {
        // El perfil nace con su región explícita: la base no asume ningún país.
        await tx
          .insert(orgProfile)
          .values({
            organizationId: orgId,
            ...identity,
            ...initialOrgRegion({ countryCode, currency, timezone, locale, sheetSize }),
          })
      }
      const updated = await updateOrgRegion(tx, orgId, userId, {
        countryCode, currency, timezone, locale, receiptWidth, sheetSize, ticketFooter,
        applyCountryPreset: applyCountryPreset ?? !current,
      })
      // Una clínica nueva trae prendido «Recordar la cita», a nombre de quien la crea (ADR 0026).
      if (!current) await turnOnNewClinicLines(tx, orgId, userId)
      // Y nace con las especialidades de la biblioteca, que puede renombrar (ADR 0039).
      if (!current) await ensureLibrarySpecialties(tx, orgId)
      await tx.insert(auditEvent).values({
        organizationId: orgId,
        actorUserId: userId,
        action: "org_profile.upsert",
        entity: "org_profile",
        entityId: orgId,
        metadata: input,
      })
      return updated
    }))
  })

  // Lista de diagnósticos de la clínica (decisión 26): los nuevos se eligen en ella; nada se reescribe.
  guarded.put("/org-profile/diagnosis-system", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para cambiar la lista de diagnósticos"), 403)
    }
    const parsed = z
      .object({ diagnosisSystem: z.string().min(1).max(20) })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(db, orgId, (tx) => setOrgDiagnosisSystem(tx, orgId, userId, parsed.data.diagnosisSystem)),
    )
  })

  // Ancho del ticket, tamaño de hoja y frase al pie: no tocan la región ni la identidad.
  guarded.put("/org-profile/printing", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para cambiar el ticket"), 403)
    }
    const parsed = orgPrintingInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(db, orgId, (tx) => updateOrgRegion(tx, orgId, userId, parsed.data)),
    )
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
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para crear sedes"), 403)
    }
    const parsed = branchInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)

    const row = await withOrgContext(db, orgId, async (tx) => {
      await assertSaasBranchAvailable(tx, orgId)
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
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para editar sedes"), 403)
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
    if (!row) return c.json(errorBody(c, "NOT_FOUND", "Sede no encontrada"), 404)
    return c.json({ data: row })
  })

  guarded.delete("/branches/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para desactivar sedes"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(db, orgId, (tx) => setBranchActive(tx, orgId, userId, c.req.param("id"), false)),
    )
  })

  // Una sede desactivada vuelve con sus citas, horarios y unidades dentales.
  guarded.post("/branches/:id/reactivate", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para reactivar sedes"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(db, orgId, async (tx) => {
        const [current] = await tx.select({ isActive: branch.isActive }).from(branch)
          .where(and(eq(branch.id, c.req.param("id")), eq(branch.organizationId, orgId))).for("update")
        if (current && !current.isActive) await assertSaasBranchAvailable(tx, orgId)
        return setBranchActive(tx, orgId, userId, c.req.param("id"), true)
      }),
    )
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
                inArray(auditEvent.action, ["message.created", "message.updated", ...CONVERSATION_STATE_ACTIONS]),
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
    createPatientRegistrationRoute({
      ...crmDeps,
      cookieDomain: deps.cookieDomain,
      webURL: deps.webURL,
    }),
  )
  guarded.route("/conversations", createConversationsRoute(crmDeps))
  guarded.route("/contacts", createContactsRoute(crmDeps))
  guarded.route("/crm", createCrmWorkspaceRoute(crmDeps))
  guarded.route("/patients", createFinancialDocumentsRoute(crmDeps))
  const llm: PlatformLlm = deps.llm ?? { fake: true }
  guarded.route("/patients", createPatientsRoute({ ...crmDeps, llm }))
  guarded.route("/people", createPeopleRoute(crmDeps))
  guarded.route("/services", createServicesRoute(crmDeps))
  guarded.route("/org/payment-methods", createPaymentMethodsRoute(crmDeps))
  guarded.route("/promotions", createPromotionsRoute(crmDeps))
  guarded.route("/commissions", createCommissionsRoute(crmDeps))
  guarded.route("/diagnosis-codes", createDiagnosisCodesRoute(crmDeps))
  guarded.route("/pipelines", createPipelinesRoute(crmDeps))
  guarded.route("/channels/connections", createConnectionsRoute(crmDeps))
  guarded.route("/channels/whatsapp/signup", createWhatsAppSignupRoute({ ...crmDeps, meta: deps.metaSignup }))
  guarded.route("/agent", createAgentRoute({ ...crmDeps, llm, ownerDb: deps.ownerDb }))
  guarded.route("/tasks", createTasksRoute(crmDeps))
  guarded.route("/agenda", createAgendaRoute(crmDeps))
  guarded.route("/search", createSearchRoute({ ...crmDeps, embedder: deps.embedder }))
  guarded.route("/appointments", createAppointmentsRoute(crmDeps))
  guarded.route("/fields", createFieldsRoute(crmDeps))
  guarded.route("/workspace", createWorkspaceRoute(crmDeps))
  guarded.route("/legal", createLegalRoute(crmDeps))
  guarded.route("/reports", createReportsRoute(crmDeps))
  guarded.route("/inventory", createInventoryRoute(crmDeps))
  guarded.route("/opportunities", createOpportunitiesRoute(crmDeps))
  guarded.route("/help", createHelpRoute({ ...crmDeps, appVersion: process.env["APP_VERSION"] ?? null }))
  guarded.route("/agent/admin", createAgentAdminRoute({ ...crmDeps, llm, decisions: deps.decisions }))
  guarded.route("/agent/knowledge", createAgentKnowledgeRoute(crmDeps))
  guarded.route("/agent/learning", createAgentLearningRoute({ ...crmDeps, llm, ownerDb: deps.ownerDb, decisions: deps.decisions }))
  guarded.route("/agent", createAgentOpsRoute({ ...crmDeps, llm, ownerDb: deps.ownerDb, decisions: deps.decisions, embedder: deps.embedder }))
  guarded.route("/finance", createFinanceRoute(crmDeps))
  guarded.route("/clinical-forms", createClinicalFormsRoute(crmDeps))
  guarded.route(
    "/portal",
    createPortalRoute({ db, webURL: deps.webURL, cookieDomain: deps.cookieDomain }),
  )
  guarded.route("/channels/webchat", createWebchatAdminRoute(crmDeps))
  app.route("/api", guarded)
  return app
}
