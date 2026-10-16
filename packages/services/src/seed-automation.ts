import type { Db } from "@odentia/db"
import {
  automationConsent,
  automationJob,
  automationRule,
} from "@odentia/db/schema/automation"
import { channelTemplate, clinicMessage, clinicMessageVersion } from "@odentia/db/schema/crm"
import { and, eq, isNull } from "drizzle-orm"
import {
  AUTOMATION_MESSAGE_LANGUAGE,
  CATALOG_MESSAGE_KEYS,
  type CatalogMessageKey,
  catalogMessageOf,
  positionalBody,
} from "./automation-messages.js"

type TemplateSeed = Omit<typeof channelTemplate.$inferInsert, "organizationId" | "connectionId" | "language">

/**
 * Los mensajes de WhatsApp de la clínica de demostración, en los estados que
 * puede dar el proveedor, para ver Configuración › Integraciones › WhatsApp, la
 * Bandeja pasadas las 24 horas y cada vía de envío: los diez con los que viene
 * (uno con un cambio de texto en revisión), uno creado por la clínica y dos
 * plantillas que ya estaban en la cuenta. Son datos de la semilla: ninguno pasó
 * por WhatsApp.
 */
export async function seedChannelTemplates(
  tx: Db,
  input: { orgId: string; connectionId: string },
): Promise<void> {
  const { orgId, connectionId } = input
  const yesterday = new Date(Date.now() - 24 * 3_600_000)
  const lastWeek = new Date(Date.now() - 7 * 24 * 3_600_000)
  const upsert = async (row: TemplateSeed) => {
    const values = { ...row, statusSince: row.statusSince ?? yesterday, syncedAt: yesterday }
    await tx
      .insert(channelTemplate)
      .values({ organizationId: orgId, connectionId, language: AUTOMATION_MESSAGE_LANGUAGE, ...values })
      .onConflictDoUpdate({
        target: [channelTemplate.connectionId, channelTemplate.name, channelTemplate.language],
        set: values,
      })
  }

  // Los diez con los que viene la clínica, en estados distintos.
  const states: Record<CatalogMessageKey, { status: string; reason?: string; since?: Date }> = {
    recordatorio_cita: { status: "aprobada", since: lastWeek },
    recordatorio_control: { status: "aprobada", since: lastWeek },
    seguimiento_presupuesto: { status: "en_revision" },
    seguimiento_comercial: { status: "aprobada", since: lastWeek },
    seguimiento_no_asistencia: { status: "rechazada", reason: "INVALID_FORMAT" },
    cita_cancelada: { status: "aprobada", since: lastWeek },
    aviso_cita_reservada: { status: "aprobada", since: lastWeek },
    aviso_cita_movida: { status: "aprobada", since: lastWeek },
    aviso_cita_cancelada: { status: "en_revision" },
    retomar_conversacion: { status: "aprobada", since: lastWeek },
  }
  for (const key of CATALOG_MESSAGE_KEYS) {
    const spec = catalogMessageOf(key)
    if (!spec) continue
    await upsert({
      name: spec.template,
      category: spec.category,
      status: states[key].status,
      reason: states[key].reason ?? null,
      statusSince: states[key].since ?? yesterday,
      body: spec.body,
      variables: spec.variables.length,
      buttons: spec.buttons.map((button) => button.title),
      messageKey: key,
      requestedAt: lastWeek,
    })
  }

  // «Avisar un control» con un cambio de texto en revisión: sigue saliendo el anterior.
  await tx.insert(clinicMessage).values({ organizationId: orgId, key: "recordatorio_control" }).onConflictDoNothing()
  const [control] = await tx
    .select({ id: clinicMessage.id })
    .from(clinicMessage)
    .where(and(eq(clinicMessage.organizationId, orgId), eq(clinicMessage.key, "recordatorio_control")))
    .limit(1)
  if (control) {
    const body = "Estimada {{persona}}: en {{clinica}} tiene pendiente este control: {{control}}. Responda a este mensaje y le buscamos un horario."
    const templateName = "odentia_recordatorio_control_tsemilla01"
    await tx
      .insert(clinicMessageVersion)
      .values({ organizationId: orgId, messageId: control.id, number: 1, body, templateName })
      .onConflictDoNothing()
    await tx.update(clinicMessage).set({ currentVersion: 0, pendingVersion: 1 }).where(eq(clinicMessage.id, control.id))
    const positional = positionalBody(body)
    await upsert({
      name: templateName,
      category: "utility",
      status: "en_revision",
      reason: null,
      body: positional.body,
      variables: positional.variables.length,
      buttons: catalogMessageOf("recordatorio_control")?.buttons.map((button) => button.title) ?? [],
      messageKey: "recordatorio_control",
      requestedAt: yesterday,
    })
  }

  // Un mensaje creado por la clínica para la Bandeja, ya aprobado.
  const ownTitle = "Tu trabajo ya está listo"
  let [own] = await tx
    .select({ id: clinicMessage.id })
    .from(clinicMessage)
    .where(and(eq(clinicMessage.organizationId, orgId), eq(clinicMessage.title, ownTitle), isNull(clinicMessage.archivedAt)))
    .limit(1)
  if (!own) {
    ;[own] = await tx
      .insert(clinicMessage)
      .values({ organizationId: orgId, title: ownTitle, buttonTitle: "Quiero mi cita", currentVersion: 1 })
      .returning({ id: clinicMessage.id })
  }
  if (own) {
    const body = "Hola, {{persona}}. Tu trabajo ya llegó a {{clinica}}. Escríbenos y coordinamos tu cita."
    const templateName = "clinica_mensaje_semilla01"
    await tx
      .insert(clinicMessageVersion)
      .values({ organizationId: orgId, messageId: own.id, number: 1, body, templateName })
      .onConflictDoNothing()
    const positional = positionalBody(body)
    await upsert({
      name: templateName,
      category: "utility",
      status: "aprobada",
      reason: null,
      statusSince: lastWeek,
      body: positional.body,
      variables: positional.variables.length,
      buttons: ["Quiero mi cita"],
      messageKey: null,
      requestedAt: lastWeek,
    })
  }

  // Plantillas que ya estaban en la cuenta: se ven, pero se cambian en la página de Meta.
  await upsert({
    name: "bienvenida",
    category: "utility",
    status: "aprobada",
    reason: null,
    statusSince: null,
    body: "Hola, {{1}}. Gracias por escribirnos. En breve te atendemos.",
    variables: 1,
    buttons: [],
    messageKey: null,
    requestedAt: null,
  })
  await upsert({
    name: "promo_blanqueamiento",
    category: "marketing",
    status: "pausada",
    reason: "Calidad baja",
    body: "Este mes, blanqueamiento con evaluación incluida. ¿Te reservamos un horario?",
    variables: 0,
    buttons: [],
    messageKey: null,
    requestedAt: null,
  })
}

/**
 * Semilla determinista del Administrador (idempotente): lo que el contacto
 * principal aceptó recibir y dos casos ya cerrados de «Recordar la cita», para
 * ver «qué pasó» y el aviso de «no pude». Todas las líneas quedan apagadas y
 * no queda ningún caso pendiente: el worker no envía nada desde datos de prueba.
 */
export async function seedAutomation(
  tx: Db,
  input: { orgId: string; ownerUserId: string; contactId: string },
): Promise<void> {
  const { orgId, ownerUserId, contactId } = input
  const [line] = await tx
    .insert(automationRule)
    .values({ organizationId: orgId, name: "Recordar la cita", kind: "recordatorio_cita", enabled: false, createdBy: ownerUserId })
    .onConflictDoUpdate({
      target: [automationRule.organizationId, automationRule.kind],
      set: { enabled: false, updatedAt: new Date() },
    })
    .returning({ id: automationRule.id })
  if (line) {
    const yesterday = new Date(Date.now() - 20 * 3_600_000)
    await tx
      .insert(automationJob)
      .values([
        {
          organizationId: orgId, ruleId: line.id, kind: "recordatorio_cita", status: "omitido", cause: "sin_permiso",
          dedupeKey: "semilla:recordatorio_cita:sin-permiso", scheduledFor: yesterday, contactId,
          lastError: "La persona no aceptó mensajes de recordatorio", updatedAt: yesterday,
        },
        {
          organizationId: orgId, ruleId: line.id, kind: "recordatorio_cita", status: "fallido", cause: "sin_plantilla",
          dedupeKey: "semilla:recordatorio_cita:sin-plantilla", scheduledFor: yesterday, contactId,
          lastError: "WhatsApp aún no aprueba el mensaje y la persona no escribió en las últimas 24 horas", updatedAt: yesterday,
        },
      ])
      .onConflictDoNothing({ target: [automationJob.organizationId, automationJob.dedupeKey] })
  }
  // Un pedido con palabras esperando decisión: la línea que la clínica puede
  // crear, en borrador. No hace nada hasta que una persona la prenda.
  await tx
    .insert(automationRule)
    .values({
      organizationId: orgId, name: "Ofrecer otra fecha tras una cancelación", kind: "cita_cancelada", enabled: false, createdBy: ownerUserId,
      draft: {
        request: "Cuando alguien cancele su cita, que el agente le ofrezca otra fecha",
        changes: { enabled: true },
        unsupported: [],
        creates: true,
        by: ownerUserId,
        at: new Date().toISOString(),
      },
    })
    .onConflictDoNothing({ target: [automationRule.organizationId, automationRule.kind] })
  for (const purpose of ["recordatorio", "seguimiento"] as const) {
    await tx
      .insert(automationConsent)
      .values({
        organizationId: orgId,
        contactId,
        purpose,
        status: "granted",
        source: "presencial",
        createdBy: ownerUserId,
      })
      .onConflictDoNothing({
        target: [automationConsent.organizationId, automationConsent.contactId, automationConsent.purpose],
      })
  }
  // Limpieza defensiva: la semilla nunca deja trabajos pendientes que el worker enviaría.
  await tx
    .delete(automationJob)
    .where(and(eq(automationJob.organizationId, orgId), eq(automationJob.status, "pendiente")))
}
