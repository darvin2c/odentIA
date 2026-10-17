import type { Db } from "@odentia/db"
import type { AutomationCause, ConsentPurpose } from "@odentia/db/schema/automation"
import {
  type MessageRoute,
  previewMessageRoute,
  type RoutePreview,
  type RouteSpec,
  routeMessage,
} from "./automation-routing.js"
import { type GateInput, mayWriteFirst, permissionRefusal, permitsMessage } from "./message-permission.js"
import { isWritingTime, sendTimeFor, writingScheduleOf } from "./writing-hours.js"

/**
 * Una puerta para escribirle a alguien (ADR 0042). Antes de que la clínica le
 * escriba a una persona se deciden, en un solo lugar y en este orden:
 *
 * 1. El permiso (`mayWriteFirst`, ADR 0030 y 0040). Lo que odentIA inicia por
 *    su cuenta lo necesita siempre. Lo que manda el equipo (un presupuesto,
 *    «Su enlace», una receta, un comprobante) es un aviso: si la persona
 *    escribió en las últimas 24 horas es una respuesta y sale; si no, solo lo
 *    frena «No quiero ningún mensaje de la clínica».
 * 2. La ventana de 24 horas (`windowOpen`, `message-window.ts`), con un solo
 *    margen.
 * 3. El canal: WhatsApp como respuesta, el mensaje aprobado, el correo
 *    (`routeMessage`); los documentos eligen entre las opciones de
 *    `documentChannelsFor` con su orden natural (decisión 20 v2).
 * 4. La hora: lo que odentIA envía por su cuenta sale dentro del «Horario para
 *    escribir» (`writing-hours.ts`), con la hora de cada sede; los avisos de lo
 *    que pasó y lo que manda el equipo salen al momento.
 *
 * Lo usan las automatizaciones, el agente (retomar, insistir y despedirse),
 * el presupuesto, «Su enlace», las recetas, los comprobantes y «Probar línea».
 */

export {
  type GateInput,
  type MessageInitiative,
  permissionRefusal,
  permitsMessage,
} from "./message-permission.js"

type Refused = { cause: AutomationCause; detail: string }

/**
 * Por dónde saldría, sin abrir ni escribir nada: lo que la pantalla dice antes
 * de enviar y lo que estima «Probar línea». Mismo resultado que `openRoute`.
 */
export async function previewRoute(
  tx: Db,
  orgId: string,
  contactId: string,
  spec: RouteSpec | null,
  input: GateInput,
): Promise<RoutePreview> {
  if (input.initiative === "propia" && !(await mayWriteFirst(tx, orgId, contactId, input.purpose))) {
    return refused(input.purpose)
  }
  const route = await previewMessageRoute(tx, orgId, contactId, spec)
  if ("cause" in route) return route
  if (!(await permitsMessage(tx, orgId, contactId, { ...input, via: route.via }))) return refused(input.purpose)
  return route
}

/**
 * Decide la vía y abre el hilo por donde sale. El permiso se mira antes de
 * abrir nada; solo lo que manda el equipo necesita saber primero si es una
 * respuesta.
 */
export async function openRoute(
  tx: Db,
  orgId: string,
  contactId: string,
  spec: RouteSpec | null,
  input: GateInput,
): Promise<MessageRoute> {
  if (!(await mayWriteFirst(tx, orgId, contactId, input.purpose))) {
    if (input.initiative === "propia") return refused(input.purpose)
    const preview = await previewMessageRoute(tx, orgId, contactId, spec)
    if ("cause" in preview) return preview
    if (preview.via !== "respuesta") return refused(input.purpose)
  }
  return routeMessage(tx, orgId, contactId, spec)
}

function refused(purpose: ConsentPurpose): Refused {
  return { cause: "sin_permiso", detail: permissionRefusal(purpose) }
}

/**
 * La hora: ¿puede salir ahora algo que odentIA envía por su cuenta? Los avisos
 * de lo que pasó salen siempre al momento. Si no, cuándo (`sendTimeFor`: el
 * primer momento permitido, si todavía falta una hora para la cita) o nulo si
 * ya no tiene cuándo salir.
 */
export async function writingTimeFor(
  tx: Db,
  orgId: string,
  input: { purpose: ConsentPurpose; now: Date; timeZone?: string; appointmentAt?: Date | null },
): Promise<{ now: true } | { later: Date } | { never: true }> {
  if (input.purpose === "avisos") return { now: true }
  const schedule = await writingScheduleOf(tx, orgId, input.timeZone)
  if (isWritingTime(input.now, schedule)) return { now: true }
  const later = sendTimeFor(input.now, input.now, schedule, input.appointmentAt ?? null)
  return later ? { later } : { never: true }
}

export { windowOpen, WINDOW_MARGIN_MS, WHATSAPP_WINDOW_MS } from "./message-window.js"
export { mayWriteFirstSql } from "./message-permission.js"
