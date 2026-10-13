import type { Db } from "@odentia/db"
import {
  automationConsent,
  automationJob,
  automationRule,
} from "@odentia/db/schema/automation"
import { channelTemplate } from "@odentia/db/schema/crm"
import { and, eq } from "drizzle-orm"
import {
  AUTOMATION_MESSAGE_LANGUAGE,
  AUTOMATION_MESSAGES,
  type AutomationMessageKey,
} from "./automation-messages.js"

/**
 * Catálogo de mensajes de una conexión de WhatsApp de demostración, uno en cada
 * estado que puede dar el proveedor, para ver Configuración › Canales y cada
 * vía de envío. Son datos de la semilla: ninguno pasó por WhatsApp.
 */
export async function seedChannelTemplates(
  tx: Db,
  input: { orgId: string; connectionId: string },
): Promise<void> {
  const { orgId, connectionId } = input
  const yesterday = new Date(Date.now() - 24 * 3_600_000)
  const own: { key: AutomationMessageKey; status: string; reason?: string }[] = [
    { key: "recordatorio_cita", status: "aprobada" },
    { key: "recordatorio_control", status: "aprobada" },
    { key: "seguimiento_presupuesto", status: "en_revision" },
    { key: "seguimiento_no_asistencia", status: "rechazada", reason: "INVALID_FORMAT" },
  ]
  const rows = [
    ...own.map(({ key, status, reason }) => {
      const spec = AUTOMATION_MESSAGES[key]
      return {
        name: spec.template,
        language: AUTOMATION_MESSAGE_LANGUAGE,
        category: spec.category,
        status,
        reason: reason ?? null,
        body: spec.body,
        variables: spec.variables.length,
        buttons: spec.buttons.map((button) => button.title),
        messageKey: key as string | null,
        requestedAt: yesterday as Date | null,
      }
    }),
    {
      name: "bienvenida",
      language: AUTOMATION_MESSAGE_LANGUAGE,
      category: "utility",
      status: "aprobada",
      reason: null,
      body: "Hola, {{1}}. Gracias por escribirnos. En breve te atendemos.",
      variables: 1,
      buttons: [],
      messageKey: null,
      requestedAt: null,
    },
    {
      name: "promo_blanqueamiento",
      language: AUTOMATION_MESSAGE_LANGUAGE,
      category: "marketing",
      status: "pausada",
      reason: "Calidad baja",
      body: "Este mes, blanqueamiento con evaluación incluida. ¿Te reservamos un horario?",
      variables: 0,
      buttons: [],
      messageKey: null,
      requestedAt: null,
    },
  ]
  for (const row of rows) {
    await tx
      .insert(channelTemplate)
      .values({ organizationId: orgId, connectionId, syncedAt: yesterday, ...row })
      .onConflictDoNothing({
        target: [channelTemplate.connectionId, channelTemplate.name, channelTemplate.language],
      })
  }
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
