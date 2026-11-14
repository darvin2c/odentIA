/**
 * El alta de una clínica que entró (ficha del cliente › Alta): los pasos para
 * que empiece a trabajar, cada uno con su fecha o con lo que falta. Cada paso
 * sale de lo que ya pasó (la cuenta, el contrato de encargo, los documentos, el
 * registro de la carga, el equipo, el canal, las sesiones y los pagos) y de su
 * primera vez guardada (`saas_client_milestone`, que escribe la pasada de
 * Kairós con `syncOnboardingMilestones`): un paso hecho no vuelve a faltar
 * aunque el hecho cambie después (se borran las sesiones, cambia la versión del
 * contrato, llega otra invitación), salvo el primer pago revertido y los datos
 * que se borraron sin cargar. Una persona solo marca «No aplica», con su motivo,
 * en equipo, WhatsApp y pacientes.
 *
 * La carga y el informe los hace la skill en el servidor (ADR 0183): sus pasos
 * salen del mismo registro que muestra Alta (`listClinicLoads` y
 * `listProgressReports`), nunca de una copia, y ningún paso ofrece cargar ni
 * enviar. Soporte ve los pasos (sin importes: ningún paso los dice), pero no
 * las acciones que son de Administración.
 */

import { AGREEMENT_VERSION } from "@odentia/auth/legal"
import { type ClinicalProduct, isClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  SAAS_MILESTONE_NA_STEPS,
  type SaasMilestoneLostReason,
  type SaasMilestoneNaStep,
  type SaasMilestoneSource,
  saasClient,
  saasClientFile,
  saasClientMilestone,
  saasInboundEmail,
} from "@odentia/db/schema/admin-arm"
import { adminAudit, adminStaff } from "@odentia/db/schema/admin-core"
import { clinicImportRow } from "@odentia/db/schema/admin-imports"
import { invitation, member, organization, session, user } from "@odentia/db/schema/auth"
import { channelConnection, conversation, message } from "@odentia/db/schema/crm"
import { saasPayment, saasSubscription } from "@odentia/db/schema/saas-billing"
import { processingAgreementAcceptance } from "@odentia/db/schema/workspace"
import { and, asc, count, desc, eq, gte, inArray, min, ne, type SQL, sql } from "drizzle-orm"
import { enteredAtSql, notDemoOrg } from "./admin-alta-sql.js"
import { type AdminActor, writeAdminAudit } from "./admin-core.js"
import type { PipelineFilter } from "./admin-sales.js"
import { listClinicLoads, listProgressReports } from "./clinic-progress-report.js"
import { invalidField, notFound, ServiceError } from "./errors.js"
import { limaDate } from "./peru-business-days.js"

export const ONBOARDING_STEP_KEYS = [
  "entro",
  "contrato",
  "carta",
  "archivos",
  "configuracion",
  "pacientes",
  "informe",
  "equipo",
  "whatsapp",
  "primer_uso",
  "primer_pago",
] as const
export type OnboardingStepKey = (typeof ONBOARDING_STEP_KEYS)[number]

/** Lo que se puede hacer para avanzar un paso; la pantalla lo lleva a su lugar. */
export interface OnboardingAction {
  code: "reenviar_invitacion" | "subir_carta" | "subir_archivos" | "revisar_informe"
  label: string
  /** Solo Administración (los archivos de la clínica y el registro de la carga). */
  adminOnly: boolean
}

/** A quién le toca un paso que falta: a la clínica, a nosotros (Sallca) o a Meta. */
export type OnboardingWaitingOn = "clinica" | "nosotros" | "meta"
export type OnboardingStepState = "hecho" | "no_aplica" | "falta"

export interface OnboardingStep {
  key: OnboardingStepKey
  label: string
  state: OnboardingStepState
  /** Cuándo quedó hecho (la primera vez); nulo si falta o no aplica. */
  doneAt: Date | null
  /** En palabras: lo que pasó o lo que falta. */
  detail: string
  /** A quién le toca; nulo si está hecho o no aplica. */
  waitingOn: OnboardingWaitingOn | null
  /** «No aplica», con su motivo, quién lo marcó (su nombre) y cuándo. */
  notApplicable?: { reason: string; by: string | null; at: Date }
  /** Quien lee puede marcar o quitar «No aplica» en este paso. */
  canMarkNotApplicable: boolean
  /** El motivo que se sugiere al marcarlo (solo si quien lee puede y el paso falta). */
  suggestedReason?: string
  /** Lo único que hace retroceder un paso alcanzado. */
  lost?: { at: Date; reason: SaasMilestoneLostReason }
  action?: OnboardingAction
}

/** Lo que se calcula sin quien lee: lo usan la ficha, la pasada de Kairós y el Embudo. */
export interface OnboardingComputed {
  clientId: string
  organizationId: string | null
  steps: OnboardingStep[]
  done: number
  /** Los pasos que cuentan: los 11 menos los que no aplican. */
  total: number
  notApplicable: number
  /** El primer paso que falta, o nulo si no falta ninguno. */
  next: OnboardingStepKey | null
  /** Cuándo entró la propietaria. */
  enteredAt: Date | null
  /** El último avance: lo más nuevo entre lo hecho y lo marcado «No aplica»; si no hay, la entrada. */
  lastProgressAt: Date | null
  column: OnboardingColumn | null
  stuck: boolean
  /** La prueba sigue vigente (no cuenta como trabada en «Primer pago»). */
  trialActive: boolean
  /** Desde cuándo se guardan sus pasos (el primer registro de sus hitos). */
  trackedSince: Date | null
}

export type OnboardingSteps = OnboardingComputed

/** «Conectar con Facebook» está configurado: sin él, el paso de WhatsApp dice «Espera a Meta». */
export interface OnboardingOptions {
  metaSignupAvailable: boolean
}
const NO_META: OnboardingOptions = { metaSignupAvailable: false }

/* ---------- Grupos, columna y lo trabado (Embudo «Alta» y Kairós) ---------- */

export const ONBOARDING_GROUPS = [
  { key: "bienvenida", label: "Bienvenida", steps: ["entro", "contrato", "carta"] },
  {
    key: "sus_datos",
    label: "Sus datos",
    steps: ["archivos", "configuracion", "pacientes", "informe"],
  },
  { key: "arranque", label: "Arranque", steps: ["equipo", "whatsapp", "primer_uso"] },
  { key: "primer_pago", label: "Primer pago", steps: ["primer_pago"] },
] as const satisfies ReadonlyArray<{
  key: string
  label: string
  steps: readonly OnboardingStepKey[]
}>
/** La columna del Embudo «Alta»: un grupo, o «pago» cuando ya pagó aunque falten pasos. */
export type OnboardingColumn = (typeof ONBOARDING_GROUPS)[number]["key"] | "pago"

/** Sin avance en estos días, el alta está trabada. */
export const ALTA_STUCK_DAYS = 7
/** Pagó hace más de estos días: deja el Embudo «Alta» (y la pasada lo salta si no le falta nada). */
export const ALTA_PAID_DAYS = 30
const DAY_MS = 86_400_000

/**
 * Dónde va un alta: nula sin cuenta (sigue en Venta); «pago» si el primer pago está hecho; si
 * no, el primer grupo con un paso que falta.
 */
export function onboardingColumn(
  steps: ReadonlyArray<Pick<OnboardingStep, "key" | "state">>,
  hasAccount: boolean,
): OnboardingColumn | null {
  if (!hasAccount) return null
  const stateOf = new Map(steps.map((item) => [item.key, item.state]))
  if (stateOf.get("primer_pago") === "hecho") return "pago"
  const group = ONBOARDING_GROUPS.find((item) =>
    item.steps.some((key) => (stateOf.get(key) ?? "falta") === "falta"),
  )
  return group?.key ?? "pago"
}

/**
 * Trabada: `ALTA_STUCK_DAYS` o más sin avance, en una columna distinta de «pago» y, en «Primer
 * pago», solo cuando ya no hay prueba vigente. Los días cuentan desde lo más nuevo entre el
 * último avance y el primer registro de sus hitos: al desplegar, un alta vieja no amanece
 * trabada por fechas que nadie vigilaba.
 */
export function isStuck(
  lastProgressAt: Date | null,
  column: OnboardingColumn | null,
  now: Date,
  options: { trialActive?: boolean; trackedSince?: Date | null } = {},
): boolean {
  if (!column || column === "pago") return false
  if (column === "primer_pago" && options.trialActive) return false
  const since = latest(lastProgressAt, options.trackedSince ?? null)
  if (!since) return false
  return now.getTime() - since.getTime() >= ALTA_STUCK_DAYS * DAY_MS
}

/** Lo que falta de cada paso, corto, para el Embudo y las tareas de Kairós. */
export const ALTA_MISSING_WORDS: Record<OnboardingStepKey, string> = {
  entro: "que la propietaria acepte su invitación",
  contrato: "que acepte el contrato de encargo",
  carta: "subir la carta de bienvenida",
  archivos: "que la clínica mande sus datos",
  configuracion: "cargar su configuración",
  pacientes: "cargar sus pacientes",
  informe: "enviarle el informe",
  equipo: "que entre su equipo",
  whatsapp: "que conecte su WhatsApp",
  primer_uso: "que alguien de la clínica entre",
  primer_pago: "su primer pago confirmado",
}

/** El motivo que se sugiere al marcar «No aplica» (se puede cambiar). */
export const NOT_APPLICABLE_SUGGESTED: Record<SaasMilestoneNaStep, string> = {
  equipo: "Trabaja sola",
  whatsapp: "No usa WhatsApp",
  pacientes: "No tenía lista de pacientes",
}
const NOT_APPLICABLE_MAX = 300

/* ---------- Palabras ---------- */

/** El nombre de cada paso (la ficha, el Embudo y los reportes). */
export const ONBOARDING_STEP_LABELS: Record<OnboardingStepKey, string> = {
  entro: "Entró",
  contrato: "Contrato de encargo aceptado",
  carta: "Carta de bienvenida subida",
  archivos: "Datos recibidos",
  configuracion: "Configuración cargada",
  pacientes: "Pacientes cargados",
  informe: "Informe enviado",
  equipo: "Equipo dentro",
  whatsapp: "WhatsApp conectado",
  primer_uso: "Primer uso",
  primer_pago: "Primer pago confirmado",
}
const LABELS = ONBOARDING_STEP_LABELS
const WAITING_META_LABEL = "Espera a Meta"

const ZONE = "America/Lima"

/** «12 nov» en hora de Lima. */
function day(at: Date): string {
  return new Intl.DateTimeFormat("es-PE", { timeZone: ZONE, day: "numeric", month: "short" })
    .format(at)
    .replace(".", "")
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** El más temprano de los instantes que hay. */
function earliest(...dates: Array<Date | null | undefined>): Date | null {
  const present = dates.filter((date): date is Date => date instanceof Date)
  if (present.length === 0) return null
  return new Date(Math.min(...present.map((date) => date.getTime())))
}

/** El más nuevo de los instantes que hay. */
function latest(...dates: Array<Date | null | undefined>): Date | null {
  const present = dates.filter((date): date is Date => date instanceof Date)
  if (present.length === 0) return null
  return new Date(Math.max(...present.map((date) => date.getTime())))
}

/** `min()` de postgres-js puede volver como texto: siempre fecha o nulo. */
function asDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date
}

/* ---------- Hechos ---------- */

/**
 * Lo que dice el hecho de un paso: hecho (`at`, la primera vez que se ve en los datos, la misma
 * que lee el relleno de 0119) o lo que falta. `lost` hace que falte aunque esté guardado.
 */
interface Fact {
  at: Date | null
  source: SaasMilestoneSource
  detail: string
  waitingOn: OnboardingWaitingOn
  label?: string
  action?: OnboardingAction
  lost?: { at: Date; reason: SaasMilestoneLostReason }
  /** Lo que dice si el hecho ya no está y vale lo guardado. */
  keptDetail?: string
}

function fact(detail: string, at: Date | null = null, extra: Partial<Fact> = {}): Fact {
  return { at, source: "hecho", detail, waitingOn: "clinica", ...extra }
}

export interface MilestoneRow {
  step: OnboardingStepKey
  reachedAt: Date | null
  source: SaasMilestoneSource | null
  lostAt: Date | null
  lostReason: SaasMilestoneLostReason | null
  naReason: string | null
  naBy: string | null
  naByName: string | null
  naAt: Date | null
  createdAt: Date
}

/** Los hitos guardados de un cliente, por paso. */
export async function readMilestones(
  tx: Db,
  clientId: string,
): Promise<Map<OnboardingStepKey, MilestoneRow>> {
  const rows = await tx
    .select({
      step: saasClientMilestone.step,
      reachedAt: saasClientMilestone.reachedAt,
      source: saasClientMilestone.source,
      lostAt: saasClientMilestone.lostAt,
      lostReason: saasClientMilestone.lostReason,
      naReason: saasClientMilestone.naReason,
      naBy: saasClientMilestone.naBy,
      naByName: user.name,
      naAt: saasClientMilestone.naAt,
      createdAt: saasClientMilestone.createdAt,
    })
    .from(saasClientMilestone)
    .leftJoin(user, eq(user.id, saasClientMilestone.naBy))
    .where(eq(saasClientMilestone.clientId, clientId))
  return new Map(rows.map((row) => [row.step as OnboardingStepKey, row as MilestoneRow]))
}

/** Hecho: por el hecho o por lo guardado (sin contar lo perdido). */
const reached = (
  key: OnboardingStepKey,
  facts: Partial<Record<OnboardingStepKey, Fact>>,
  m: Map<OnboardingStepKey, MilestoneRow>,
) => Boolean(facts[key]?.at) || Boolean(m.get(key)?.reachedAt)

/**
 * Combina el hecho con lo guardado: lo perdido falta aunque esté guardado; hecho, la primera
 * vez es la más temprana de las dos; sin el hecho, vale lo guardado; si no, «No aplica» o falta.
 */
export function withMilestone(
  key: OnboardingStepKey,
  current: Fact,
  milestone: MilestoneRow | undefined,
): OnboardingStep {
  const base = { key, label: current.label ?? LABELS[key], canMarkNotApplicable: false }
  const withAction = (item: OnboardingStep): OnboardingStep =>
    current.action ? { ...item, action: current.action } : item
  if (current.lost)
    return withAction({
      ...base,
      state: "falta",
      doneAt: null,
      detail: current.detail,
      waitingOn: current.waitingOn,
      lost: current.lost,
    })
  // Lo que se puede perder y volver a alcanzar cuenta desde la vez guardada (la nueva): el hecho
  // también ve lo de antes de perderlo.
  const losable = key === "archivos" || key === "primer_pago"
  const doneAt = current.at
    ? losable && milestone?.reachedAt
      ? milestone.reachedAt
      : earliest(current.at, milestone?.reachedAt)
    : (milestone?.reachedAt ?? null)
  if (doneAt)
    return withAction({
      ...base,
      label: LABELS[key],
      state: "hecho",
      doneAt,
      detail: current.at
        ? current.detail
        : (current.keptDetail ?? "Hecho: quedó guardada la primera vez"),
      waitingOn: null,
    })
  if (milestone?.naReason && milestone.naAt)
    return {
      ...base,
      label: LABELS[key],
      state: "no_aplica",
      doneAt: null,
      detail: `No aplica: ${milestone.naReason}`,
      waitingOn: null,
      notApplicable: { reason: milestone.naReason, by: milestone.naByName, at: milestone.naAt },
    }
  return withAction({
    ...base,
    state: "falta",
    doneAt: null,
    detail: current.detail,
    waitingOn: current.waitingOn,
  })
}

/** Lo de Documentos: la carta (también lo borrado) y lo que llegó como la carga. */
async function letterFact(tx: Db, clientId: string): Promise<Fact> {
  const [carta] = await tx
    .select({ n: count(), first: min(saasClientFile.createdAt) })
    .from(saasClientFile)
    .where(and(eq(saasClientFile.clientId, clientId), eq(saasClientFile.kind, "carta")))
  const first = asDate(carta?.first)
  return first
    ? fact(`Se subió el ${day(first)}`, first)
    : fact("Falta: prepara la carta de bienvenida y guárdala en Documentos", null, {
        waitingOn: "nosotros",
        action: { code: "subir_carta", label: "Subir la carta", adminOnly: true },
      })
}

const UPLOAD_FILES: OnboardingAction = {
  code: "subir_archivos",
  label: "Subir lo que mandó",
  adminOnly: true,
}

/**
 * «Datos recibidos»: solo lo que Administración marcó como la carga (`archivo_clinica`), desde
 * que llegó (`received_at`), también lo ya borrado. Un correo a soporte@ con adjuntos cuenta
 * solo si la clínica ya tuvo una carga (`respaldo`: lo de antes de marcar la carga). Vuelve a
 * faltar si se borró sin cargar: no queda ninguno vivo, el último se borró solo al vencer
 * (no a mano), nunca hubo una carga y aún no pagó. Perdido, cuenta lo que llegó después.
 */
async function receivedFact(
  tx: Db,
  clientId: string,
  orgId: string | null,
  ctx: { everLoaded: boolean; paid: boolean; lostAt: Date | null },
): Promise<Fact> {
  const files = await tx
    .select({
      receivedAt: saasClientFile.receivedAt,
      deletedAt: saasClientFile.deletedAt,
      expired: sql<boolean>`coalesce((${saasClientFile.deletedAt} at time zone ${ZONE})::date >= ${saasClientFile.deleteAfter}, false)`,
    })
    .from(saasClientFile)
    .where(and(eq(saasClientFile.clientId, clientId), eq(saasClientFile.kind, "archivo_clinica")))
    .orderBy(desc(saasClientFile.receivedAt))
  const newest = files[0]
  if (
    newest &&
    files.every((file) => file.deletedAt !== null) &&
    newest.expired &&
    newest.deletedAt &&
    !ctx.everLoaded &&
    !ctx.paid
  )
    return fact(
      `Se borraron sin cargar el ${day(newest.deletedAt)}: falta que la clínica los vuelva a mandar`,
      null,
      { lost: { at: newest.deletedAt, reason: "borrados_sin_cargar" }, action: UPLOAD_FILES },
    )
  const lostAt = ctx.lostAt
  const counted = lostAt
    ? files.filter((file) => file.deletedAt === null || file.deletedAt.getTime() > lostAt.getTime())
    : files
  const first = earliest(...counted.map((file) => file.receivedAt))
  if (first)
    return fact(`Desde el ${day(first)}: ${plural(counted.length, "archivo", "archivos")}`, first)
  if (orgId && ctx.everLoaded && !lostAt) {
    const [mail] = await tx
      .select({ n: count(), first: min(saasInboundEmail.receivedAt) })
      .from(saasInboundEmail)
      .where(
        and(
          eq(saasInboundEmail.clientId, clientId),
          eq(saasInboundEmail.mailbox, "soporte"),
          sql`jsonb_array_length(${saasInboundEmail.attachments}) > 0`,
        ),
      )
    const firstMail = asDate(mail?.first)
    if (firstMail)
      return fact(
        `Desde el ${day(firstMail)}: ${plural(mail?.n ?? 0, "correo con adjuntos", "correos con adjuntos")} a soporte@, de antes de marcar la carga`,
        firstMail,
        { source: "respaldo" },
      )
  }
  return fact("Falta: la clínica aún no mandó sus datos", null, { action: UPLOAD_FILES })
}

/**
 * «Ya se cargó» después de lo último que llegó como la carga: hay una configuración o una tanda
 * de pacientes de su organización desde el `received_at` del `archivo_clinica` más nuevo del
 * cliente. `clientAlias` es el alias SQL de `saas_client`; `orgExpr`, su organización.
 */
export function cargaLoadedSql(clientAlias: string, orgExpr?: SQL): SQL {
  if (!/^[a-z_][a-z0-9_]*$/.test(clientAlias)) throw new Error("Alias no válido")
  const org = orgExpr ?? sql.raw(`${clientAlias}.organization_id`)
  return sql`exists (select 1 from ${adminAudit} l
    where l.organization_id = ${org} and l.action in ('org.setup_import', 'org.data_import')
      and l.created_at >= (select max(f.received_at) from ${saasClientFile} f
        where f.client_id = ${sql.raw(`${clientAlias}.id`)} and f.kind = 'archivo_clinica'))`
}

async function stepsWithoutAccount(
  tx: Db,
  clientId: string,
  milestones: Map<OnboardingStepKey, MilestoneRow>,
): Promise<Record<OnboardingStepKey, Fact>> {
  const missing = "Falta: primero tiene que abrir su cuenta"
  const lostAt = milestones.get("archivos")?.lostAt ?? null
  return {
    entro: fact("Aún no tiene cuenta: invítala o dale de alta", null, { waitingOn: "nosotros" }),
    contrato: fact(missing),
    carta: await letterFact(tx, clientId),
    archivos: await receivedFact(tx, clientId, null, { everLoaded: false, paid: false, lostAt }),
    configuracion: fact(missing, null, { waitingOn: "nosotros" }),
    pacientes: fact(missing, null, { waitingOn: "nosotros" }),
    informe: fact(missing, null, { waitingOn: "nosotros" }),
    equipo: fact(missing),
    whatsapp: fact(missing),
    primer_uso: fact(missing),
    primer_pago: fact(missing),
  }
}

async function factsOf(
  tx: Db,
  clientId: string,
  orgId: string,
  now: Date,
  options: OnboardingOptions,
  milestones: Map<OnboardingStepKey, MilestoneRow>,
): Promise<Record<OnboardingStepKey, Fact>> {
  const [org] = await tx
    .select({ createdAt: organization.createdAt })
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1)
  const orgCreatedAt = org?.createdAt ?? null
  const facts: Partial<Record<OnboardingStepKey, Fact>> = {}

  // 1. Entró: la propietaria es parte de la clínica.
  const [owner] = await tx
    .select({ at: member.createdAt })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.role, "owner")))
    .orderBy(asc(member.createdAt))
    .limit(1)
  if (owner) facts.entro = fact(`La propietaria entró el ${day(owner.at)}`, owner.at)
  else {
    const [pending] = await tx
      .select({ expiresAt: invitation.expiresAt })
      .from(invitation)
      .where(
        and(
          eq(invitation.organizationId, orgId),
          eq(invitation.role, "owner"),
          eq(invitation.status, "pending"),
        ),
      )
      .orderBy(desc(invitation.createdAt))
      .limit(1)
    const since = orgCreatedAt
      ? `La cuenta existe desde el ${day(orgCreatedAt)}`
      : "La cuenta existe"
    facts.entro = pending
      ? fact(
          `${since}; la propietaria no aceptó la invitación (${pending.expiresAt.getTime() > now.getTime() ? `vence el ${day(pending.expiresAt)}` : "venció"})`,
          null,
          {
            waitingOn: "clinica",
            action: {
              code: "reenviar_invitacion",
              label: "Reenviar la invitación",
              adminOnly: false,
            },
          },
        )
      : fact(`${since}; aún no tiene propietaria`, null, { waitingOn: "nosotros" })
  }

  // 2. Contrato de encargo: la primera aceptación, de cualquier versión. Una versión nueva no
  // lo reabre: se le pide al entrar y el detalle lo dice.
  const accepted = await tx
    .select({
      version: processingAgreementAcceptance.version,
      at: processingAgreementAcceptance.acceptedAt,
    })
    .from(processingAgreementAcceptance)
    .where(eq(processingAgreementAcceptance.organizationId, orgId))
    .orderBy(desc(processingAgreementAcceptance.acceptedAt))
  const firstAccepted = accepted.at(-1)
  const current = accepted.find((row) => row.version === AGREEMENT_VERSION)
  facts.contrato = firstAccepted
    ? fact(
        current
          ? `Aceptó la versión del ${current.version} el ${day(current.at)}`
          : `Aceptó la versión del ${firstAccepted.version} el ${day(firstAccepted.at)}; falta la vigente, del ${AGREEMENT_VERSION} (se le pide al entrar)`,
        firstAccepted.at,
      )
    : fact("Falta: se le pide a quien administra la clínica al entrar")

  // 3. Carta.
  facts.carta = await letterFact(tx, clientId)

  // 5, 6 y 7. La carga y el informe: del registro que muestra Alta (lo que hizo la skill). La
  // primera vez es la de la primera fila del registro, como en el relleno de 0119.
  const [firsts] = await tx
    .select({
      setup: sql<Date | null>`min(${adminAudit.createdAt}) filter (where ${adminAudit.action} = 'org.setup_import')`,
      data: sql<Date | null>`min(${adminAudit.createdAt}) filter (where ${adminAudit.action} = 'org.data_import')`,
      sent: sql<Date | null>`min(case when ${adminAudit.metadata}->>'sentAt' ~ '^\\d{4}-\\d{2}-\\d{2}'
        then (${adminAudit.metadata}->>'sentAt')::timestamptz else ${adminAudit.createdAt} end)
        filter (where ${adminAudit.action} = 'org.progress_report_sent')`,
    })
    .from(adminAudit)
    .where(
      and(
        eq(adminAudit.organizationId, orgId),
        inArray(adminAudit.action, [
          "org.setup_import",
          "org.data_import",
          "org.progress_report_sent",
        ]),
      ),
    )
  const loads = await listClinicLoads(tx, orgId)
  const setupAt = asDate(firsts?.setup)
  const firstSetup = loads.filter((load) => load.kind === "configuracion").at(-1)
  facts.configuracion = setupAt
    ? fact(`Cargada el ${day(setupAt)}${firstSetup ? `: ${firstSetup.summary}` : ""}`, setupAt)
    : fact("Falta: la carga la hace la skill de carga en el servidor", null, {
        waitingOn: "nosotros",
      })

  const [people] = await tx
    .select({ n: count(), first: min(clinicImportRow.createdAt) })
    .from(clinicImportRow)
    .where(eq(clinicImportRow.organizationId, orgId))
  const peopleFirst = earliest(asDate(people?.first), asDate(firsts?.data))
  facts.pacientes = peopleFirst
    ? fact(
        `Desde el ${day(peopleFirst)}: ${plural(people?.n ?? 0, "persona en la carga", "personas en la carga")}`,
        peopleFirst,
      )
    : fact("Falta: la carga la hace la skill de carga en el servidor", null, {
        waitingOn: "nosotros",
      })

  const reports = await listProgressReports(tx, orgId)
  const sent = reports
    .filter((report) => report.state === "enviado")
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const firstSentAt = asDate(firsts?.sent)
  const pendingReport = reports.find((report) => report.state !== "enviado")
  const lastSent = sent.at(-1)
  const reviewReport: OnboardingAction = {
    code: "revisar_informe",
    label: "Revisar el informe",
    adminOnly: true,
  }
  facts.informe = pendingReport
    ? fact(
        pendingReport.state === "desconocido"
          ? `No se sabe si salió el informe N.º ${pendingReport.number}: revisa en Zoho si salió`
          : `El informe N.º ${pendingReport.number} quedó enviándose: revisa en Zoho si salió`,
        firstSentAt,
        { waitingOn: "nosotros", action: reviewReport },
      )
    : lastSent && firstSentAt
      ? fact(
          lastSent.registeredLater
            ? `${plural(sent.length, "informe", "informes")}; el último, N.º ${lastSent.number}, salió el ${day(new Date(lastSent.at))} por correo aparte y se registró después`
            : `${plural(sent.length, "informe", "informes")}; el último, N.º ${lastSent.number}, salió el ${day(new Date(lastSent.at))}`,
          firstSentAt,
        )
      : fact("Falta: la skill lo envía con tu aprobación", null, { waitingOn: "nosotros" })

  // 11. Primer pago confirmado (sin importes: Soporte también lo lee). Cuenta mientras quede uno
  // confirmado o devuelto (lo devuelto se pagó); con solo pagos revertidos, se perdió. Perdido,
  // cuenta lo que se confirmó después.
  const payments = await tx
    .select({
      status: saasPayment.status,
      confirmedAt: saasPayment.confirmedAt,
      reversedAt: saasPayment.reversedAt,
      updatedAt: saasPayment.updatedAt,
    })
    .from(saasPayment)
    .where(eq(saasPayment.organizationId, orgId))
  const payLostAt =
    milestones.get("primer_pago")?.lostReason === "pago_revertido"
      ? (milestones.get("primer_pago")?.lostAt ?? null)
      : null
  const counted = payments.filter(
    (row) =>
      row.confirmedAt &&
      ["confirmado", "devuelto", "reversado"].includes(row.status) &&
      (!payLostAt || row.confirmedAt.getTime() > payLostAt.getTime()),
  )
  const paidAt = counted.some((row) => row.status !== "reversado")
    ? earliest(...counted.map((row) => row.confirmedAt))
    : null
  const reversed = payments
    .filter((row) => row.status === "reversado")
    .sort(
      (a, b) => (b.reversedAt ?? b.updatedAt).getTime() - (a.reversedAt ?? a.updatedAt).getTime(),
    )[0]
  const paymentPending = payments.some((row) => row.status === "pendiente")
  const stillPaid = payments.some((row) => row.status === "confirmado" || row.status === "devuelto")
  facts.primer_pago = paidAt
    ? fact(`Confirmado el ${day(paidAt)}`, paidAt)
    : reversed && !stillPaid
      ? fact(
          `Se revirtió el pago confirmado el ${day(reversed.confirmedAt ?? reversed.updatedAt)}: falta un pago confirmado`,
          null,
          {
            lost: { at: reversed.reversedAt ?? reversed.updatedAt, reason: "pago_revertido" },
            waitingOn: paymentPending ? "nosotros" : "clinica",
          },
        )
      : paymentPending
        ? fact("Hay un comprobante por confirmar", null, { waitingOn: "nosotros" })
        : fact("Falta: aún no hay un pago confirmado")

  // 4. Datos recibidos: necesita saber si hubo carga o pago (no retrocede después).
  facts.archivos = await receivedFact(tx, clientId, orgId, {
    everLoaded:
      reached("configuracion", facts, milestones) || reached("pacientes", facts, milestones),
    paid: Boolean(facts.primer_pago.at) || Boolean(milestones.get("primer_pago")?.reachedAt),
    lostAt:
      milestones.get("archivos")?.lostReason === "borrados_sin_cargar"
        ? (milestones.get("archivos")?.lostAt ?? null)
        : null,
  })

  // 8. Equipo: las invitaciones (que no son de propietaria) y quiénes ya entraron. Hecho solo
  // sin invitaciones pendientes; después, una invitación nueva no lo reabre (queda guardado).
  const invites = await tx
    .select({ status: invitation.status, expiresAt: invitation.expiresAt })
    .from(invitation)
    .where(and(eq(invitation.organizationId, orgId), ne(invitation.role, "owner")))
  const others = await tx
    .select({ at: member.createdAt })
    .from(member)
    .where(and(eq(member.organizationId, orgId), ne(member.role, "owner")))
    .orderBy(asc(member.createdAt))
  const live = invites.filter(
    (row) => row.status === "pending" && row.expiresAt.getTime() > now.getTime(),
  )
  const expired = invites.filter(
    (row) => row.status === "pending" && row.expiresAt.getTime() <= now.getTime(),
  )
  const lastIn = others.at(-1)?.at ?? null
  const teamNow = [
    `${plural(others.length, "persona dentro", "personas dentro")}`,
    live.length ? plural(live.length, "invitación sin aceptar", "invitaciones sin aceptar") : null,
    expired.length ? plural(expired.length, "invitación vencida", "invitaciones vencidas") : null,
  ]
    .filter(Boolean)
    .join(" · ")
  facts.equipo =
    others.length === 0 && invites.length === 0
      ? fact(
          // Sin propietaria todavía no hay nadie dentro: «solo la propietaria» contradecía «Entró».
          owner
            ? "Solo la propietaria: aún no invitó a nadie"
            : "Nadie de la clínica entró todavía",
        )
      : live.length === 0 && expired.length === 0 && lastIn
        ? fact(
            `${plural(others.length, "persona dentro", "personas dentro")} además de la propietaria`,
            lastIn,
          )
        : fact(teamNow, null, { keptDetail: `Estuvo completo; hoy: ${teamNow}` })

  // 9. WhatsApp: conectado de verdad, cuando Meta verificó la dirección de avisos o llegó el
  // primer mensaje por un WhatsApp de la clínica (de cualquier estado, como el relleno).
  const connections = await tx
    .select({
      status: channelConnection.status,
      verifiedAt: channelConnection.webhookVerifiedAt,
      signup: channelConnection.signup,
    })
    .from(channelConnection)
    .where(
      and(eq(channelConnection.organizationId, orgId), eq(channelConnection.channel, "whatsapp")),
    )
  const [inbound] = await tx
    .select({ at: min(message.createdAt) })
    .from(message)
    .innerJoin(conversation, eq(conversation.id, message.conversationId))
    .innerJoin(channelConnection, eq(channelConnection.id, conversation.channelConnectionId))
    .where(
      and(
        eq(message.organizationId, orgId),
        eq(message.direction, "in"),
        eq(channelConnection.channel, "whatsapp"),
      ),
    )
  const connectedAt = earliest(...connections.map((row) => row.verifiedAt), asDate(inbound?.at))
  const active = connections.filter((row) => row.status === "active")
  facts.whatsapp = connectedAt
    ? fact(
        `Conectado el ${day(connectedAt)}${active.length === 0 ? "; hoy está desactivado" : ""}`,
        connectedAt,
      )
    : active.length > 0
      ? fact(
          active.some((row) => row.signup === null)
            ? "Falta: en Meta, pegar la dirección de avisos de odentIA; se da por conectado cuando Meta la verifica o llega el primer mensaje"
            : "Falta: que llegue el primer mensaje a ese número",
        )
      : options.metaSignupAvailable
        ? fact("Falta: la clínica aún no conectó su WhatsApp")
        : fact("«Conectar con Facebook» aún no está disponible: Meta todavía no lo aprueba", null, {
            label: WAITING_META_LABEL,
            waitingOn: "meta",
          })

  // 10. Primer uso: la primera sesión de alguien de la clínica activa desde que es parte de ella
  // (la de registrarse empieza antes de la clínica; cuenta desde que entró). Una sesión cerrada se
  // borra: lo guardado conserva la primera.
  const [firstSession] = await tx
    .select({
      at: sql<Date | null>`min(greatest(${session.createdAt}, ${member.createdAt}))`.mapWith(
        session.createdAt,
      ),
    })
    .from(session)
    .innerJoin(member, eq(member.userId, session.userId))
    .where(and(eq(member.organizationId, orgId), gte(session.updatedAt, member.createdAt)))
  const usedAt = asDate(firstSession?.at)
  facts.primer_uso = usedAt
    ? fact(`Entró por primera vez el ${day(usedAt)}`, usedAt)
    : fact("Falta: nadie de la clínica entró todavía", null, {
        keptDetail: "Hecho: quedó guardada la primera vez (sus sesiones ya se cerraron)",
      })

  return facts as Record<OnboardingStepKey, Fact>
}

/* ---------- Cálculo ---------- */

interface Computed extends OnboardingComputed {
  facts: Record<OnboardingStepKey, Fact>
}

async function computeOf(
  tx: Db,
  client: { id: string; organizationId: string | null },
  now: Date,
  options: OnboardingOptions,
): Promise<Computed> {
  const milestones = await readMilestones(tx, client.id)
  const orgId = client.organizationId
  const facts = orgId
    ? await factsOf(tx, client.id, orgId, now, options, milestones)
    : await stepsWithoutAccount(tx, client.id, milestones)
  const steps = ONBOARDING_STEP_KEYS.map((key) =>
    withMilestone(key, facts[key], milestones.get(key)),
  )
  let trialActive = false
  if (orgId) {
    const [sub] = await tx
      .select({ status: saasSubscription.status, trialEndsAt: saasSubscription.trialEndsAt })
      .from(saasSubscription)
      .where(eq(saasSubscription.organizationId, orgId))
      .limit(1)
    trialActive = Boolean(
      sub?.status === "prueba" && sub.trialEndsAt && sub.trialEndsAt.getTime() > now.getTime(),
    )
  }
  const trackedSince = earliest(...[...milestones.values()].map((row) => row.createdAt))
  return { ...summarize(client, steps, now, { trialActive, trackedSince }), facts }
}

function summarize(
  client: { id: string; organizationId: string | null },
  steps: OnboardingStep[],
  now: Date,
  ctx: { trialActive: boolean; trackedSince: Date | null },
): OnboardingComputed {
  const notApplicable = steps.filter((item) => item.state === "no_aplica")
  const enteredAt = steps.find((item) => item.key === "entro")?.doneAt ?? null
  const lastProgressAt =
    latest(
      ...steps.map((item) => item.doneAt),
      ...notApplicable.map((item) => item.notApplicable?.at),
    ) ?? enteredAt
  const column = onboardingColumn(steps, client.organizationId !== null)
  return {
    clientId: client.id,
    organizationId: client.organizationId,
    steps,
    done: steps.filter((item) => item.state === "hecho").length,
    total: steps.length - notApplicable.length,
    notApplicable: notApplicable.length,
    next: steps.find((item) => item.state === "falta")?.key ?? null,
    enteredAt,
    lastProgressAt,
    column,
    stuck: isStuck(lastProgressAt, column, now, ctx),
    trialActive: ctx.trialActive,
    trackedSince: ctx.trackedSince,
  }
}

/**
 * Los pasos de un cliente sin mirar quién lee: el hecho combinado con su primera vez guardada.
 * Lo usan la ficha, la pasada de Kairós y el Embudo «Alta».
 */
export async function computeOnboarding(
  tx: Db,
  client: { id: string; organizationId: string | null },
  now: Date,
  options: OnboardingOptions = NO_META,
): Promise<OnboardingComputed> {
  const { facts: _facts, ...computed } = await computeOf(tx, client, now, options)
  return computed
}

const isNaStep = (step: string): step is SaasMilestoneNaStep =>
  (SAAS_MILESTONE_NA_STEPS as readonly string[]).includes(step)

/** Quién marca «No aplica» en cada paso: lo de la carga (pacientes) solo Administración. */
function canMarkNa(actor: AdminActor, step: SaasMilestoneNaStep): boolean {
  return step !== "pacientes" || actor.role === "admin"
}

/**
 * Los pasos del alta de un cliente. Sin cuenta, todos faltan y el primero
 * dice que aún no la abrió. Las acciones de Administración no le llegan a
 * Soporte.
 */
export async function onboardingSteps(
  tx: Db,
  actor: AdminActor | null,
  clientId: string,
  now = new Date(),
  options: OnboardingOptions = NO_META,
): Promise<OnboardingSteps> {
  if (!actor) throw new ServiceError("FORBIDDEN", 403, "Se requiere personal de administración")
  const client = await clientOf(tx, clientId)
  const computed = await computeOnboarding(tx, client, now, options)
  const steps = computed.steps.map((item): OnboardingStep => {
    const { action, ...rest } = item
    const canMarkNotApplicable =
      client.organizationId !== null &&
      item.state !== "hecho" &&
      isNaStep(item.key) &&
      canMarkNa(actor, item.key)
    const visible = action && !(action.adminOnly && actor.role !== "admin") ? action : undefined
    const suggested =
      canMarkNotApplicable && item.state === "falta" && isNaStep(item.key)
        ? { suggestedReason: NOT_APPLICABLE_SUGGESTED[item.key] }
        : {}
    return visible
      ? { ...rest, canMarkNotApplicable, ...suggested, action: visible }
      : { ...rest, canMarkNotApplicable, ...suggested }
  })
  return { ...computed, steps }
}

async function clientOf(tx: Db, clientId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) throw notFound("Cliente")
  const [client] = await tx
    .select({
      id: saasClient.id,
      organizationId: saasClient.organizationId,
      archivedAt: saasClient.archivedAt,
    })
    .from(saasClient)
    .where(eq(saasClient.id, clientId))
    .limit(1)
  if (!client) throw notFound("Cliente")
  return client
}

/* ---------- «No aplica» ---------- */

/** Revisa quién, qué paso y qué cliente (con cuenta y sin archivar) antes de tocar nada. */
async function naTarget(tx: Db, actor: AdminActor | null, clientId: string, step: string) {
  if (!actor) throw new ServiceError("FORBIDDEN", 403, "Se requiere personal de administración")
  if (!isNaStep(step)) throw invalidField("step", "Ese paso no se puede marcar «No aplica»")
  if (!canMarkNa(actor, step))
    throw new ServiceError("FORBIDDEN", 403, "Solo Administración marca lo de la carga")
  const client = await clientOf(tx, clientId)
  if (client.archivedAt) throw notFound("Cliente")
  if (!client.organizationId)
    throw new ServiceError(
      "CLIENT_WITHOUT_ACCOUNT",
      409,
      "Primero tiene que abrir su cuenta: el alta empieza cuando entra",
    )
  return { actor, step, client: { id: client.id, organizationId: client.organizationId } }
}

/**
 * Marca un paso «No aplica» con su motivo (equipo y WhatsApp, también Soporte; pacientes, solo
 * Administración). Deja de contar entre los pasos y como trabado; si el hecho pasa después, el
 * paso queda hecho solo.
 */
export async function markStepNotApplicable(
  tx: Db,
  actor: AdminActor | null,
  clientId: string,
  step: string,
  reason: string,
  now = new Date(),
): Promise<void> {
  const target = await naTarget(tx, actor, clientId, step)
  const text = reason.trim()
  if (text.length < 1) throw invalidField("reason", "Escribe por qué no aplica")
  if (text.length > NOT_APPLICABLE_MAX)
    throw invalidField("reason", `Usa como máximo ${NOT_APPLICABLE_MAX} caracteres`)
  await tx
    .insert(saasClientMilestone)
    .values({
      clientId: target.client.id,
      step: target.step,
      naReason: text,
      naBy: target.actor.userId,
      naAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [saasClientMilestone.clientId, saasClientMilestone.step],
      set: { naReason: text, naBy: target.actor.userId, naAt: now, updatedAt: now },
    })
  await writeAdminAudit(tx, target.actor, {
    action: "client.onboarding_not_applicable",
    organizationId: target.client.organizationId,
    entityId: target.client.id,
    metadata: { step: target.step, reason: text },
  })
}

/**
 * Quita «No aplica»: borra solo el motivo. La fila se va solo si queda vacía; un paso ya
 * alcanzado o perdido conserva su primera vez (la base no vigila el borrado: lo cuida esto).
 */
export async function clearStepNotApplicable(
  tx: Db,
  actor: AdminActor | null,
  clientId: string,
  step: string,
  now = new Date(),
): Promise<void> {
  const target = await naTarget(tx, actor, clientId, step)
  const where = and(
    eq(saasClientMilestone.clientId, target.client.id),
    eq(saasClientMilestone.step, target.step),
    sql`${saasClientMilestone.naAt} is not null`,
  )
  // Sin primera vez ni pérdida, la fila era solo «No aplica»: se borra (vacía no puede quedar).
  const deleted = await tx
    .delete(saasClientMilestone)
    .where(
      and(
        where,
        sql`${saasClientMilestone.reachedAt} is null and ${saasClientMilestone.lostAt} is null`,
      ),
    )
    .returning({ step: saasClientMilestone.step })
  const cleared = deleted.length
    ? deleted
    : await tx
        .update(saasClientMilestone)
        .set({ naReason: null, naBy: null, naAt: null, updatedAt: now })
        .where(where)
        .returning({ step: saasClientMilestone.step })
  if (cleared.length === 0) return
  await writeAdminAudit(tx, target.actor, {
    action: "client.onboarding_not_applicable_cleared",
    organizationId: target.client.organizationId,
    entityId: target.client.id,
    metadata: { step: target.step },
  })
}

/* ---------- Quién cargó ---------- */

export interface LastLoader {
  userId: string
  name: string
  role: string
}

/**
 * Quién hizo la última carga (configuración o pacientes) de cada organización, si sigue en el
 * equipo de la administración. Si quien cargó ya no está activo, no hay: la tarea va al
 * responsable.
 */
export async function lastLoaderOf(tx: Db, orgIds: string[]): Promise<Map<string, LastLoader>> {
  const out = new Map<string, LastLoader>()
  const ids = [...new Set(orgIds)]
  if (ids.length === 0) return out
  const rows = (await tx.execute(sql`
    select distinct on (a.organization_id) a.organization_id as "orgId", a.actor_user_id as "userId",
      u.name, s.role, coalesce(s.active, false) as active
    from ${adminAudit} a
    left join ${user} u on u.id = a.actor_user_id
    left join ${adminStaff} s on s.user_id = a.actor_user_id
    where a.organization_id in (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
      and a.action in ('org.setup_import', 'org.data_import')
      and a.actor_user_id is not null
    order by a.organization_id, a.created_at desc`)) as unknown as Array<{
    orgId: string
    userId: string
    name: string | null
    role: string | null
    active: boolean
  }>
  for (const row of rows)
    if (row.active && row.role)
      out.set(row.orgId, { userId: row.userId, name: row.name ?? "", role: row.role })
  return out
}

/* ---------- La pasada: guardar la primera vez ---------- */

export interface MilestoneReached {
  clientId: string
  step: OnboardingStepKey
  at: Date
}
export interface MilestoneLost {
  clientId: string
  step: OnboardingStepKey
  reason: SaasMilestoneLostReason
  at: Date
}

/** Cómo va el alta de un cliente en esta pasada (lo reutilizan las reglas de Kairós). */
export interface AltaState {
  clientId: string
  name: string
  organizationId: string
  /** El responsable del cliente. */
  ownerUserId: string | null
  steps: OnboardingStep[]
  column: OnboardingColumn | null
  next: OnboardingStepKey | null
  /** A quién le toca el paso que sigue. */
  waitingOn: OnboardingWaitingOn | null
  lastProgressAt: Date | null
  /** Desde cuándo cuentan los días sin avance (`isStuck`). */
  stuckSince: Date | null
  stuck: boolean
  trialActive: boolean
  paidAt: Date | null
}

export interface OnboardingSync {
  reached: MilestoneReached[]
  lost: MilestoneLost[]
  alta: AltaState[]
}

/**
 * Guarda la primera vez de cada paso desde los hechos, para los clientes con cuenta, sin
 * archivar y que no son demo (los de sin cuenta no lo necesitan: carta y archivos cuentan
 * también lo borrado, y se guardan al ligar la cuenta). Salta los que pagaron hace más de
 * `ALTA_PAID_DAYS` y tienen todo hecho o «No aplica», salvo que hoy no les quede ningún pago
 * confirmado ni devuelto (una sola consulta: ahí se mira su retroceso).
 *
 * Nunca mueve una fecha guardada (lo exige también la base): solo llena la que falta o la de
 * un paso perdido que se vuelve a alcanzar. Lo perdido (el pago revertido, los datos borrados
 * sin cargar, también en la primera pasada tras el relleno) se guarda en `lost_*`. No audita:
 * es un cálculo; los retrocesos salen en `lost`.
 */
export async function syncOnboardingMilestones(
  tx: Db,
  now: Date,
  options: OnboardingOptions = NO_META,
): Promise<OnboardingSync> {
  const paidBefore = new Date(now.getTime() - ALTA_PAID_DAYS * DAY_MS)
  const clients = (await tx.execute(sql`
    select c.id, c.name, c.organization_id as "organizationId", c.owner_user_id as "ownerUserId"
    from ${saasClient} c
    where c.organization_id is not null and c.archived_at is null
      and ${notDemoOrg(sql`c.organization_id`)}
      and not (
        exists (select 1 from ${saasClientMilestone} m where m.client_id = c.id
          and m.step = 'primer_pago' and m.reached_at < ${paidBefore.toISOString()}::timestamptz)
        and (select count(*) from ${saasClientMilestone} m where m.client_id = c.id
          and (m.reached_at is not null or m.na_at is not null)) = ${ONBOARDING_STEP_KEYS.length}
        and exists (select 1 from ${saasPayment} p where p.organization_id = c.organization_id
          and p.status in ('confirmado', 'devuelto'))
      )
    order by c.id`)) as unknown as Array<{
    id: string
    name: string
    organizationId: string
    ownerUserId: string | null
  }>
  const out: OnboardingSync = { reached: [], lost: [], alta: [] }
  for (const client of clients) {
    const computed = await computeOf(tx, client, now, options)
    for (const key of ONBOARDING_STEP_KEYS) {
      const current = computed.facts[key]
      if (current.lost) {
        const rows = await tx
          .insert(saasClientMilestone)
          .values({
            clientId: client.id,
            step: key,
            lostAt: current.lost.at,
            lostReason: current.lost.reason,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [saasClientMilestone.clientId, saasClientMilestone.step],
            set: {
              reachedAt: null,
              source: null,
              lostAt: current.lost.at,
              lostReason: current.lost.reason,
              updatedAt: now,
            },
            setWhere: sql`${saasClientMilestone.reachedAt} is not null`,
          })
          .returning({ step: saasClientMilestone.step })
        if (rows.length)
          out.lost.push({
            clientId: client.id,
            step: key,
            reason: current.lost.reason,
            at: current.lost.at,
          })
        continue
      }
      if (!current.at) continue
      const rows = await tx
        .insert(saasClientMilestone)
        .values({
          clientId: client.id,
          step: key,
          reachedAt: current.at,
          source: current.source,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [saasClientMilestone.clientId, saasClientMilestone.step],
          set: {
            reachedAt: current.at,
            source: current.source,
            lostAt: null,
            lostReason: null,
            updatedAt: now,
          },
          setWhere: sql`${saasClientMilestone.reachedAt} is null`,
        })
        .returning({ step: saasClientMilestone.step })
      if (rows.length) out.reached.push({ clientId: client.id, step: key, at: current.at })
    }
    // Lo que se acaba de guardar cuenta como seguido desde ahora (si no tenía nada guardado).
    const trackedSince =
      computed.trackedSince ?? (out.reached.some((row) => row.clientId === client.id) ? now : null)
    const stuckSince = latest(computed.lastProgressAt, trackedSince)
    const next = computed.steps.find((item) => item.key === computed.next)
    out.alta.push({
      clientId: client.id,
      name: client.name,
      organizationId: client.organizationId,
      ownerUserId: client.ownerUserId,
      steps: computed.steps,
      column: computed.column,
      next: computed.next,
      waitingOn: next?.waitingOn ?? null,
      lastProgressAt: computed.lastProgressAt,
      stuckSince,
      stuck: isStuck(computed.lastProgressAt, computed.column, now, {
        trialActive: computed.trialActive,
        trackedSince,
      }),
      trialActive: computed.trialActive,
      paidAt: computed.steps.find((item) => item.key === "primer_pago")?.doneAt ?? null,
    })
  }
  return out
}

/* ---------- El Embudo «Alta» ---------- */

/** Las columnas del Embudo «Alta», en orden. «Pagó» son los últimos `ALTA_PAID_DAYS` días. */
export const ALTA_COLUMNS = [
  "bienvenida",
  "sus_datos",
  "arranque",
  "primer_pago",
  "pago",
] as const satisfies readonly OnboardingColumn[]

/** Lo de cobros: Soporte no ve estas columnas ni sus tarjetas (las quita el servidor). */
export const ALTA_ADMIN_COLUMNS: ReadonlySet<OnboardingColumn> = new Set<OnboardingColumn>([
  "primer_pago",
  "pago",
])

export interface AltaCard {
  clientId: string
  name: string
  product: ClinicalProduct
  column: OnboardingColumn
  /** El primer paso que falta (en «Pagó», lo que le queda), o nulo si no falta ninguno. */
  missing: { step: OnboardingStepKey; words: string } | null
  /** A quién le toca ese paso; con «nosotros», la persona (nula sin responsable). */
  who: { kind: OnboardingWaitingOn; person: { userId: string; name: string } | null } | null
  /** Días desde que entró (en «Pagó», hasta su primer pago). */
  daysInAlta: number
  stuck: { days: number; words: string } | null
  /** Su primer pago confirmado, en ISO; nulo si aún no paga. */
  paidAt: string | null
  /** Los pasos que faltan, sin los «No aplica». */
  remaining: number
  owner: { userId: string; name: string } | null
}

export interface AltaBoard {
  columns: Array<{ key: OnboardingColumn; cards: AltaCard[] }>
}

type AltaBaseRow = {
  id: string
  name: string
  product: string
  organizationId: string
  ownerUserId: string | null
  ownerName: string | null
  enteredAt: Date | string | null
  deleteOn: string | null
}

/** Días civiles de Lima entre hoy y `isoDay`. */
function daysUntil(isoDay: string, now: Date): number {
  const [y1, m1, d1] = limaDate(now).split("-").map(Number)
  const [y2, m2, d2] = isoDay.slice(0, 10).split("-").map(Number)
  return Math.round(
    (Date.UTC(y2 as number, (m2 as number) - 1, d2 as number) -
      Date.UTC(y1 as number, (m1 as number) - 1, d1 as number)) /
      DAY_MS,
  )
}

/** Lo que falta, en palabras de la tarjeta, con el plazo de sus datos cuando importa. */
function altaMissingWords(step: OnboardingStep, deleteOn: string | null, now: Date): string {
  if (step.key === "archivos" && step.lost)
    return "volver a pedir sus datos: se borraron sin cargar"
  if (step.key === "primer_pago" && step.waitingOn === "nosotros") return "confirmar su pago"
  const words = ALTA_MISSING_WORDS[step.key]
  if ((step.key === "configuracion" || step.key === "pacientes") && deleteOn) {
    const days = daysUntil(deleteOn, now)
    const when = days <= 0 ? "hoy" : days === 1 ? "mañana" : `en ${days} días`
    return `${words} (sus datos se borran ${when})`
  }
  return words
}

/**
 * El Embudo «Alta»: una tarjeta por clínica que entró (tiene cuenta), sin archivar, sin demos ni
 * canceladas, en la columna de su primer grupo con un paso que falta; «Pagó» cuando su primer
 * pago está confirmado (aunque le queden pasos) y solo los últimos `ALTA_PAID_DAYS` días. Cada
 * alta se calcula con `computeOnboarding`, la misma verdad de la ficha y de Kairós (una por
 * clínica: con decenas alcanza). Las tarjetas no se arrastran: cambian cuando pasa el hecho.
 * Soporte no recibe «Primer pago» ni «Pagó», ni sus tarjetas. Dentro de cada columna, primero
 * las trabadas, después las de más días y al final por nombre.
 */
export async function altaBoard(
  tx: Db,
  actor: AdminActor | null,
  filter: PipelineFilter = {},
  now = new Date(),
  options: OnboardingOptions = NO_META,
): Promise<AltaBoard> {
  if (!actor) throw new ServiceError("FORBIDDEN", 403, "Se requiere personal de administración")
  const where: SQL[] = [
    sql`c.archived_at is null`,
    notDemoOrg(sql`c.organization_id`),
    sql`not exists (select 1 from ${saasSubscription} cs
      where cs.organization_id = c.organization_id and cs.status = 'cancelada')`,
  ]
  if (filter.product) where.push(sql`c.product = ${filter.product}`)
  if (filter.origin) where.push(sql`c.origin = ${filter.origin}`)
  if (filter.owner === "mio") where.push(sql`c.owner_user_id = ${actor.userId}`)
  else if (filter.owner === "sin") where.push(sql`c.owner_user_id is null`)
  else if (filter.owner) where.push(sql`c.owner_user_id = ${filter.owner}`)
  // `deleteOn`: lo que llegó como la carga y aún no se carga, el día más cercano en que se borra.
  const rows = (await tx.execute(sql`
    select c.id, c.name, c.product, c.organization_id as "organizationId",
      c.owner_user_id as "ownerUserId", u.name as "ownerName",
      ${enteredAtSql("c", "org")} as "enteredAt",
      case when ${cargaLoadedSql("c")} then null else
        (select min(f.delete_after)::text from ${saasClientFile} f where f.client_id = c.id
          and f.kind = 'archivo_clinica' and f.deleted_at is null) end as "deleteOn"
    from ${saasClient} c
    join ${organization} org on org.id = c.organization_id
    left join ${user} u on u.id = c.owner_user_id
    where ${and(...where)}
    order by c.name`)) as unknown as AltaBaseRow[]

  const loaders = await lastLoaderOf(
    tx,
    rows.map((row) => row.organizationId),
  )
  const admin = actor.role === "admin"
  const paidSince = now.getTime() - ALTA_PAID_DAYS * DAY_MS
  const columns = new Map<OnboardingColumn, AltaCard[]>(ALTA_COLUMNS.map((key) => [key, []]))
  for (const row of rows) {
    const computed = await computeOnboarding(
      tx,
      { id: row.id, organizationId: row.organizationId },
      now,
      options,
    )
    const column = computed.column
    if (!column) continue
    if (!admin && ALTA_ADMIN_COLUMNS.has(column)) continue
    const paidAt = computed.steps.find((item) => item.key === "primer_pago")?.doneAt ?? null
    if (column === "pago" && paidAt && paidAt.getTime() < paidSince) continue
    const next = computed.steps.find((item) => item.key === computed.next) ?? null
    const owner = row.ownerUserId ? { userId: row.ownerUserId, name: row.ownerName ?? "" } : null
    // Lo de la carga le toca a quien hizo la última (si sigue activo); lo demás, al responsable.
    const loader = loaders.get(row.organizationId)
    const person =
      next && (next.key === "configuracion" || next.key === "pacientes") && loader
        ? { userId: loader.userId, name: loader.name }
        : owner
    const enteredAt = asDate(row.enteredAt) ?? computed.enteredAt ?? now
    const until = column === "pago" && paidAt ? paidAt : now
    const since = latest(computed.lastProgressAt, computed.trackedSince)
    const stuckDays =
      computed.stuck && since ? Math.floor((now.getTime() - since.getTime()) / DAY_MS) : null
    columns.get(column)?.push({
      clientId: row.id,
      name: row.name,
      product: isClinicalProduct(row.product) ? row.product : "dental",
      column,
      missing: next ? { step: next.key, words: altaMissingWords(next, row.deleteOn, now) } : null,
      who: next?.waitingOn
        ? { kind: next.waitingOn, person: next.waitingOn === "nosotros" ? person : null }
        : null,
      daysInAlta: Math.max(0, Math.floor((until.getTime() - enteredAt.getTime()) / DAY_MS)),
      stuck:
        stuckDays === null
          ? null
          : { days: stuckDays, words: `Lleva ${plural(stuckDays, "día", "días")} sin avanzar` },
      paidAt: paidAt ? paidAt.toISOString() : null,
      remaining: computed.steps.filter((item) => item.state === "falta").length,
      owner,
    })
  }
  const order = (a: AltaCard, b: AltaCard) =>
    Number(Boolean(b.stuck)) - Number(Boolean(a.stuck)) ||
    b.daysInAlta - a.daysInAlta ||
    a.name.localeCompare(b.name, "es")
  return {
    columns: ALTA_COLUMNS.filter((key) => admin || !ALTA_ADMIN_COLUMNS.has(key)).map((key) => ({
      key,
      cards: (columns.get(key) ?? []).sort(order),
    })),
  }
}
