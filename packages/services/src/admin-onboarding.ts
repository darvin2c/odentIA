/**
 * El alta de una clínica que entró (ficha del cliente › Alta): los pasos para
 * que empiece a trabajar, cada uno con su fecha o con lo que falta. Nadie los
 * marca a mano: se calculan al leer de lo que ya pasó (la cuenta, el contrato
 * de encargo, los documentos, el registro de la carga, el equipo, el canal, las
 * sesiones y los pagos). Solo lee y no deja auditoría.
 *
 * La carga y el informe los hace la skill en el servidor (ADR 0183): sus pasos
 * salen del mismo registro que muestra Alta (`listClinicLoads` y
 * `listProgressReports`), nunca de una copia, y ningún paso ofrece cargar ni
 * enviar. Soporte ve los pasos (sin importes: ningún paso los dice), pero no
 * las acciones que son de Administración.
 */

import { AGREEMENT_VERSION } from "@odentia/auth/legal"
import type { Db } from "@odentia/db"
import { saasClient, saasClientFile, saasInboundEmail } from "@odentia/db/schema/admin-arm"
import { clinicImportRow } from "@odentia/db/schema/admin-imports"
import { invitation, member, organization, session } from "@odentia/db/schema/auth"
import { channelConnection } from "@odentia/db/schema/crm"
import { saasPayment } from "@odentia/db/schema/saas-billing"
import { processingAgreementAcceptance } from "@odentia/db/schema/workspace"
import { and, asc, count, desc, eq, gte, inArray, min, ne, sql } from "drizzle-orm"
import type { AdminActor } from "./admin-core.js"
import { listClinicLoads, listProgressReports } from "./clinic-progress-report.js"
import { notFound, ServiceError } from "./errors.js"

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

export interface OnboardingStep {
  key: OnboardingStepKey
  label: string
  /** Cuándo quedó hecho; nulo, falta. */
  doneAt: Date | null
  /** En palabras: lo que pasó o lo que falta. */
  detail: string
  action?: OnboardingAction
}

export interface OnboardingSteps {
  clientId: string
  organizationId: string | null
  steps: OnboardingStep[]
  done: number
  total: number
  /** El primer paso que falta, o nulo si están todos. */
  next: OnboardingStepKey | null
}

const LABELS: Record<OnboardingStepKey, string> = {
  entro: "Entró",
  contrato: "Contrato de encargo aceptado",
  carta: "Carta de bienvenida enviada",
  archivos: "Datos recibidos",
  configuracion: "Configuración cargada",
  pacientes: "Pacientes cargados",
  informe: "Informe enviado",
  equipo: "Equipo dentro",
  whatsapp: "WhatsApp conectado",
  primer_uso: "Primer uso",
  primer_pago: "Primer pago confirmado",
}

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

/** `min()` de postgres-js puede volver como texto: siempre fecha o nulo. */
function asDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date
}

function step(
  key: OnboardingStepKey,
  doneAt: Date | null,
  detail: string,
  action?: OnboardingAction,
): OnboardingStep {
  return action
    ? { key, label: LABELS[key], doneAt, detail, action }
    : { key, label: LABELS[key], doneAt, detail }
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
): Promise<OnboardingSteps> {
  if (!actor) throw new ServiceError("FORBIDDEN", 403, "Se requiere personal de administración")
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) throw notFound("Cliente")
  const [client] = await tx
    .select({ id: saasClient.id, organizationId: saasClient.organizationId })
    .from(saasClient)
    .where(eq(saasClient.id, clientId))
    .limit(1)
  if (!client) throw notFound("Cliente")
  const orgId = client.organizationId
  const steps = orgId
    ? await stepsOf(tx, client.id, orgId, now)
    : await stepsWithoutAccount(tx, client.id)
  const visible = steps.map((item) =>
    item.action?.adminOnly && actor.role !== "admin" ? { ...item, action: undefined } : item,
  )
  const clean = visible.map(({ action, ...rest }) => (action ? { ...rest, action } : rest))
  const done = clean.filter((item) => item.doneAt).length
  return {
    clientId: client.id,
    organizationId: orgId,
    steps: clean,
    done,
    total: clean.length,
    next: clean.find((item) => !item.doneAt)?.key ?? null,
  }
}

/**
 * Lo que el cliente mandó o le mandamos, también antes de tener cuenta (carta,
 * archivos). Cuenta lo ya borrado: lo de la clínica se borra a los 30 días y
 * igual llegó.
 */
async function filesAndMail(tx: Db, clientId: string) {
  const files = await tx
    .select({ kind: saasClientFile.kind, n: count(), first: min(saasClientFile.createdAt) })
    .from(saasClientFile)
    .where(
      and(
        eq(saasClientFile.clientId, clientId),
        inArray(saasClientFile.kind, ["carta", "archivo_clinica", "correo"]),
      ),
    )
    .groupBy(saasClientFile.kind)
  const byKind = new Map(files.map((row) => [row.kind, { n: row.n, first: asDate(row.first) }]))
  const [mail] = await tx
    .select({ n: count(), first: min(saasInboundEmail.receivedAt) })
    .from(saasInboundEmail)
    .where(
      and(
        eq(saasInboundEmail.clientId, clientId),
        sql`jsonb_array_length(${saasInboundEmail.attachments}) > 0`,
      ),
    )
  return { byKind, mail: { n: mail?.n ?? 0, first: asDate(mail?.first) } }
}

function letterStep(carta: { n: number; first: Date | null } | undefined): OnboardingStep {
  return carta?.first
    ? step("carta", carta.first, `Se guardó el ${day(carta.first)}`)
    : step("carta", null, "Falta: prepara la carta de bienvenida y guárdala en Documentos", {
        code: "subir_carta",
        label: "Subir la carta",
        adminOnly: true,
      })
}

function receivedStep(
  byKind: Map<string, { n: number; first: Date | null }>,
  mail: { n: number; first: Date | null },
): OnboardingStep {
  const sent = byKind.get("archivo_clinica")
  const first = earliest(sent?.first, mail.first)
  if (!first)
    return step("archivos", null, "Falta: la clínica aún no mandó sus datos", {
      code: "subir_archivos",
      label: "Subir lo que mandó",
      adminOnly: true,
    })
  const pieces = [
    sent?.n ? plural(sent.n, "archivo", "archivos") : null,
    mail.n ? plural(mail.n, "correo con adjuntos", "correos con adjuntos") : null,
  ].filter(Boolean)
  return step("archivos", first, `Desde el ${day(first)}: ${pieces.join(" y ")}`)
}

async function stepsWithoutAccount(tx: Db, clientId: string): Promise<OnboardingStep[]> {
  const { byKind, mail } = await filesAndMail(tx, clientId)
  const missing = "Falta: primero tiene que abrir su cuenta"
  return [
    step("entro", null, "Aún no tiene cuenta: invítala o dale de alta"),
    step("contrato", null, missing),
    letterStep(byKind.get("carta")),
    receivedStep(byKind, mail),
    step("configuracion", null, missing),
    step("pacientes", null, missing),
    step("informe", null, missing),
    step("equipo", null, missing),
    step("whatsapp", null, missing),
    step("primer_uso", null, missing),
    step("primer_pago", null, missing),
  ]
}

async function stepsOf(
  tx: Db,
  clientId: string,
  orgId: string,
  now: Date,
): Promise<OnboardingStep[]> {
  const [org] = await tx
    .select({ createdAt: organization.createdAt })
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1)
  const orgCreatedAt = org?.createdAt ?? null

  // 1. Entró: la propietaria es parte de la clínica.
  const [owner] = await tx
    .select({ at: member.createdAt })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.role, "owner")))
    .orderBy(asc(member.createdAt))
    .limit(1)
  let entered: OnboardingStep
  if (owner) entered = step("entro", owner.at, `La propietaria entró el ${day(owner.at)}`)
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
    entered = step(
      "entro",
      null,
      pending
        ? `${since}; la propietaria no aceptó la invitación (${pending.expiresAt.getTime() > now.getTime() ? `vence el ${day(pending.expiresAt)}` : "venció"})`
        : `${since}; aún no tiene propietaria`,
      pending
        ? { code: "reenviar_invitacion", label: "Reenviar la invitación", adminOnly: false }
        : undefined,
    )
  }

  // 2. Contrato de encargo: la versión vigente.
  const accepted = await tx
    .select({
      version: processingAgreementAcceptance.version,
      at: processingAgreementAcceptance.acceptedAt,
    })
    .from(processingAgreementAcceptance)
    .where(eq(processingAgreementAcceptance.organizationId, orgId))
    .orderBy(desc(processingAgreementAcceptance.acceptedAt))
  const current = accepted.find((row) => row.version === AGREEMENT_VERSION)
  const agreement = current
    ? step("contrato", current.at, `Aceptó la versión del ${current.version} el ${day(current.at)}`)
    : step(
        "contrato",
        null,
        accepted[0]
          ? `Aceptó la versión del ${accepted[0].version}; falta la vigente, del ${AGREEMENT_VERSION} (se le pide al entrar)`
          : "Falta: se le pide a quien administra la clínica al entrar",
      )

  // 3 y 4. Carta y datos recibidos.
  const { byKind, mail } = await filesAndMail(tx, clientId)

  // 5, 6 y 7. La carga y el informe: del registro que muestra Alta (lo que hizo la skill).
  const loads = await listClinicLoads(tx, orgId)
  const firstLoad = (kind: "configuracion" | "pacientes") =>
    loads.filter((load) => load.kind === kind).at(-1)
  const setupLoaded = firstLoad("configuracion")
  const configuration = setupLoaded
    ? step(
        "configuracion",
        new Date(setupLoaded.at),
        `Cargada el ${day(new Date(setupLoaded.at))}: ${setupLoaded.summary}`,
      )
    : step("configuracion", null, "Falta: la carga la hace la skill de carga en el servidor")

  const [people] = await tx
    .select({ n: count(), first: min(clinicImportRow.createdAt) })
    .from(clinicImportRow)
    .where(eq(clinicImportRow.organizationId, orgId))
  const patientsLoaded = firstLoad("pacientes")
  const peopleFirst = earliest(
    asDate(people?.first),
    patientsLoaded ? new Date(patientsLoaded.at) : null,
  )
  const patients = peopleFirst
    ? step(
        "pacientes",
        peopleFirst,
        `Desde el ${day(peopleFirst)}: ${plural(people?.n ?? 0, "persona en la carga", "personas en la carga")}`,
      )
    : step("pacientes", null, "Falta: la carga la hace la skill de carga en el servidor")

  const reports = await listProgressReports(tx, orgId)
  const sent = reports
    .filter((report) => report.state === "enviado")
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const firstSentAt = sent[0] ? new Date(sent[0].at) : null
  const pending = reports.find((report) => report.state !== "enviado")
  const lastSent = sent.at(-1)
  const report = pending
    ? step(
        "informe",
        firstSentAt,
        pending.state === "desconocido"
          ? `No se sabe si salió el informe N.º ${pending.number}: revisa en Zoho si salió`
          : `El informe N.º ${pending.number} quedó enviándose: revisa en Zoho si salió`,
        { code: "revisar_informe", label: "Revisar el informe", adminOnly: true },
      )
    : lastSent
      ? step(
          "informe",
          firstSentAt,
          lastSent.registeredLater
            ? `${plural(sent.length, "informe", "informes")}; el último, N.º ${lastSent.number}, salió el ${day(new Date(lastSent.at))} por correo aparte y se registró después`
            : `${plural(sent.length, "informe", "informes")}; el último, N.º ${lastSent.number}, salió el ${day(new Date(lastSent.at))}`,
        )
      : step("informe", null, "Falta: la skill lo envía con tu aprobación")

  // 8. Equipo: las invitaciones (que no son de propietaria) y quiénes ya entraron.
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
  const team =
    others.length === 0 && invites.length === 0
      ? step(
          "equipo",
          null,
          // Sin propietaria todavía no hay nadie dentro: «solo la propietaria» contradecía «Entró».
          owner
            ? "Solo la propietaria: aún no invitó a nadie"
            : "Nadie de la clínica entró todavía",
        )
      : live.length === 0 && expired.length === 0 && lastIn
        ? step(
            "equipo",
            lastIn,
            `${plural(others.length, "persona dentro", "personas dentro")} además de la propietaria`,
          )
        : step(
            "equipo",
            null,
            [
              `${plural(others.length, "persona dentro", "personas dentro")}`,
              live.length
                ? plural(live.length, "invitación sin aceptar", "invitaciones sin aceptar")
                : null,
              expired.length
                ? plural(expired.length, "invitación vencida", "invitaciones vencidas")
                : null,
            ]
              .filter(Boolean)
              .join(" · "),
          )

  // 9. WhatsApp: un canal activo de la clínica.
  const [whatsapp] = await tx
    .select({ at: channelConnection.createdAt })
    .from(channelConnection)
    .where(
      and(
        eq(channelConnection.organizationId, orgId),
        eq(channelConnection.channel, "whatsapp"),
        eq(channelConnection.status, "active"),
      ),
    )
    .orderBy(asc(channelConnection.createdAt))
    .limit(1)
  const channel = whatsapp
    ? step("whatsapp", whatsapp.at, `Conectado el ${day(whatsapp.at)}`)
    : step("whatsapp", null, "Falta: la clínica aún no conectó su WhatsApp")

  // 10. Primer uso: la primera sesión de alguien de la clínica activa desde que es parte de ella
  // (la de registrarse empieza antes de la clínica; cuenta desde que entró). Una sesión cerrada se
  // borra: si ya no queda la primera, la fecha es la de la más antigua que queda.
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
  const firstUse = usedAt
    ? step("primer_uso", usedAt, `Entró por primera vez el ${day(usedAt)}`)
    : step("primer_uso", null, "Falta: nadie de la clínica entró todavía")

  // 11. Primer pago confirmado (sin importes: Soporte también lo lee).
  const [paid] = await tx
    .select({ at: min(saasPayment.confirmedAt) })
    .from(saasPayment)
    .where(and(eq(saasPayment.organizationId, orgId), eq(saasPayment.status, "confirmado")))
  const paidAt = asDate(paid?.at)
  const payment = paidAt
    ? step("primer_pago", paidAt, `Confirmado el ${day(paidAt)}`)
    : step("primer_pago", null, "Falta: aún no hay un pago confirmado")

  return [
    entered,
    agreement,
    letterStep(byKind.get("carta")),
    receivedStep(byKind, mail),
    configuration,
    patients,
    report,
    team,
    channel,
    firstUse,
    payment,
  ]
}
