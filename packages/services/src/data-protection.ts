/**
 * Configuración › Protección de datos (ADR 0080, tableros 9 y 10): el
 * registro de actividades de tratamiento de la clínica. Qué datos guarda, para
 * qué, quién más los toca y cómo atiende los pedidos de las personas. Se arma
 * solo con lo que la clínica usa hoy: nada se escribe aquí. Lo mismo sale en
 * la pantalla y en el PDF para la autoridad.
 */
import { DATA_PROCESSORS, type DataProcessor } from "@odentia/auth/data-processors"
import type { Db } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { processingAgreementAcceptance } from "@odentia/db/schema/workspace"
import { desc, eq, sql } from "drizzle-orm"
import { getAgentConfig } from "./agentConfig.js"
import { type Establishment, header, newWriter, zoneOf } from "./health-documents.js"
import { clinicToday } from "./inventory-stock.js"
import { MUTED, type Zone } from "./pdf-writer.js"

export interface DataProtectionActivity {
  id: "atender" | "citas" | "conversar" | "cobrar" | "novedades"
  purpose: string
  data: string
  basis: string
  keep: string
}

export interface DataProtectionProcessor {
  id: string
  name: string
  receives: string
  country: string
  /** Por qué interviene en esta clínica: «conectado el 3 oct 2026», «Recepción encendida». */
  detail: string | null
}

export interface DataProtectionView {
  responsible: Establishment & {
    /** Lo que falta para que el registro esté completo, en palabras. */
    missing: string[]
  }
  agreement: { version: string; acceptedAt: string; acceptedByName: string | null } | null
  activities: DataProtectionActivity[]
  processors: {
    /** Porque la clínica los usa: un canal conectado, los agentes o el dictado. */
    inUse: DataProtectionProcessor[]
    /** Siempre, porque odentIA funciona así. */
    always: DataProtectionProcessor[]
    /** Los canales que no conectó: «Instagram, Telegram». */
    notUsed: string[]
  }
  requests: {
    year: number
    received: number
    onTime: number
    /** Respondidos o denegados después del plazo. */
    answeredLate: number
    pending: number
    /** Pendientes con el plazo vencido. */
    late: number
    locked: number
  }
}

/** Cómo se llama cada canal que puede conectar la clínica. */
const CHANNEL_NAMES: Record<string, string> = {
  whatsapp_cloud_api: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
  telegram_bot_api: "Telegram",
  gmail: "Gmail",
  microsoft365: "Microsoft 365",
}

function processorRow(p: DataProcessor, detail: string | null, name = p.short): DataProtectionProcessor {
  return { id: p.id, name, receives: p.receives, country: p.country, detail }
}

/** «3 oct 2026», en la zona y el idioma de la clínica. */
function day(value: Date | string, zone: Zone): string {
  return new Date(value)
    .toLocaleDateString(zone.locale, { timeZone: zone.timezone, day: "numeric", month: "short", year: "numeric" })
    .replaceAll(".", "")
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

export async function getDataProtectionView(tx: Db, orgId: string): Promise<DataProtectionView> {
  const [profile] = await tx
    .select({
      legalName: orgProfile.legalName,
      tradeName: orgProfile.tradeName,
      fiscalDocType: orgProfile.fiscalDocType,
      fiscalDocNumber: orgProfile.fiscalDocNumber,
      address: orgProfile.fiscalAddress,
      locale: orgProfile.locale,
      timezone: orgProfile.timezone,
    })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
  const responsible: Establishment = profile ?? {
    legalName: null,
    tradeName: null,
    fiscalDocType: null,
    fiscalDocNumber: null,
    address: null,
  }
  const missing = [
    responsible.legalName ? null : "la razón social",
    responsible.fiscalDocNumber ? null : "el documento fiscal",
    responsible.address ? null : "la dirección fiscal",
  ].filter((item): item is string => item !== null)

  const [agreement] = await tx
    .select({
      version: processingAgreementAcceptance.version,
      acceptedAt: processingAgreementAcceptance.acceptedAt,
      acceptedByName: user.name,
    })
    .from(processingAgreementAcceptance)
    .leftJoin(user, eq(user.id, processingAgreementAcceptance.acceptedBy))
    .where(eq(processingAgreementAcceptance.organizationId, orgId))
    .orderBy(desc(processingAgreementAcceptance.acceptedAt))
    .limit(1)

  const connections = await tx.execute<{ provider: string; display_name: string; since: Date }>(sql`
    select provider, min(display_name) as display_name, min(created_at) as since
    from channel_connection
    where organization_id = ${orgId} and status = 'active'
    group by provider`)
  const connected = new Map(connections.map((c) => [c.provider, c]))
  const agent = await getAgentConfig(tx, orgId)
  const zone = zoneOf(responsible)

  const [counts] = await tx.execute<{ novedades: number; people: number }>(sql`
    select
      (select count(*)::int from automation_consent where organization_id = ${orgId}
        and purpose = 'novedades' and status = 'granted') as novedades,
      (select count(*)::int from contact where organization_id = ${orgId}
        and is_active and record_locked_at is null) as people`)

  const activities: DataProtectionActivity[] = [
    {
      id: "atender",
      purpose: "Atenderla",
      data: "Identidad, contacto, historia clínica, odontograma, imágenes, recetas y consentimientos",
      basis: "Su atención de salud y la ley",
      keep: "Lo que pide la norma de salud del país",
    },
    {
      id: "citas",
      purpose: "Sus citas y avisos",
      data: "Nombre, teléfono, citas y recordatorios",
      basis: "Su atención; los recordatorios, con su sí",
      keep: "Mientras sea paciente",
    },
  ]
  if (connected.size > 0)
    activities.push({
      id: "conversar",
      purpose: "Conversar con ella",
      data: `Mensajes${agent.enabled ? " y lo que el agente recuerda" : ""}`,
      basis: "Ella escribió primero o dio su sí",
      keep: "Hasta que pida borrarlos",
    })
  activities.push(
    {
      id: "cobrar",
      purpose: "Cobrarle",
      data: "Cargos, pagos y comprobantes",
      basis: "La ley tributaria",
      keep: "Lo que pide la ley tributaria",
    },
    {
      id: "novedades",
      purpose: "Novedades y promociones",
      data: "Nombre y teléfono",
      basis: `Solo con su sí · ${plural(counts?.novedades ?? 0, "persona", "personas")} de ${(counts?.people ?? 0).toLocaleString(zone.locale)}`,
      keep: "Hasta que diga que no",
    },
  )

  const inUse: DataProtectionProcessor[] = []
  const always: DataProtectionProcessor[] = []
  const usedProviders = new Set<string>()
  for (const p of DATA_PROCESSORS) {
    switch (p.use.kind) {
      case "siempre":
        always.push(processorRow(p, null))
        break
      case "agentes":
        if (agent.enabled || agent.clinicalAssistantEnabled) {
          // El modelo lo usan Recepción y el dictado; la decisión y la búsqueda, solo los agentes.
          if (p.id === "openai") {
            const uses = [agent.enabled ? "agentes encendidos" : null, agent.clinicalAssistantEnabled ? "dictado encendido" : null]
            inUse.push(processorRow(p, uses.filter(Boolean).join(" y ")))
          } else if (agent.enabled) inUse.push(processorRow(p, "agentes encendidos"))
        }
        break
      case "dictado":
        if (agent.clinicalAssistantEnabled) inUse.push(processorRow(p, "dictado encendido"))
        break
      case "canal": {
        const mine = p.use.providers.filter((provider) => connected.has(provider))
        if (mine.length === 0) break
        for (const provider of mine) usedProviders.add(provider)
        const since = mine.map((provider) => connected.get(provider)!.since).sort((a, b) => +a - +b)[0]!
        const channels = mine.map((provider) => CHANNEL_NAMES[provider] ?? provider)
        const name = p.id === "meta" ? `${channels.join(", ")} (Meta)` : p.short
        const account = p.id === "gmail" || p.id === "microsoft365" ? `${connected.get(mine[0]!)!.display_name} · ` : ""
        inUse.push(processorRow(p, `${account}conectado el ${day(since, zone)}`, name))
        break
      }
    }
  }
  const notUsed = Object.entries(CHANNEL_NAMES)
    .filter(([provider]) => !usedProviders.has(provider))
    .map(([, name]) => name)

  const today = await clinicToday(tx, orgId)
  const year = Number(today.slice(0, 4))
  const [stats] = await tx.execute<{
    received: number
    on_time: number
    answered_late: number
    pending: number
    late: number
    locked: number
  }>(sql`
    select
      count(*)::int as received,
      count(*) filter (where status <> 'pendiente' and resolved_at::date <= due_on)::int as on_time,
      count(*) filter (where status <> 'pendiente' and resolved_at::date > due_on)::int as answered_late,
      count(*) filter (where status = 'pendiente' and due_on >= ${today}::date)::int as pending,
      count(*) filter (where status = 'pendiente' and due_on < ${today}::date)::int as late,
      (select count(*)::int from contact where organization_id = ${orgId} and record_locked_at is not null) as locked
    from patient_data_request
    where organization_id = ${orgId} and extract(year from requested_on) = ${year}`)

  return {
    responsible: { ...responsible, missing },
    agreement: agreement
      ? { version: agreement.version, acceptedAt: agreement.acceptedAt.toISOString(), acceptedByName: agreement.acceptedByName }
      : null,
    activities,
    processors: { inUse, always, notUsed },
    requests: {
      year,
      received: stats?.received ?? 0,
      onTime: stats?.on_time ?? 0,
      answeredLate: stats?.answered_late ?? 0,
      pending: stats?.pending ?? 0,
      late: stats?.late ?? 0,
      locked: stats?.locked ?? 0,
    },
  }
}

/** «Registro de actividades de tratamiento»: el PDF de una página para la autoridad (tablero 10). */
export async function renderDataProtectionPdf(view: DataProtectionView): Promise<Uint8Array> {
  const zone = zoneOf(view.responsible)
  const { pdf, w } = await newWriter("Registro de actividades de tratamiento")
  header(w, view.responsible)
  w.text("Registro de actividades de tratamiento", { size: 15, bold: true })
  w.text(`Al ${day(new Date(), zone)} · generado por odentIA`, { size: 8, color: MUTED })
  w.heading("1. Responsable y encargado")
  const fiscal = [view.responsible.fiscalDocType, view.responsible.fiscalDocNumber].filter(Boolean).join(" ")
  w.text(`Responsable: ${[view.responsible.legalName, fiscal].filter(Boolean).join(", ") || "sin datos"}.`)
  w.text(
    view.agreement
      ? `Encargado: odentIA, según el contrato de encargo aceptado el ${day(view.agreement.acceptedAt, zone)} (versión ${view.agreement.version}).`
      : "Encargado: odentIA. El contrato de encargo aún no se aceptó.",
  )
  w.heading("2. Actividades")
  for (const a of view.activities)
    w.list([`${a.purpose}: ${a.data}. Permiso: ${a.basis}. Se guarda: ${a.keep.toLowerCase()}.`])
  w.heading("3. Encargados y transferencias internacionales")
  for (const p of [...view.processors.inUse, ...view.processors.always])
    w.list([`${p.name} (${p.country}): ${p.receives}${p.detail ? ` · ${p.detail}` : ""}.`])
  w.text("Los que están fuera del país son una transferencia internacional autorizada en el contrato de encargo.", {
    size: 8,
    color: MUTED,
  })
  w.heading("4. Cómo se protegen")
  w.text(
    "Cada clínica ve solo sus datos; cada persona del equipo, solo lo que su rol permite. Las consultas a la historia clínica y los cambios quedan registrados. Conexiones cifradas y copias de seguridad diarias.",
  )
  w.heading("5. Derechos de las personas")
  const r = view.requests
  w.text(
    `Se atienden en 10 días corridos. En ${r.year}: ${[
      plural(r.received, "pedido", "pedidos"),
      `${plural(r.onTime, "respondido", "respondidos")} a tiempo`,
      `${r.answeredLate} fuera de plazo`,
      `${plural(r.pending, "pendiente", "pendientes")} dentro de plazo`,
      plural(r.late, "vencido", "vencidos"),
      `${plural(r.locked, "historia bloqueada", "historias bloqueadas")} a pedido`,
    ].join(", ")}.`,
  )
  return pdf.save()
}

/** Cada descarga queda en la Actividad del equipo (decisión 6). */
export async function recordDataProtectionDownload(tx: Db, orgId: string, actorUserId: string): Promise<void> {
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "data_protection.downloaded",
    entity: "organization",
    entityId: orgId,
    metadata: {},
  })
}
