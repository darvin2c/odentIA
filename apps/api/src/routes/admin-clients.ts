import { fakeKairosWriter, type KairosWriter } from "@odentia/agent"
import {
  CLINICAL_PRODUCTS,
  type ClinicalProduct,
  isClinicalProduct,
  productWords,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  SAAS_ACTIVITY_DIRECTIONS,
  SAAS_ACTIVITY_KINDS,
  SAAS_CLIENT_FILE_KINDS,
  SAAS_CLIENT_ORIGINS,
  SAAS_CLIENT_PROFESSIONALS,
  SAAS_CLIENT_TOOLS,
  SAAS_CONTACT_ROLES,
  SAAS_LOST_REASONS,
  SAAS_OUTREACH_CHANNELS,
  SAAS_PROPOSAL_BILLING_CYCLES,
  SAAS_TASK_KINDS,
  SAAS_TASK_STATUSES,
  type SaasClientFileKind,
  saasClient,
} from "@odentia/db/schema/admin-arm"
import { saasDemo } from "@odentia/db/schema/admin-demos"
import { invitation, user } from "@odentia/db/schema/auth"
import { orgProfile } from "@odentia/db/schema/org"
import { saasPlan, saasWaitlistRequest } from "@odentia/db/schema/saas-billing"
import { invitationTemplate, type Mailer } from "@odentia/mail"
import {
  type AdminActor,
  acceptedProposalOfOpenSale,
  addActivity,
  addClientContact,
  applyProposalTerms,
  approveSaasProposal,
  archiveClient,
  assignInboundEmail,
  CLIENT_STAGES,
  CLIENT_VIEWS,
  ClientDuplicateError,
  cancelClientTask,
  clientCreateSchema,
  clientFileKey,
  clientFileUrl,
  clientPatchSchema,
  clientTimeline,
  completeClientTask,
  contactInputSchema,
  contactPatchSchema,
  createAssistedOrganization,
  createClient,
  createClientTask,
  createSaasProposal,
  decide,
  decideSaasProposal,
  deleteClientFile,
  filenameForType,
  founderInvitationEmail,
  founderOffer,
  getClient,
  getInboundEmail,
  getSaasProposal,
  inviteClient,
  issueFields,
  limaDate,
  linkContactToUser,
  listClientContacts,
  listClientFiles,
  listClients,
  listClientTasks,
  listSaasProposals,
  markInvitationSent,
  markOutreachSent,
  mergeClients,
  moveClientTask,
  type OrganizationBillingLoaders,
  type OutreachEmail,
  type OutreachRow,
  onboardingSteps,
  outreachEmail,
  outreachMailMessage,
  outreachSender,
  PRESENTATION_OUTCOMES,
  pipeline,
  prepareEmailReply,
  prepareOutreach,
  proposalPdf,
  REPLY_FILES_MAX,
  recordPresentation,
  registerClientFile,
  reopenClientOpportunity,
  resolveOutreach,
  ServiceError,
  type Storage,
  schedulePresentation,
  setOpportunity,
  setPrimaryClientContact,
  settleKairosOutreach,
  TIMELINE_FILTERS,
  updateClient,
  updateClientContact,
  writeAdminAudit,
} from "@odentia/services"
import { and, desc, eq, isNotNull } from "drizzle-orm"
import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import { adminContextOf } from "../lib/admin-context.js"
import { errorBody } from "../lib/error.js"
import { runService, serviceErrorResponse } from "./helpers.js"
import { allowedInboundAttachment } from "./inbound-email.js"

/**
 * El ARM de la administración (`/api/admin/clients`, tras el guard de admin):
 * el cliente desde el primer contacto, sus personas, su historial, la venta
 * (tareas, presentaciones, propuestas, envíos, decidir, invitar, dar de alta),
 * el alta, sus documentos y los correos entrantes. Cada acción revisa el rol en el
 * servidor: Soporte ve y anota; lo que es solo de Administración responde 403
 * aunque la pantalla lo esconda. Kairós solo ordena lo que se le dicta: nunca
 * envía ni guarda solo.
 */
export interface AdminClientsDeps {
  /** El ARM es de Sallca, no de una clínica: conexión owner (las tablas `admin.*` no tienen GRANT). */
  ownerDb: Db
  mailer: Mailer
  storage: Storage
  /** El panel de cada producto: la invitación se acepta en el dominio de la clínica. */
  panelUrlOf: (product: ClinicalProduct) => string
  /**
   * Por dónde salen las conversaciones («Escribir» y las respuestas a un correo):
   * el canal de ZeptoMail para conversaciones (`CONVERSATION_SMTP_*`); sin él, `mailer`.
   */
  conversationMailer?: Mailer
  /**
   * A dónde responde la clínica la invitación de Fundadores: hola@ de su marca, que
   * entra al ARM. Sin él, la invitación no promete respuesta.
   */
  invitationReplyToOf?: (product: ClinicalProduct) => string | undefined
  /** Kairós con modelo; sin él, el doble determinista (sin gasto). */
  kairos?: KairosWriter
  /** Lo mismo que usa «Alta asistida» en Organizaciones. */
  startTrial?: OrganizationBillingLoaders["startTrial"]
  getBillingSummary?: OrganizationBillingLoaders["getBillingSummary"]
}

/** Un documento subido a mano: como los adjuntos de Soporte. */
export const CLIENT_FILE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024
/** Lo que se puede subir a Documentos: lo mismo que entra por correo (`allowedInboundAttachment`). */
const CLIENT_FILE_TYPES_WORDS =
  "Se admite PDF, una imagen (JPG, PNG, WebP o GIF), Excel (.xlsx), CSV o Word (.docx), sin macros"

/** Los ids son uuid: así `/tasks`, `/pipeline` o `/inbound` nunca caen en `/:id`. */
const ID = ":id{[0-9a-fA-F-]+}"

/* ---------- Esquemas (mensajes en español; el servicio vuelve a validar) ---------- */

const day = (what: string) => z.iso.date(`Elige ${what}`)
const instant = (what: string) => z.iso.datetime({ offset: true, error: `Elige ${what}` })
const optionalId = (what: string) => z.uuid(`Elige ${what}`).nullable().optional()
const text = (max: number, what: string) =>
  z
    .string({ error: `Escribe ${what}` })
    .trim()
    .min(1, `Escribe ${what}`)
    .max(max, `Usa como máximo ${max} caracteres`)
const optionalText = (max: number) =>
  z.string().trim().max(max, `Usa como máximo ${max} caracteres`).nullable().optional()

const listQuery = z.strictObject({
  view: z.enum(CLIENT_VIEWS, "Elige una vista").optional(),
  product: z.enum(CLINICAL_PRODUCTS, "Elige un producto").optional(),
  owner: z.string().trim().min(1).max(120, "Elige un responsable").optional(),
  origin: z.enum(SAAS_CLIENT_ORIGINS, "Elige cómo llegó").optional(),
  stage: z.enum(CLIENT_STAGES, "Elige una etapa").optional(),
  q: z.string().trim().max(120, "Busca con 120 caracteres como mucho").optional(),
  limit: z.coerce.number().int().min(1).max(100, "Pide como mucho 100").optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

const pipelineQuery = listQuery.pick({ product: true, owner: true, origin: true })

const timelineQuery = z.strictObject({
  filter: z.enum(TIMELINE_FILTERS, "Elige qué mostrar").optional(),
  before: instant("desde cuándo").optional(),
  limit: z.coerce.number().int().min(1).max(100, "Pide como mucho 100").optional(),
})

const tasksQuery = z.strictObject({
  who: z.enum(["mias", "todas"], "Elige de quién").optional(),
  status: z.enum(SAAS_TASK_STATUSES, "Elige un estado").optional(),
  clientId: z.uuid("Elige un cliente").optional(),
  dueBy: day("hasta qué día").optional(),
})

/** Una sola de las dos: la solicitud de la web o la cuenta de la clínica. */
const lookupQuery = z
  .strictObject({
    request: z.uuid("Elige la solicitud").optional(),
    organization: z.string().trim().min(1).max(120, "Elige la cuenta").optional(),
  })
  .refine((query) => Boolean(query.request) !== Boolean(query.organization), {
    message: "Pide por la solicitud o por la cuenta, una de las dos",
    path: ["request"],
  })

const mergeBody = z.strictObject({ dropId: z.uuid("Elige la ficha que se une a esta") })
const linkBody = z.strictObject({
  userId: z.string().trim().min(1, "Elige el usuario").max(120, "Elige el usuario"),
})

const activityBody = z.strictObject({
  kind: z.enum(SAAS_ACTIVITY_KINDS, "Elige qué fue"),
  direction: z
    .enum(SAAS_ACTIVITY_DIRECTIONS, "Elige si salió de nosotros o entró de la clínica")
    .nullable()
    .optional(),
  body: text(2000, "qué pasó"),
  outcome: optionalText(500),
  contactId: optionalId("la persona"),
  demoId: optionalId("la demo"),
  proposalId: optionalId("la propuesta"),
  happenedAt: instant("cuándo pasó").optional(),
  adminOnly: z.boolean().optional(),
})

const taskBody = z.strictObject({
  kind: z.enum(SAAS_TASK_KINDS, "Elige qué hay que hacer"),
  title: text(200, "la tarea"),
  dueOn: day("el día"),
  dueAt: instant("la hora").nullable().optional(),
  assigneeUserId: z.string().trim().min(1).max(120, "Elige a quién").nullable().optional(),
  contactId: optionalId("la persona"),
  demoId: optionalId("la demo"),
})

const doneBody = z.strictObject({
  note: optionalText(1000),
  activity: activityBody.nullable().optional(),
})

const moveBody = z.strictObject({
  dueOn: day("el día"),
  dueAt: instant("la hora").nullable().optional(),
})

const decideBody = z.strictObject({
  decision: z.enum(["no_por_ahora", "perdido"], "Elige qué se decidió"),
  reason: z.enum(SAAS_LOST_REASONS, "Elige el motivo"),
  reasonDetail: optionalText(500),
  returnOn: day("el día para volver").nullable().optional(),
})

const opportunityBody = z.strictObject({
  sellerId: optionalId("quién vende"),
  expectedOn: day("la fecha esperada").nullable().optional(),
})

const inviteBody = z.strictObject({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(
      z
        .email("Escribe un correo válido, como nombre@clinica.com")
        .max(254, "Usa como máximo 254 caracteres"),
    ),
  planId: optionalId("el plan"),
  proposalId: optionalId("la propuesta"),
  /** `false`: solo el enlace, para pasarlo por WhatsApp. */
  send: z.boolean().default(true),
  firstName: optionalText(80),
  lastName: optionalText(120),
  phone: optionalText(20),
  city: optionalText(120),
  professionals: z.enum(SAAS_CLIENT_PROFESSIONALS, "Elige cuántos atienden").nullable().optional(),
  currentTool: z.enum(SAAS_CLIENT_TOOLS, "Elige qué usan hoy").nullable().optional(),
})

const assistedBody = z.strictObject({
  /** Por defecto, el nombre del cliente. */
  orgName: z
    .string()
    .trim()
    .min(2, "Escribe el nombre de la clínica")
    .max(120, "Escribe como mucho 120 caracteres")
    .optional(),
  slug: z
    .string()
    .trim()
    .min(2, "Escribe al menos 2 caracteres")
    .max(63, "Escribe como mucho 63 caracteres"),
  email: z.string().trim().email("Correo inválido").max(320, "Escribe como mucho 320 caracteres"),
  /** Por defecto, el país del cliente. */
  countryCode: z.string().trim().length(2, "Elige el país").optional(),
  currency: z.string().trim().length(3, "Elige la moneda").optional(),
  timezone: z.string().trim().max(60, "Elige la zona horaria").optional(),
  billingStart: z.enum(["trial", "now"], "Elige cuándo empieza a pagar").optional(),
  /** Sin él y con una propuesta aceptada, el plan de esa propuesta. */
  planCode: z.string().trim().min(1).max(60, "Elige el plan").optional(),
  sellerId: z.string().trim().max(120, "Elige quién vende").optional(),
})

const presentationBody = z.strictObject({
  dueOn: day("el día"),
  dueAt: instant("la hora").nullable().optional(),
  contactId: optionalId("la persona"),
  demoId: optionalId("la demo"),
  assigneeUserId: z.string().trim().min(1).max(120, "Elige a quién").nullable().optional(),
})

const recordBody = z.strictObject({
  outcome: z.enum(PRESENTATION_OUTCOMES, "Elige cómo fue"),
  body: text(2000, "cómo fue"),
  nextDueOn: day("el día siguiente").nullable().optional(),
  nextDueAt: instant("la hora siguiente").nullable().optional(),
})

const proposalBody = z.strictObject({
  planId: z.uuid("Elige el plan"),
  discountBps: z
    .number({ error: "Escribe el descuento" })
    .int("El descuento va en puntos enteros")
    .min(0, "El descuento no puede ser negativo")
    .max(9000, "El descuento llega hasta 90 %"),
  discountMonths: z
    .number()
    .int()
    .min(1, "Al menos 1 mes")
    .max(36, "Como mucho 36 meses")
    .nullable()
    .optional(),
  trialDays: z
    .number()
    .int()
    .min(1, "Al menos 1 día de prueba")
    .max(365, "Como mucho 365 días")
    .nullable()
    .optional(),
  trialCreditCents: z
    .number()
    .int()
    .min(0, "El crédito no puede ser negativo")
    .nullable()
    .optional(),
  billingCycle: z.enum(SAAS_PROPOSAL_BILLING_CYCLES, "Elige cada cuánto paga").default("mensual"),
  validUntil: day("hasta cuándo vale"),
})

const proposalDecideBody = z.strictObject({
  accepted: z.boolean({ error: "Elige si la aceptó" }),
  note: optionalText(1000),
})

const outreachBody = z.strictObject({
  channel: z.enum(SAAS_OUTREACH_CHANNELS, "Elige por dónde sale"),
  contactId: optionalId("la persona"),
  to: optionalText(254),
  subject: optionalText(200),
  body: text(5000, "el mensaje"),
  proposalId: optionalId("la propuesta"),
  kairosItemId: optionalId("el borrador de Kairós"),
})

const resolveBody = z.strictObject({
  outcome: z.enum(["salio", "no_salio"], "Elige si salió o no"),
})
const assignBody = z.strictObject({ clientId: z.uuid("Elige el cliente") })
const replyBody = z.strictObject({
  body: text(5000, "la respuesta"),
  proposalId: optionalId("la propuesta"),
  kairosItemId: optionalId("el borrador de Kairós"),
  fileIds: z
    .array(z.uuid("Ese documento no existe"))
    .max(REPLY_FILES_MAX, `Adjunta como máximo ${REPLY_FILES_MAX} documentos`)
    .optional(),
})

const annotatePreviewBody = z.strictObject({ text: text(4000, "qué pasó") })

/** Lo que Kairós ordenó y la persona revisó: se guarda con las mismas operaciones que la pantalla. */
const annotateBody = z.strictObject({
  activity: z.strictObject({
    kind: z.enum(SAAS_ACTIVITY_KINDS, "Elige qué fue"),
    direction: z
      .enum(SAAS_ACTIVITY_DIRECTIONS, "Elige si salió de nosotros o entró de la clínica")
      .nullable(),
    outcome: optionalText(500),
    body: text(2000, "qué pasó"),
    contactId: optionalId("la persona"),
  }),
  task: z
    .strictObject({
      kind: z.enum(SAAS_TASK_KINDS, "Elige qué hay que hacer"),
      title: text(200, "la tarea"),
      dueOn: day("el día"),
      dueAt: instant("la hora").nullable().optional(),
      contactId: optionalId("la persona"),
      demoId: optionalId("la demo"),
    })
    .nullable()
    .optional(),
  newContacts: z
    .array(
      z.strictObject({
        name: text(160, "el nombre de la persona"),
        title: optionalText(120),
        roles: z
          .array(z.enum(SAAS_CONTACT_ROLES, "Elige quién decide, quién la usa o quién paga"))
          .max(3)
          .default([]),
      }),
    )
    .max(10, "Como mucho 10 personas a la vez")
    .default([]),
  data: z
    .strictObject({
      city: z.string().trim().min(1).max(120, "Usa como máximo 120 caracteres").optional(),
      professionals: z.enum(SAAS_CLIENT_PROFESSIONALS, "Elige cuántos atienden").optional(),
      currentTool: z.enum(SAAS_CLIENT_TOOLS, "Elige qué usan hoy").optional(),
    })
    .default({}),
})

/* ---------- Ayudas ---------- */

function staffOf(c: Context): AdminActor {
  const actor = adminContextOf(c)
  if (actor.role !== "admin" && actor.role !== "support")
    throw new ServiceError("FORBIDDEN", 403, "Solo el equipo de la administración")
  return actor
}

/** Propuestas, decidir, invitar, dar de alta, fusionar, archivar, el alta y las llaves: solo Administración. */
function adminOf(c: Context): AdminActor {
  const actor = staffOf(c)
  if (actor.role !== "admin")
    throw new ServiceError("FORBIDDEN", 403, "Solo el rol Administración puede hacer esto")
  return actor
}

/** Valida como `validationError`, pero lanzando: así el rol se revisa antes que el cuerpo. */
function parse<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const parsed = schema.safeParse(raw)
  if (!parsed.success)
    throw new ServiceError(
      "VALIDATION",
      400,
      parsed.error.issues[0]?.message ?? "Revisa los datos marcados.",
      issueFields(parsed.error.issues),
    )
  return parsed.data
}

const bodyOf = (c: Context) => c.req.json().catch(() => null)
const at = (value: string | null | undefined) =>
  value ? new Date(value) : value === null ? null : undefined

/** «domingo 1 de noviembre», en UTC: el instante exacto lo dice el enlace. */
function dayText(date: Date): string {
  return new Intl.DateTimeFormat("es", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(date)
}

export function createAdminClientsRoute(deps: AdminClientsDeps) {
  const app = new Hono()
  const kairos = deps.kairos ?? fakeKairosWriter
  const loaders: OrganizationBillingLoaders = {
    getBillingSummary: deps.getBillingSummary,
    startTrial: deps.startTrial,
  }
  const owner = <T>(fn: (tx: Db) => Promise<T>): Promise<T> =>
    deps.ownerDb.transaction((tx) => fn(tx as Db))
  const conversations = deps.conversationMailer ?? deps.mailer
  const staffRun = <T>(c: Context, status: 200 | 201, fn: (actor: AdminActor) => Promise<T>) =>
    runService(c, status, () => fn(staffOf(c)))
  const adminRun = <T>(c: Context, status: 200 | 201, fn: (actor: AdminActor) => Promise<T>) =>
    runService(c, status, () => fn(adminOf(c)))

  /* ----- Tareas y embudo ----- */

  app.get("/tasks", (c) =>
    staffRun(c, 200, (actor) => {
      const query = parse(tasksQuery, c.req.query())
      return owner((tx) => listClientTasks(tx, actor, query))
    }),
  )

  app.post("/tasks/:taskId/done", async (c) => {
    const raw = await bodyOf(c)
    return staffRun(c, 200, (actor) => {
      const body = parse(doneBody, raw ?? {})
      const activity = body.activity
        ? { ...body.activity, happenedAt: at(body.activity.happenedAt) }
        : body.activity
      return owner((tx) =>
        completeClientTask(tx, actor, c.req.param("taskId"), { note: body.note, activity }),
      )
    })
  })

  app.post("/tasks/:taskId/cancel", (c) =>
    staffRun(c, 200, (actor) => owner((tx) => cancelClientTask(tx, actor, c.req.param("taskId")))),
  )

  app.post("/tasks/:taskId/move", async (c) => {
    const raw = await bodyOf(c)
    return staffRun(c, 200, (actor) => {
      const body = parse(moveBody, raw)
      return owner((tx) =>
        moveClientTask(tx, actor, c.req.param("taskId"), {
          dueOn: body.dueOn,
          dueAt: at(body.dueAt),
        }),
      )
    })
  })

  app.get("/pipeline", (c) =>
    staffRun(c, 200, (actor) => {
      const query = parse(pipelineQuery, c.req.query())
      return owner((tx) => pipeline(tx, actor, query))
    }),
  )

  /**
   * El cliente de una solicitud o de una cuenta, para que los enlaces de antes
   * (`/waitlist?solicitud=`, `/organizations/<id>`) abran su ficha. Solo lee:
   * una cuenta sin cliente (una demo) responde 404 y nunca se crea uno aquí.
   */
  app.get("/lookup", (c) =>
    staffRun(c, 200, () => {
      const query = parse(lookupQuery, c.req.query())
      return owner(async (tx) => {
        let organizationId = query.organization ?? null
        if (query.request) {
          const [request] = await tx
            .select({
              clientId: saasWaitlistRequest.clientId,
              organizationId: saasWaitlistRequest.organizationId,
            })
            .from(saasWaitlistRequest)
            .where(eq(saasWaitlistRequest.id, query.request))
            .limit(1)
          if (!request) throw new ServiceError("NOT_FOUND", 404, "Esa solicitud no existe")
          if (request.clientId) return { clientId: request.clientId }
          organizationId = request.organizationId
        }
        if (organizationId) {
          const [client] = await tx
            .select({ id: saasClient.id })
            .from(saasClient)
            .where(eq(saasClient.organizationId, organizationId))
            .limit(1)
          if (client) return { clientId: client.id }
        }
        throw new ServiceError("NOT_FOUND", 404, "No hay un cliente para eso")
      })
    }),
  )

  /* ----- Personas ----- */

  app.patch("/contacts/:contactId", async (c) => {
    const raw = await bodyOf(c)
    return staffRun(c, 200, (actor) => {
      parse(contactPatchSchema, raw)
      return owner((tx) => updateClientContact(tx, actor, c.req.param("contactId"), raw))
    })
  })

  app.post("/contacts/:contactId/primary", (c) =>
    staffRun(c, 200, (actor) =>
      owner((tx) => setPrimaryClientContact(tx, actor, c.req.param("contactId"))),
    ),
  )

  /** Ligar a un usuario: solo Administración y solo con el mismo correo (lo exige el servicio). */
  app.post("/contacts/:contactId/link", async (c) => {
    const raw = await bodyOf(c)
    return adminRun(c, 200, (actor) => {
      const body = parse(linkBody, raw)
      return owner((tx) => linkContactToUser(tx, actor, c.req.param("contactId"), body.userId))
    })
  })

  /* ----- Presentaciones ----- */

  app.post("/presentations/:taskId/record", async (c) => {
    const raw = await bodyOf(c)
    return staffRun(c, 200, (actor) => {
      const body = parse(recordBody, raw)
      return owner((tx) =>
        recordPresentation(tx, actor, c.req.param("taskId"), {
          ...body,
          nextDueAt: at(body.nextDueAt),
        }),
      )
    })
  })

  /* ----- Propuestas (solo Administración) ----- */

  app.get("/proposals/:pid/pdf", async (c) => {
    try {
      const actor = adminOf(c)
      const pdf = await owner(async (tx) => {
        const proposal = await getSaasProposal(tx, actor, c.req.param("pid"))
        // Dice que se puede escribir a quien la mira (si la envía, sale con su dirección).
        const [client] = await tx
          .select({ product: saasClient.product })
          .from(saasClient)
          .where(eq(saasClient.id, proposal.clientId))
          .limit(1)
        const sender = await outreachSender(
          tx,
          actor,
          isClinicalProduct(client?.product) ? client.product : "dental",
        )
        return proposalPdf(tx, c.req.param("pid"), sender.address)
      })
      return c.body(pdf.bytes.slice(), 200, {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${pdf.filename.replace(/[^\w.-]/g, "_")}"`,
        "cache-control": "no-store",
      })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  app.post("/proposals/:pid/approve", (c) =>
    adminRun(c, 200, (actor) => owner((tx) => approveSaasProposal(tx, actor, c.req.param("pid")))),
  )

  app.post("/proposals/:pid/decide", async (c) => {
    const raw = await bodyOf(c)
    return adminRun(c, 200, (actor) => {
      const body = parse(proposalDecideBody, raw)
      return owner((tx) => decideSaasProposal(tx, actor, c.req.param("pid"), body))
    })
  })

  /* ----- Envíos ----- */

  /** «Salió» / «No salió»: el WhatsApp abierto por su enlace o un correo incierto. Nunca se reintenta solo. */
  app.post("/outreach/:oid/resolve", async (c) => {
    const raw = await bodyOf(c)
    return staffRun(c, 200, (actor) => {
      const body = parse(resolveBody, raw)
      return owner(async (tx) => {
        const outreach = await resolveOutreach(tx, actor, c.req.param("oid"), body.outcome)
        const kairosItem = await settleKairosOutreach(tx, outreach.id)
        return { outreach, kairosItem }
      })
    })
  })

  /* ----- Documentos ----- */

  app.get("/files/:fileId", async (c) => {
    try {
      const actor = staffOf(c)
      const file = await owner((tx) =>
        clientFileUrl(tx, actor, deps.storage, c.req.param("fileId")),
      )
      return c.redirect(file.url, 302)
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  /** Borrar es de Administración; el objeto se borra después del commit. */
  app.delete("/files/:fileId", (c) =>
    adminRun(c, 200, async (actor) => {
      const { objectKey } = await owner((tx) => deleteClientFile(tx, actor, c.req.param("fileId")))
      await deps.storage.deleteAttachment(objectKey).catch(() => {
        console.error(
          `ARM: no se borró el objeto de un documento (${c.req.param("fileId")}); lo borra la limpieza`,
        )
      })
      return { ok: true }
    }),
  )

  /* ----- Correos entrantes ----- */

  app.post("/inbound/:emailId/assign", async (c) => {
    const raw = await bodyOf(c)
    return staffRun(c, 200, (actor) => {
      const body = parse(assignBody, raw)
      return owner((tx) => assignInboundEmail(tx, actor, c.req.param("emailId"), body.clientId))
    })
  })

  /** Un correo que llegó, para leerlo y responderlo. Soporte solo ve lo de soporte@. */
  app.get("/inbound/:emailId", (c) =>
    staffRun(c, 200, (actor) => owner((tx) => getInboundEmail(tx, actor, c.req.param("emailId")))),
  )

  /**
   * Responder un correo que llegó (con o sin cliente): la misma reserva y el
   * mismo envío de «Escribir». Lo de soporte@ sale desde soporte@ y lo responde
   * Soporte o Administración; lo demás, solo Administración, con su dirección.
   */
  app.post("/inbound/:emailId/reply", async (c) => {
    const raw = await bodyOf(c)
    try {
      const actor = staffOf(c)
      const body = parse(replyBody, raw)
      const { outreach, mail } = await owner(async (tx) => {
        const row = await prepareEmailReply(tx, actor, c.req.param("emailId"), body)
        // Los adjuntos se leen dentro de la reserva: si no se pueden leer, no queda nada pendiente.
        return { outreach: row, mail: await outreachEmail(tx, row.id, readClientFile) }
      })
      return await sendReserved(c, actor, outreach, mail)
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  /* ----- Clientes ----- */

  app.get("/", (c) =>
    staffRun(c, 200, (actor) => {
      const query = parse(listQuery, c.req.query())
      return owner((tx) => listClients(tx, actor, query))
    }),
  )

  /** Con un parecido y sin `confirmNew`: 409 `CLIENT_MAYBE_DUPLICATE` con la lista, para preguntar «¿es la misma?». */
  app.post("/", async (c) => {
    const raw = await bodyOf(c)
    try {
      const actor = staffOf(c)
      parse(clientCreateSchema, raw)
      const created = await owner((tx) => createClient(tx, actor, raw))
      return c.json({ data: created }, 201)
    } catch (e) {
      if (e instanceof ClientDuplicateError) {
        const body = errorBody(c, e.code, e.message, e.fields)
        return c.json({ error: { ...body.error, duplicates: e.duplicates } }, 409)
      }
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  app.get(`/${ID}`, (c) =>
    staffRun(c, 200, (actor) => owner((tx) => getClient(tx, actor, c.req.param("id")))),
  )

  app.patch(`/${ID}`, async (c) => {
    const raw = await bodyOf(c)
    return staffRun(c, 200, (actor) => {
      parse(clientPatchSchema, raw)
      return owner((tx) => updateClient(tx, actor, c.req.param("id"), raw))
    })
  })

  app.post(`/${ID}/archive`, (c) =>
    adminRun(c, 200, (actor) => owner((tx) => archiveClient(tx, actor, c.req.param("id")))),
  )

  app.post(`/${ID}/merge`, async (c) => {
    const raw = await bodyOf(c)
    return adminRun(c, 200, (actor) => {
      const body = parse(mergeBody, raw)
      return owner((tx) => mergeClients(tx, actor, c.req.param("id"), body.dropId))
    })
  })

  app.get(`/${ID}/timeline`, (c) =>
    staffRun(c, 200, (actor) => {
      const query = parse(timelineQuery, c.req.query())
      return owner((tx) =>
        clientTimeline(tx, actor, c.req.param("id"), {
          ...query,
          before: at(query.before) ?? undefined,
        }),
      )
    }),
  )

  app.get(`/${ID}/contacts`, (c) =>
    staffRun(c, 200, (actor) => owner((tx) => listClientContacts(tx, actor, c.req.param("id")))),
  )

  app.post(`/${ID}/contacts`, async (c) => {
    const raw = await bodyOf(c)
    return staffRun(c, 201, (actor) => {
      parse(contactInputSchema, raw)
      return owner((tx) => addClientContact(tx, actor, c.req.param("id"), raw))
    })
  })

  app.post(`/${ID}/activities`, async (c) => {
    const raw = await bodyOf(c)
    return staffRun(c, 201, (actor) => {
      const body = parse(activityBody, raw)
      return owner((tx) =>
        addActivity(tx, actor, c.req.param("id"), { ...body, happenedAt: at(body.happenedAt) }),
      )
    })
  })

  /**
   * «Ordenar»: Kairós lee lo dictado y propone las piezas (actividad, tarea,
   * personas nuevas, datos). No guarda nada: la persona las revisa y guarda
   * con `POST /:id/annotate`. Lo que viaja al modelo: el nombre de la clínica,
   * su ciudad, producto, etapa y los nombres de sus personas y demos.
   */
  app.post(`/${ID}/annotate/preview`, async (c) => {
    const raw = await bodyOf(c)
    return staffRun(c, 200, async (actor) => {
      const body = parse(annotatePreviewBody, raw)
      const now = new Date()
      const facts = await owner(async (tx) => {
        const client = await getClient(tx, actor, c.req.param("id"), now)
        const demos = await tx
          .select({ id: saasDemo.id, name: saasDemo.name })
          .from(saasDemo)
          .where(and(eq(saasDemo.product, client.product), isNotNull(saasDemo.organizationId)))
          .orderBy(desc(saasDemo.createdAt))
          .limit(20)
        return {
          client: {
            name: client.name,
            product: client.product,
            city: client.city,
            professionals: client.professionals,
            currentTool: client.currentTool,
            stage: client.stage,
          },
          contacts: client.contacts.flatMap((contact) =>
            contact.id ? [{ id: contact.id, name: contact.name }] : [],
          ),
          demos,
        }
      })
      let annotation: Awaited<ReturnType<KairosWriter["parseAnnotation"]>>
      try {
        annotation = await kairos.parseAnnotation({
          text: body.text,
          today: limaDate(now),
          ...facts,
        })
      } catch (error) {
        console.error("Kairós: no pudo ordenar una nota", error)
        throw new ServiceError(
          "KAIROS_UNAVAILABLE",
          502,
          "Kairós no pudo ordenar la nota: guárdala tal como está o vuelve a intentarlo",
        )
      }
      // Solo lo que existe: una persona o demo que el modelo nombró y no es de este cliente queda sin ligar.
      const contactIds = new Set(facts.contacts.map((contact) => contact.id))
      const demoIds = new Set(facts.demos.map((demo) => demo.id))
      const contactOf = (id: string | null) => (id && contactIds.has(id) ? id : null)
      return {
        annotation: {
          ...annotation,
          activity: { ...annotation.activity, contactId: contactOf(annotation.activity.contactId) },
          task: annotation.task
            ? {
                ...annotation.task,
                contactId: contactOf(annotation.task.contactId),
                demoId:
                  annotation.task.demoId && demoIds.has(annotation.task.demoId)
                    ? annotation.task.demoId
                    : null,
              }
            : null,
        },
        contacts: facts.contacts,
        demos: facts.demos,
        // «plantilla» si el modelo no está configurado: la pantalla lo dice junto a lo ordenado.
        drafter: kairos.drafter ?? "modelo",
      }
    })
  })

  /** Guarda lo revisado de «Anotar», todo o nada: personas nuevas, datos, la actividad y la tarea. */
  app.post(`/${ID}/annotate`, async (c) => {
    const raw = await bodyOf(c)
    return staffRun(c, 201, async (actor) => {
      const body = parse(annotateBody, raw)
      const clientId = c.req.param("id")
      return owner(async (tx) => {
        const contacts = []
        for (const person of body.newContacts) {
          contacts.push(
            await addClientContact(tx, actor, clientId, {
              name: person.name,
              title: person.title ?? null,
              roles: person.roles,
            }),
          )
        }
        const data = Object.fromEntries(
          Object.entries(body.data).filter(([, value]) => value !== undefined),
        )
        const client = Object.keys(data).length
          ? await updateClient(tx, actor, clientId, data)
          : null
        const activity = await addActivity(tx, actor, clientId, {
          kind: body.activity.kind,
          direction: body.activity.direction,
          outcome: body.activity.outcome ?? null,
          body: body.activity.body,
          contactId: body.activity.contactId ?? null,
        })
        const task = body.task
          ? await createClientTask(tx, actor, clientId, {
              kind: body.task.kind,
              title: body.task.title,
              dueOn: body.task.dueOn,
              dueAt: at(body.task.dueAt),
              contactId: body.task.contactId ?? null,
              demoId: body.task.demoId ?? null,
            })
          : null
        return { activity, task, contacts, client }
      })
    })
  })

  app.post(`/${ID}/tasks`, async (c) => {
    const raw = await bodyOf(c)
    return staffRun(c, 201, (actor) => {
      const body = parse(taskBody, raw)
      return owner((tx) =>
        createClientTask(tx, actor, c.req.param("id"), { ...body, dueAt: at(body.dueAt) }),
      )
    })
  })

  /* ----- Decidir, la venta, invitar y dar de alta (solo Administración) ----- */

  app.post(`/${ID}/decide`, async (c) => {
    const raw = await bodyOf(c)
    return adminRun(c, 200, (actor) => {
      const body = parse(decideBody, raw)
      return owner((tx) => decide(tx, actor, c.req.param("id"), body))
    })
  })

  app.post(`/${ID}/reopen`, (c) =>
    adminRun(c, 200, (actor) =>
      owner((tx) => reopenClientOpportunity(tx, actor, c.req.param("id"))),
    ),
  )

  app.post(`/${ID}/opportunity`, async (c) => {
    const raw = await bodyOf(c)
    return adminRun(c, 200, (actor) => {
      const body = parse(opportunityBody, raw)
      return owner((tx) => setOpportunity(tx, actor, c.req.param("id"), body))
    })
  })

  /**
   * Invitar con la única operación de invitar. Devuelve el enlace (para
   * WhatsApp) y, con `send`, lo envía por correo después del commit: si no
   * sale, la invitación sigue vigente, la pantalla lo dice y no se repite sola.
   */
  app.post(`/${ID}/invite`, async (c) => {
    const raw = await bodyOf(c)
    return adminRun(c, 200, async (actor) => {
      const body = parse(inviteBody, raw)
      const { send, ...input } = body
      const issued = await owner(async (tx) => {
        const result = await inviteClient(tx, actor, c.req.param("id"), input)
        const [request] = await tx
          .select({
            firstName: saasWaitlistRequest.firstName,
            clinicName: saasWaitlistRequest.clinicName,
            product: saasWaitlistRequest.product,
          })
          .from(saasWaitlistRequest)
          .where(eq(saasWaitlistRequest.id, result.requestId))
          .limit(1)
        const [plan] = await tx
          .select()
          .from(saasPlan)
          .where(eq(saasPlan.id, result.planId))
          .limit(1)
        if (!request || !plan)
          throw new ServiceError("NOT_FOUND", 404, "La invitación no quedó completa")
        return { ...result, request, offer: await founderOffer(tx, plan) }
      })
      const product: ClinicalProduct = isClinicalProduct(issued.request.product)
        ? issued.request.product
        : "dental"
      const url = `${deps.panelUrlOf(product).replace(/\/+$/, "")}/register?invitacion=${encodeURIComponent(issued.token)}`
      let emailSent = false
      if (send) {
        try {
          await deps.mailer.send({
            to: issued.email,
            ...founderInvitationEmail({
              firstName: issued.request.firstName,
              clinicName: issued.request.clinicName,
              email: issued.email,
              url,
              expiresText: dayText(issued.expiresAt),
              offer: issued.offer,
              replyTo: deps.invitationReplyToOf?.(product),
              brand: productWords(product).brand,
            }),
          })
          emailSent = true
          await owner((tx) => markInvitationSent(tx, issued.requestId)).catch(() => undefined)
        } catch {
          console.error(`ARM: no salió la invitación del cliente ${c.req.param("id")}`)
        }
      }
      return {
        url,
        expiresAt: issued.expiresAt,
        emailSent,
        requestId: issued.requestId,
        proposalId: issued.proposalId,
      }
    })
  })

  /**
   * «Dar de alta yo»: el alta asistida de siempre, ligada a este cliente. Con
   * una propuesta aceptada de la venta abierta, la cuenta nace en su plan y sus condiciones se
   * aplican con las operaciones de «Precio y prueba»; si no se pueden, la
   * clínica queda creada igual y lo dice (`proposal.applied = false`).
   */
  app.post(`/${ID}/assisted`, async (c) => {
    const raw = await bodyOf(c)
    return adminRun(c, 201, async (actor) => {
      const body = parse(assistedBody, raw)
      const clientId = c.req.param("id")
      const created = await owner(async (tx) => {
        const [client] = await tx
          .select({
            name: saasClient.name,
            product: saasClient.product,
            countryCode: saasClient.countryCode,
          })
          .from(saasClient)
          .where(eq(saasClient.id, clientId))
          .limit(1)
        if (!client) throw new ServiceError("NOT_FOUND", 404, "Cliente no encontrado")
        // Solo la aceptada de la venta abierta: la de una venta anterior no se aplica.
        const accepted = await acceptedProposalOfOpenSale(tx, clientId)
        const product: ClinicalProduct = isClinicalProduct(client.product)
          ? client.product
          : "dental"
        const result = await createAssistedOrganization(
          tx,
          actor,
          {
            orgName: body.orgName ?? client.name,
            slug: body.slug,
            email: body.email,
            countryCode: body.countryCode ?? client.countryCode,
            currency: body.currency,
            timezone: body.timezone,
            billingStart: body.billingStart,
            planCode: body.planCode ?? accepted?.planCode,
            sellerId: body.sellerId,
            product,
            clientId,
          },
          loaders,
        )
        let proposal: { id: string; applied: boolean; reason: string | null } | null = null
        if (accepted) {
          try {
            const outcome = await tx.transaction((inner) =>
              applyProposalTerms(inner as Db, actor, accepted.id, result.organizationId),
            )
            proposal = { id: accepted.id, applied: outcome.applied, reason: null }
          } catch (error) {
            if (!(error instanceof ServiceError)) throw error
            await writeAdminAudit(tx, actor, {
              action: "arm.proposal_not_applied",
              organizationId: result.organizationId,
              entityId: accepted.id,
              metadata: { code: error.code, clientId },
            })
            proposal = { id: accepted.id, applied: false, reason: error.message }
          }
        }
        return { ...result, product, orgName: body.orgName ?? client.name, proposal }
      })
      // La invitación de la propietaria, después del commit, como «Alta asistida».
      try {
        const [staff] = await deps.ownerDb
          .select({ name: user.name })
          .from(user)
          .where(eq(user.id, actor.userId))
          .limit(1)
        const [sent] = await deps.ownerDb
          .select({ expiresAt: invitation.expiresAt, timeZone: orgProfile.timezone })
          .from(invitation)
          .leftJoin(orgProfile, eq(orgProfile.organizationId, invitation.organizationId))
          .where(eq(invitation.id, created.invitationId))
          .limit(1)
        await deps.mailer.send({
          to: body.email,
          ...invitationTemplate({
            organizationName: created.orgName,
            inviterName: staff?.name?.trim() || "Nuestro equipo",
            url: `${deps.panelUrlOf(created.product).replace(/\/+$/, "")}/accept-invitation/${created.invitationId}`,
            brand: productWords(created.product).brand,
            expires: sent
              ? { at: sent.expiresAt, timeZone: sent.timeZone ?? "America/Lima" }
              : undefined,
          }),
        })
      } catch {
        throw new ServiceError(
          "EMAIL_FAILED",
          502,
          "Clínica creada e invitación lista, pero no se pudo enviar el correo: reenvíalo desde la ficha",
        )
      }
      const { product: _product, orgName: _orgName, ...data } = created
      return data
    })
  })

  /* ----- Presentación y propuestas del cliente ----- */

  app.post(`/${ID}/presentations`, async (c) => {
    const raw = await bodyOf(c)
    return staffRun(c, 201, (actor) => {
      const body = parse(presentationBody, raw)
      return owner((tx) =>
        schedulePresentation(tx, actor, c.req.param("id"), { ...body, dueAt: at(body.dueAt) }),
      )
    })
  })

  app.get(`/${ID}/proposals`, (c) =>
    adminRun(c, 200, (actor) => owner((tx) => listSaasProposals(tx, actor, c.req.param("id")))),
  )

  app.post(`/${ID}/proposals`, async (c) => {
    const raw = await bodyOf(c)
    return adminRun(c, 201, (actor) => {
      const body = parse(proposalBody, raw)
      return owner((tx) => createSaasProposal(tx, actor, c.req.param("id"), body))
    })
  })

  /**
   * El correo de un envío ya reservado, después del commit: sale por el canal
   * de conversaciones con quien firma, su Message-ID y el hilo, y se marca
   * `enviado`, o `incierto` si se cortó (502 `SEND_UNKNOWN`, nunca se reintenta:
   * lo resuelve una persona con «¿Salió?»).
   */
  /** Los bytes de un documento del cliente, para adjuntarlo a un correo. */
  const readClientFile = (objectKey: string): Promise<Uint8Array> => {
    if (!deps.storage.getAttachment)
      throw new ServiceError("STORAGE_UNAVAILABLE", 503, "No se pudieron leer los adjuntos")
    return deps.storage.getAttachment(objectKey)
  }

  const sendReserved = async (
    c: Context,
    actor: AdminActor,
    outreach: OutreachRow,
    mail: OutreachEmail,
  ) => {
    let result: "enviado" | "incierto" = "enviado"
    try {
      await conversations.send(outreachMailMessage(mail))
    } catch {
      // Un corte a mitad no dice si salió: queda como incierto y no se repite solo.
      result = "incierto"
    }
    let marked: OutreachRow
    try {
      marked = await owner(async (tx) => {
        const row = await markOutreachSent(tx, actor, outreach.id, result)
        await settleKairosOutreach(tx, row.id)
        return row
      })
    } catch (error) {
      // Salió (o quizá) pero no se pudo anotar: queda pendiente para que una persona diga si salió.
      console.error(`ARM: no se anotó el resultado del envío ${outreach.id}`, error)
      return c.json(
        {
          error: {
            ...errorBody(
              c,
              "SEND_UNKNOWN",
              "No se pudo anotar si el correo salió: revisa en Zoho y marca si salió o no",
            ).error,
            outreachId: outreach.id,
          },
        },
        502,
      )
    }
    if (result === "incierto")
      return c.json(
        {
          error: {
            ...errorBody(
              c,
              "SEND_UNKNOWN",
              "No se sabe si el correo salió: revisa en Zoho y marca si salió o no antes de volver a enviarlo",
            ).error,
            outreachId: marked.id,
          },
        },
        502,
      )
    return c.json({ data: { outreach: marked, url: null } }, 201)
  }

  /**
   * Escribir. Correo: se reserva (`pendiente`), sale después del commit con la
   * marca del producto y quien escribe (`sendReserved`). WhatsApp: devuelve el
   * enlace con el texto y queda pendiente hasta «Salió»/«No salió».
   */
  app.post(`/${ID}/outreach`, async (c) => {
    const raw = await bodyOf(c)
    try {
      const actor = staffOf(c)
      const body = parse(outreachBody, raw)
      const { outreach, mail } = await owner(async (tx) => {
        const row = await prepareOutreach(tx, actor, c.req.param("id"), body)
        // El correo se arma dentro de la reserva: si no se puede armar, no queda nada pendiente.
        return {
          outreach: row,
          mail: row.channel === "correo" ? await outreachEmail(tx, row.id, readClientFile) : null,
        }
      })
      if (!mail) return c.json({ data: { outreach, url: outreach.whatsappUrl } }, 201)
      return await sendReserved(c, actor, outreach, mail)
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  /* ----- Alta, documentos, borradores ----- */

  app.get(`/${ID}/onboarding`, (c) =>
    staffRun(c, 200, (actor) => owner((tx) => onboardingSteps(tx, actor, c.req.param("id")))),
  )

  app.get(`/${ID}/files`, (c) =>
    staffRun(c, 200, (actor) => owner((tx) => listClientFiles(tx, actor, c.req.param("id")))),
  )

  /**
   * Subir un documento (multipart `file`, `kind`, `adminOnly`): el tipo real se
   * revisa por su contenido, se sube fuera de la transacción y, si el registro
   * falla, el objeto se borra.
   */
  app.post(`/${ID}/files`, async (c) => {
    const clientId = c.req.param("id")
    const declaredSize = Number(c.req.header("content-length") ?? 0)
    if (Number.isFinite(declaredSize) && declaredSize > CLIENT_FILE_UPLOAD_MAX_BYTES + 65_536)
      return c.json(errorBody(c, "BODY_TOO_LARGE", "El archivo no puede superar 10 MB"), 413)
    try {
      const actor = staffOf(c)
      const form = await c.req.formData().catch(() => null)
      const file = form?.get("file")
      if (!(file instanceof File))
        throw new ServiceError("VALIDATION", 400, "Adjunta un archivo", {
          file: "Adjunta un archivo",
        })
      if (file.size > CLIENT_FILE_UPLOAD_MAX_BYTES)
        throw new ServiceError("VALIDATION", 400, "El archivo no puede superar 10 MB", {
          file: "El archivo no puede superar 10 MB",
        })
      const rawKind = form?.get("kind")
      const kind = (typeof rawKind === "string" && rawKind ? rawKind : "otro") as SaasClientFileKind
      if (!SAAS_CLIENT_FILE_KINDS.includes(kind))
        throw new ServiceError("VALIDATION", 400, "Elige un tipo de documento", {
          kind: "Elige un tipo de documento",
        })
      const rawAdminOnly = form?.get("adminOnly")
      // Por defecto: lo de Administración queda solo para Administración; lo que sube Soporte, a la vista de todo el equipo.
      const adminOnly =
        rawAdminOnly === "true" ? true : rawAdminOnly === "false" ? false : actor.role === "admin"
      if (actor.role !== "admin" && adminOnly)
        throw new ServiceError("FORBIDDEN", 403, "Ese documento es solo de Administración")
      const bytes = new Uint8Array(await file.arrayBuffer())
      // Lo mismo que se acepta de un correo que llega: por sus bytes, nunca por el tipo que dice.
      const allowed = allowedInboundAttachment(bytes, file.name, file.type)
      if (!allowed)
        throw new ServiceError("VALIDATION", 400, CLIENT_FILE_TYPES_WORDS, {
          file: CLIENT_FILE_TYPES_WORDS,
        })
      const sniffed = { ext: allowed.ext, mimeType: allowed.contentType }
      if (!deps.storage.putAttachmentAt)
        throw new ServiceError(
          "STORAGE_UNAVAILABLE",
          503,
          "No se pudo guardar el archivo. Inténtalo de nuevo.",
        )
      const objectKey = clientFileKey(clientId, sniffed.ext)
      // Fuera de la transacción: primero la subida, después el registro.
      await deps.storage.putAttachmentAt(objectKey, bytes, sniffed.mimeType)
      try {
        const row = await owner((tx) =>
          registerClientFile(tx, actor, {
            clientId,
            kind,
            filename: filenameForType(file.name, sniffed.mimeType),
            objectKey,
            contentType: sniffed.mimeType,
            sizeBytes: file.size,
            adminOnly,
          }),
        )
        return c.json({ data: row }, 201)
      } catch (error) {
        await deps.storage.deleteAttachment(objectKey).catch(() => {})
        throw error
      }
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  return app
}
