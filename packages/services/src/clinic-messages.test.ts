import { randomUUID } from "node:crypto"
import type { TemplateStatus } from "@odentia/channels"
import { type Db, withOrgContext } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import {
  agentConfig,
  channelConnection,
  channelTemplate,
  clinicMessage,
  clinicMessageVersion,
  contact,
  contactIdentity,
  conversation,
  message,
} from "@odentia/db/schema/crm"
import { branch, orgProfile } from "@odentia/db/schema/org"
import { workspaceNotification } from "@odentia/db/schema/workspace"
import { and, asc, eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { tickAutomations } from "./agent-admin.js"
import { applyTemplateUpdates, requestNeededTemplates, setLine } from "./automation.js"
import { parseReplyId } from "./automation-messages.js"
import { listChannelTemplates } from "./channel-templates.js"
import {
  checkMessageText,
  createClinicMessage,
  currentAutomationMessage,
  deleteClinicMessage,
  findMessageTemplate,
  listApprovedMessages,
  listClinicMessages,
  revertMessageText,
  saveMessageText,
  sendApprovedMessage,
  listRecategorizedMessages,
} from "./clinic-messages.js"
import {
  changeConnectionCredentials,
  createConnection,
  getConnectionSetup,
  listConnectionsOverview,
  markWebhookVerified,
  setConnectionStatus,
  syncConnectionAccount,
  testConnection,
} from "./connections.js"
import { getConversationDetail } from "./conversations.js"
import { configurePublicLinks } from "./public-links.js"
import { decryptConfig, secretsKeyFromEnv } from "./secrets.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * Los mensajes de WhatsApp de una clínica y su conexión, contra la base. Sin
 * proveedor real: las respuestas de Meta son las que el caso le dicta a un
 * `fetch` de prueba, con la forma que documenta Meta. Nada de esto acredita que
 * WhatsApp acepte un texto, una clave o una plantilla.
 */
setupTestDb()
// El aviso con «Su enlace», «Presupuesto listo» y «Su enlace» llevan un botón con la dirección de la clínica.
configurePublicLinks({ webURL: "https://app.odentia.test", cookieDomain: "odentia.test" })
const KEY = secretsKeyFromEnv("cd".repeat(32))
const HOUR = 3_600_000
const WA_CONFIG = { phoneNumberId: "PNID", wabaId: "WABA", accessToken: "clave-1", appSecret: "secreto" }
const OFFLINE = { fetch, validateExternal: false, secretsKey: KEY }

interface Clinic {
  orgId: string
  ownerId: string
  whatsappId: string
}

interface Call {
  url: string
  method: string
  body: unknown
}

/**
 * Meta de prueba. Responde con la forma documentada lo que una cuenta sana
 * respondería; el caso puede dictar otra respuesta para una llamada.
 */
function fakeMeta(override?: (call: Call) => { status?: number; json: unknown } | undefined) {
  const calls: Call[] = []
  let created = 900
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    const answer = override?.(call) ?? defaultAnswer(call)
    return new Response(JSON.stringify(answer.json), { status: answer.status ?? 200 })
  }) as typeof fetch
  function defaultAnswer(call: Call): { status?: number; json: unknown } {
    if (call.url.includes("api.telegram.org")) {
      return call.url.endsWith("/getMe")
        ? { json: { ok: true, result: { id: 77, username: "clinicabot", first_name: "Clínica" } } }
        : { json: { ok: true, result: true } }
    }
    // Con la app propia: la app queda suscrita y el número ya estaba registrado.
    if (call.url.includes("/subscribed_apps")) return { json: { success: true } }
    if (call.url.includes("fields=platform_type")) return { json: { id: "PNID", platform_type: "CLOUD_API" } }
    if (call.url.includes("fields=display_phone_number")) {
      return { json: { id: "PNID", display_phone_number: "+51 999 888 777", verified_name: "Clínica Sonríe" } }
    }
    if (call.url.includes("fields=quality_rating")) {
      return { json: { id: "PNID", quality_rating: "GREEN", whatsapp_business_manager_messaging_limit: "TIER_2K" } }
    }
    if (call.url.includes("/message_templates")) {
      if (call.method === "POST") {
        const body = call.body as { category: string }
        return { json: { id: String(++created), status: "PENDING", category: body.category } }
      }
      if (call.method === "DELETE") return { json: { success: true } }
      return { json: { data: [] } }
    }
    return { status: 404, json: { error: { message: "Llamada no prevista" } } }
  }
  const of = (method: string, part: string) => calls.filter((call) => call.method === method && call.url.includes(part))
  return { calls, fetch: impl, of }
}

async function organization(): Promise<{ orgId: string; ownerId: string }> {
  const orgId = randomUUID()
  const ownerId = `owner-${orgId}`
  await insertOrg(ownerDb, orgId, `msg-${orgId}`)
  await ownerDb.update(orgProfile).set({ tradeName: "Clínica Sonríe" }).where(eq(orgProfile.organizationId, orgId))
  await ownerDb.insert(user).values({ id: ownerId, name: "Dueña", email: `${ownerId}@msg.test`, emailVerified: true })
  await ownerDb.insert(member).values({ id: `m-${ownerId}`, userId: ownerId, organizationId: orgId, role: "owner", createdAt: new Date() })
  await ownerDb.insert(agentConfig).values({ organizationId: orgId, enabled: true, advisor: { enabled: true } })
  await ownerDb.insert(branch).values({ organizationId: orgId, name: "Centro", timezone: "America/Lima" })
  return { orgId, ownerId }
}

/** Clínica con WhatsApp conectado sin proveedor: sus siete mensajes quedan «en revisión». */
async function clinic(): Promise<Clinic> {
  const { orgId, ownerId } = await organization()
  const connection = await withOrgContext(appDb, orgId, (tx) =>
    createConnection(tx, orgId, KEY, { channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "WA", config: WA_CONFIG }, { fetch, validateExternal: false }),
  )
  return { orgId, ownerId, whatsappId: connection.id }
}

function run<T>(c: { orgId: string }, fn: (tx: Db) => Promise<T>): Promise<T> {
  return withOrgContext(appDb, c.orgId, fn)
}

const messages = (c: Clinic) => run(c, (tx) => listClinicMessages(tx, c.orgId, c.whatsappId))
const messageOf = async (c: Clinic, id: string) => (await messages(c)).find((item) => item.id === id)!
const save = (c: Clinic, id: string, body: string) =>
  run(c, (tx) => saveMessageText(tx, c.orgId, c.whatsappId, c.ownerId, id, body, OFFLINE))

/** WhatsApp avisa que una plantilla cambió de estado. */
const whatsappSays = (c: Clinic, name: string, status: TemplateStatus, reason: string | null = null) =>
  run(c, (tx) => applyTemplateUpdates(tx, c.orgId, c.whatsappId, [{ externalId: null, name, language: "es", status, reason }]))

async function versionsOf(c: Clinic) {
  return ownerDb
    .select({ number: clinicMessageVersion.number, templateName: clinicMessageVersion.templateName, body: clinicMessageVersion.body })
    .from(clinicMessageVersion)
    .where(eq(clinicMessageVersion.organizationId, c.orgId))
    .orderBy(asc(clinicMessageVersion.createdAt), asc(clinicMessageVersion.number))
}

const noticesOf = (c: Clinic) =>
  ownerDb.select().from(workspaceNotification).where(eq(workspaceNotification.organizationId, c.orgId)).orderBy(asc(workspaceNotification.createdAt))

/** Conversación de WhatsApp con una persona; `wroteHoursAgo` nulo es que nunca escribió. */
async function thread(c: Clinic, name: string, wroteHoursAgo: number | null) {
  const phone = `519${randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "0")}`
  const [person] = await ownerDb
    .insert(contact)
    .values({ organizationId: c.orgId, displayName: name, givenNames: name.split(" ")[0] })
    .returning({ id: contact.id })
  const [identity] = await ownerDb
    .insert(contactIdentity)
    .values({ organizationId: c.orgId, contactId: person!.id, channel: "whatsapp", externalUserId: phone, isPrimary: true })
    .returning({ id: contactIdentity.id })
  const [row] = await ownerDb
    .insert(conversation)
    .values({
      organizationId: c.orgId, contactId: person!.id, contactIdentityId: identity!.id, channelConnectionId: c.whatsappId,
      externalThreadId: `wa:${phone}`, lastInboundAt: wroteHoursAgo === null ? null : new Date(Date.now() - wroteHoursAgo * HOUR),
    })
    .returning({ id: conversation.id })
  return row!.id
}

const REMINDER = "Hola, {{persona}}. Te recordamos la cita en {{lugar}}: {{citas}}. Si necesitas cambiarla, responde a este mensaje."
const FORMAL = "Estimada {{persona}}: le recordamos su cita en {{lugar}}: {{citas}}. Si necesita cambiarla, responda a este mensaje."

describe("los mensajes vienen escritos y son de la clínica", () => {
  it("la lista dice de cada uno lo que la pantalla muestra, con sus textos", async () => {
    const c = await clinic()
    await run(c, (tx) => setLine(tx, c.orgId, c.ownerId, "recordatorio_cita", { enabled: true, hoursBefore: [24] }))
    const items = await messages(c)
    expect(items.map((item) => [item.id, item.origin, item.title, item.current.status])).toEqual([
      ["recordatorio_cita", "agente", "Recordar la cita", "en_revision"],
      ["recordatorio_cita_datos", "agente", "Recordar la cita: recordatorio, faltan datos", "en_revision"],
      ["recordatorio_cita_confirmada", "agente", "Recordar la cita: recordatorio, cita confirmada", "en_revision"],
      ["cita_sin_llegar", "agente", "Recordar la cita: ¿vienes en camino?", "en_revision"],
      ["aviso_cita_reservada", "agente", "Recordar la cita: cita reservada", "en_revision"],
      ["aviso_cita_reservada_datos", "agente", "Recordar la cita: cita reservada, faltan datos", "en_revision"],
      ["aviso_cita_movida", "agente", "Recordar la cita: cambio de fecha", "en_revision"],
      ["aviso_cita_cancelada", "agente", "Recordar la cita: cita cancelada", "en_revision"],
      ["recordatorio_control", "agente", "Avisar un control", "en_revision"],
      ["seguimiento_presupuesto", "agente", "Retomar un presupuesto", "en_revision"],
      ["seguimiento_comercial", "agente", "Retomar una oportunidad", "en_revision"],
      ["seguimiento_no_asistencia", "agente", "Reprogramar tras una inasistencia", "en_revision"],
      ["cita_cancelada", "agente", "Ofrecer otra fecha tras una cancelación", "en_revision"],
      ["invitar_a_volver", "agente", "Invitar a volver", "en_revision"],
      ["retomar_conversacion", "bandeja", "Retomar la conversación", "en_revision"],
      ["presupuesto_listo", "plan", "Presupuesto listo", "en_revision"],
      ["su_enlace", "plan", "Su enlace", "en_revision"],
      ["ver_respuesta", "plan", "Ver respuesta", "en_revision"],
      ["enlace_recibido", "plan", "Recibido desde su enlace", "en_revision"],
    ])
    const reminder = items[0]!
    expect(reminder).toMatchObject({
      when: "Un día antes de la cita.",
      line: { key: "recordatorio_cita", title: "Recordar la cita", enabled: true },
      pending: null,
      category: "Utilidad",
      meanwhile: "Mientras tanto sale como respuesta a quien escribió en las últimas 24 horas, o por correo.",
      editable: true,
      deletable: false,
      canRevert: false,
    })
    expect(reminder.current).toMatchObject({ body: REMINDER, statusLabel: "En revisión", reason: null, isDefault: true })
    expect(reminder.current.since).not.toBeNull()
    // Lo resaltado lo pone el sistema: aquí, con el nombre de esta clínica y su sede.
    expect(reminder.current.previewParts).toEqual([
      { text: "Hola, ", data: false },
      { text: "Lucía", data: true },
      { text: ". Te recordamos la cita en ", data: false },
      { text: "Clínica Sonríe, sede Centro", data: true },
      { text: ": ", data: false },
      { text: "mañana, martes 13 de octubre, a las 10:00, con Dra. Ana Torres", data: true },
      { text: ". Si necesitas cambiarla, responde a este mensaje.", data: false },
    ])
    expect(reminder.buttons).toEqual([
      { title: "Confirmar", does: "La cita queda confirmada al momento." },
      { title: "No podré ir", does: "Sofi le busca otra fecha en la conversación." },
      { title: "No más recordatorios", does: "Deja de recibir recordatorios; lo demás no cambia." },
    ])
    expect(reminder.variables.map((item) => [item.key, item.required])).toEqual([["persona", true], ["lugar", true], ["citas", true]])
    // El recordatorio con «Completar mis datos», a quien le faltan: el botón abre su enlace y los demás son los del recordatorio.
    expect(items[1]).toMatchObject({
      line: { key: "recordatorio_cita", enabled: true },
      buttons: [
        { title: "Completar mis datos" },
        { title: "Confirmar" },
        { title: "No podré ir" },
        { title: "No más recordatorios" },
      ],
    })
    // El recordatorio de una cita ya confirmada: sin «Confirmar», y «Cambiar mi cita» abre su enlace (ADR 0109).
    expect(items[2]).toMatchObject({
      when: "Antes de una cita ya confirmada (la que eligió la persona o la que ya confirmó): en lugar del recordatorio, sin «Confirmar» y con «Cambiar mi cita».",
      line: { key: "recordatorio_cita", title: "Recordar la cita", enabled: true },
      category: "Utilidad",
      meanwhile: "Mientras tanto sale como respuesta a quien escribió en las últimas 24 horas, o por correo; a los demás les llega el recordatorio de siempre, con «Confirmar».",
      buttons: [
        { title: "Cambiar mi cita", does: "Abre su enlace: ahí cambia la cita a otro horario o la cancela, sin ver nada de lo guardado." },
        { title: "No podré ir", does: "Sofi le busca otra fecha en la conversación." },
        { title: "No más recordatorios", does: "Deja de recibir recordatorios; lo demás no cambia." },
      ],
    })
    expect(items[2]!.current.body).toBe("Hola, {{persona}}. Te esperamos {{citas}} en {{lugar}}. Si necesitas cambiar la cita, responde a este mensaje.")
    expect(items[2]!.variables.map((item) => [item.key, item.required])).toEqual([["persona", true], ["citas", true], ["lugar", true]])
    // Los avisos de la cita son de «Recordar la cita»: prendida ella, salen ellos.
    expect(items[4]).toMatchObject({
      when: "Al reservar una cita desde la Agenda, la ficha o la conversación.",
      line: { key: "recordatorio_cita", title: "Recordar la cita", enabled: true },
      category: "Utilidad",
      // Un aviso de lo que pasó no tiene botón de baja (ADR 0040).
      buttons: [{ title: "No podré ir", does: "Sofi le busca otra fecha en la conversación." }],
    })
    // El aviso de reserva con «Su enlace»: su botón abre el enlace.
    expect(items[5]).toMatchObject({
      line: { key: "recordatorio_cita", enabled: true },
      buttons: [
        { title: "Ver mi cita y mis datos", does: "Abre su enlace: lo que tiene pendiente con la clínica, sin ver nada de lo guardado." },
      ],
    })
    expect(items[7]!.current.body).toBe("Hola, {{persona}}. Tu cita del {{cita_pasada}} en {{clinica}} quedó cancelada. ¿Te buscamos otra fecha?")
    expect(items[9]).toMatchObject({ when: "Cuando un presupuesto lleva 2 días sin respuesta.", line: { enabled: false }, category: "Marketing" })
    // «Retomar una oportunidad» viene escrito como los demás del agente: su texto, sus datos y la baja.
    expect(items[10]).toMatchObject({
      when: "Cuando una oportunidad tiene su próxima acción vencida.",
      line: { key: "seguimiento_comercial", title: "Retomar una oportunidad", enabled: false },
      category: "Marketing",
      editable: true,
      deletable: false,
      buttons: [
        { title: "Sí, continuemos", does: "Sofi sigue la conversación con la persona." },
        { title: "No enviar más", does: "Deja de recibir estos mensajes; lo demás no cambia." },
      ],
    })
    expect(items[10]!.current.body).toBe("Hola, {{persona}}. Te escribimos de {{clinica}} sobre tu consulta de «{{oportunidad}}». ¿Seguimos conversando?")
    expect(items[10]!.variables.map((item) => [item.key, item.label, item.required])).toEqual([
      ["persona", "Nombre de la persona", true],
      ["clinica", "Nombre de la clínica", true],
      ["oportunidad", "Título de la oportunidad", true],
    ])
    expect(items[14]).toMatchObject({
      when: null,
      line: null,
      meanwhile: "Mientras tanto no se ofrece en la Bandeja.",
      buttons: [{ title: "Sí, continuemos", does: "La persona responde y tu equipo puede escribirle con libertad durante 24 horas." }],
    })
    expect(items[14]!.current.body).toBe("Hola, {{persona}}. Te escribimos de {{clinica}} para continuar con tu consulta. ¿Seguimos por aquí?")
  })

  it("comprobar un texto: cada regla dice su frase y la vista previa lleva los datos de ejemplo", async () => {
    const c = await clinic()
    const check = (body: string, extra: { messageId?: string; title?: string; buttonTitle?: string } = { messageId: "recordatorio_cita" }) =>
      run(c, (tx) => checkMessageText(tx, c.orgId, c.whatsappId, { body, ...extra }))
    const good = await check(FORMAL)
    expect(good.ok).toBe(true)
    expect(good.checks).toEqual([
      { ok: true, text: "Bien: están los tres datos.", field: "body" },
      { ok: true, text: "Bien: no empieza ni termina con un dato.", field: "body" },
      { ok: true, text: "Bien: 102 de 1\u00a0024 caracteres.", field: "body" },
    ])
    expect(good.previewParts.map((part) => part.text).join("")).toBe(
      "Estimada Lucía: le recordamos su cita en Clínica Sonríe, sede Centro: mañana, martes 13 de octubre, a las 10:00, con Dra. Ana Torres. Si necesita cambiarla, responda a este mensaje.",
    )
    const failures = async (body: string, extra?: Parameters<typeof check>[1]) =>
      (await check(body, extra)).checks.filter((item) => !item.ok).map((item) => item.text)
    expect(await failures("Hola, {{persona}}. Tu cita en {{lugar}}. Te esperamos.")).toEqual([
      "Falta el dato «Fecha, hora y profesional de la cita».",
    ])
    expect(await failures("Hola, {{persona}} {{persona}}. En {{lugar}}: {{citas}}. Te esperamos.")).toEqual([
      "El dato «Nombre de la persona» está más de una vez: va una sola.",
    ])
    expect(await failures("Hola, {{persona}}. En {{lugar}}: {{citas}}. Tu saldo es {{saldo}}. Chau.")).toEqual([
      "«saldo» no es un dato de este mensaje: quítalo.",
    ])
    expect(await failures("{{persona}}, te recordamos la cita en {{lugar}}: {{citas}}")).toEqual([
      "No puede empezar ni terminar con un dato: WhatsApp pide texto antes y después.",
    ])
    // Un punto después del último dato (o un «¡» antes del primero) no cuenta como texto: Meta lo rechaza igual.
    expect(await failures("Hola, {{persona}}. Te recordamos la cita: {{citas}}, en {{lugar}}.")).toEqual([
      "No puede empezar ni terminar con un dato: WhatsApp pide texto antes y después.",
    ])
    expect(await failures("¡{{persona}}! Te recordamos la cita: {{citas}}, en {{lugar}}. Te esperamos.")).toEqual([
      "No puede empezar ni terminar con un dato: WhatsApp pide texto antes y después.",
    ])
    expect(await failures(`Hola, {{persona}}. En {{lugar}}: {{citas}}. ${"a".repeat(1100)}`)).toEqual([
      "Tiene 1\u00a0130 caracteres y el máximo es 1\u00a0024.",
    ])
    expect(await failures("Hola, {{persona}}.\tEn {{lugar}}: {{citas}}.\n\n\nTe esperamos.")).toEqual([
      "Tiene tabulaciones: cámbialas por un espacio.",
      "Tiene más de dos saltos de línea seguidos: deja como mucho una línea en blanco.",
    ])
    expect(await failures("  ")).toEqual(["Escribe el texto del mensaje."])
    expect(await failures(FORMAL, { messageId: "recordatorio_cita", buttonTitle: "Otro botón" })).toEqual([
      "Los botones de este mensaje no se cambian.",
    ])
    // Uno nuevo de la clínica: solo el nombre de la persona y el de la clínica, y ninguno es obligatorio.
    expect(await failures("Tu trabajo ya llegó. Escríbenos.", { title: "Tu trabajo ya está listo" })).toEqual([])
    // Cada comprobación dice de qué dato es: la pantalla la pinta en ese campo.
    const own = await check("Hola, {{persona}}. Tu cita: {{citas}}. Te esperamos.", { title: "", buttonTitle: "Quiero coordinar mi cita ya" })
    expect(own.checks.filter((item) => !item.ok).map(({ field, text }) => ({ field, text }))).toEqual([
      { field: "title", text: "Escribe para qué sirve el mensaje." },
      { field: "buttonTitle", text: "El botón admite hasta 20 caracteres." },
      { field: "body", text: "«citas» no es un dato de este mensaje: quítalo." },
    ])
    // Al guardar, el primer fallo va en su campo.
    await expect(save(c, "recordatorio_cita", "Hola, {{persona}}.")).rejects.toMatchObject({
      code: "VALIDATION",
      message: "Falta el dato «Clínica y sede».",
      fields: { body: "Falta el dato «Clínica y sede»." },
    })
  })
})

describe("cambiar el texto nunca deja a la clínica sin mensaje", () => {
  it("con el texto vigente aprobado, sigue saliendo hasta que WhatsApp aprueba el nuevo", async () => {
    const c = await clinic()
    await whatsappSays(c, "odentia_recordatorio_cita_v2", "aprobada")
    const edited = await save(c, "recordatorio_cita", FORMAL)
    const [version] = await versionsOf(c)
    expect(version).toMatchObject({ number: 1, body: FORMAL })
    expect(version!.templateName).toMatch(/^odentia_recordatorio_cita_t[0-9a-f]{10}$/)
    expect(edited.current).toMatchObject({ body: REMINDER, status: "aprobada", isDefault: true })
    expect(edited.pending).toMatchObject({ body: FORMAL, status: "en_revision", isDefault: false })
    expect(edited).toMatchObject({ meanwhile: "Tu cambio de texto está en revisión; sigue saliendo el anterior.", canRevert: true })
    // Lo que envía el agente sigue siendo el texto y la plantilla de antes.
    expect(await run(c, (tx) => currentAutomationMessage(tx, c.orgId, "recordatorio_cita"))).toMatchObject({
      template: "odentia_recordatorio_cita_v2",
      variables: ["persona", "lugar", "citas"],
    })
    expect(await run(c, (tx) => findMessageTemplate(tx, c.orgId, c.whatsappId, "recordatorio_cita"))).toMatchObject({
      name: "odentia_recordatorio_cita_v2",
      status: "aprobada",
    })

    await whatsappSays(c, version!.templateName, "aprobada")
    const approved = await messageOf(c, "recordatorio_cita")
    expect(approved.current).toMatchObject({ body: FORMAL, status: "aprobada", isDefault: false })
    expect(approved).toMatchObject({ pending: null, meanwhile: null, canRevert: true })
    expect(await run(c, (tx) => currentAutomationMessage(tx, c.orgId, "recordatorio_cita"))).toMatchObject({
      template: version!.templateName,
      body: "Estimada {{1}}: le recordamos su cita en {{2}}: {{3}}. Si necesita cambiarla, responda a este mensaje.",
      // Los botones no cambian con el texto: de ellos depende que la cita se confirme sola.
      buttons: [{ action: "confirmar", title: "Confirmar" }, { action: "responder", title: "No podré ir", asks: "cambiar" }, { action: "baja", title: "No más recordatorios" }],
    })
    expect((await noticesOf(c)).map((notice) => [notice.title, notice.body, notice.href])).toEqual([
      ["WhatsApp aprobó un mensaje: «Recordar la cita»", "Ya puede salir a quien no escribió en las últimas 24 horas.", "/settings/integrations/whatsapp"],
      ["WhatsApp aprobó tu cambio de texto: «Recordar la cita»", "Desde ahora sale el texto nuevo.", "/settings/integrations/whatsapp"],
    ])
  })

  it("si WhatsApp rechaza el cambio, se queda el anterior y dice por qué; otro texto lo reemplaza", async () => {
    const c = await clinic()
    await whatsappSays(c, "odentia_recordatorio_cita_v2", "aprobada")
    await save(c, "recordatorio_cita", FORMAL)
    const [first] = await versionsOf(c)
    await whatsappSays(c, first!.templateName, "rechazada", "INVALID_FORMAT")
    const rejected = await messageOf(c, "recordatorio_cita")
    expect(rejected.current).toMatchObject({ body: REMINDER, status: "aprobada" })
    expect(rejected.pending).toMatchObject({ status: "rechazada", statusLabel: "Rechazado", reason: "El formato del texto no cumple las reglas de WhatsApp" })
    expect(rejected.meanwhile).toBe("WhatsApp no aceptó el cambio: sigue saliendo el texto anterior.")
    expect((await noticesOf(c)).at(-1)).toMatchObject({
      title: "WhatsApp no aceptó tu cambio de texto: «Recordar la cita»",
      body: "Motivo: El formato del texto no cumple las reglas de WhatsApp. Sigue saliendo el texto anterior. Puedes cambiarlo y pedirlo de nuevo.",
    })
    await expect(save(c, "recordatorio_cita", FORMAL)).rejects.toThrow("Ese es el texto que WhatsApp rechazó: cámbialo antes de pedirlo de nuevo.")
    // En «Te espera», lo rechazado no sigue «en revisión»: hay que escribir otro.
    await ownerDb.update(channelTemplate).set({ category: "marketing" }).where(and(eq(channelTemplate.organizationId, c.orgId), eq(channelTemplate.name, "odentia_recordatorio_cita_v2")))
    const promotions = () => withOrgContext(appDb, c.orgId, (tx) => listRecategorizedMessages(tx, c.orgId))
    expect(await promotions()).toMatchObject([{ messageId: "recordatorio_cita", inReview: false, rejected: true }])
    const again = await save(c, "recordatorio_cita", FORMAL.replace("Estimada", "Hola,"))
    expect(again.current.body).toBe(REMINDER)
    expect(again.pending).toMatchObject({ status: "en_revision" })
    expect(await promotions()).toMatchObject([{ messageId: "recordatorio_cita", inReview: true, rejected: false }])
    // De un texto que ya fue reemplazado no se avisa.
    const before = (await noticesOf(c)).length
    await whatsappSays(c, first!.templateName, "aprobada")
    expect(await noticesOf(c)).toHaveLength(before)
    expect((await messageOf(c, "recordatorio_cita")).current.body).toBe(REMINDER)
  })

  it("sin ninguna versión aprobada todavía, vale el último texto guardado", async () => {
    const c = await clinic()
    const edited = await save(c, "recordatorio_cita", FORMAL)
    expect(edited.current).toMatchObject({ body: FORMAL, status: "en_revision", isDefault: false })
    expect(edited.pending).toBeNull()
    expect((await run(c, (tx) => currentAutomationMessage(tx, c.orgId, "recordatorio_cita"))).body).toContain("Estimada {{1}}")
    await expect(save(c, "recordatorio_cita", FORMAL)).rejects.toThrow("Ese es el texto que ya tiene.")
  })

  it("volver al texto de odentIA no pide otra revisión si ya estaba aprobado", async () => {
    const c = await clinic()
    await whatsappSays(c, "odentia_recordatorio_cita_v2", "aprobada")
    await save(c, "recordatorio_cita", FORMAL)
    const [version] = await versionsOf(c)
    await whatsappSays(c, version!.templateName, "aprobada")
    const meta = fakeMeta()
    const reverted = await run(c, (tx) =>
      revertMessageText(tx, c.orgId, c.whatsappId, c.ownerId, "recordatorio_cita", { fetch: meta.fetch, secretsKey: KEY }),
    )
    expect(meta.calls).toHaveLength(0)
    expect(reverted.current).toMatchObject({ body: REMINDER, status: "aprobada", isDefault: true })
    expect(reverted).toMatchObject({ pending: null, canRevert: false })
    expect((await run(c, (tx) => currentAutomationMessage(tx, c.orgId, "recordatorio_cita"))).template).toBe("odentia_recordatorio_cita_v2")
    await expect(
      run(c, (tx) => revertMessageText(tx, c.orgId, c.whatsappId, c.ownerId, "recordatorio_cita", OFFLINE)),
    ).rejects.toThrow("Ya tiene el texto de odentIA.")
    // Escribir de nuevo el texto de odentIA es lo mismo que volver a él.
    await save(c, "recordatorio_cita", FORMAL)
    expect((await save(c, "recordatorio_cita", REMINDER)).current.isDefault).toBe(true)
  })

  it("si el texto de odentIA aún no está aprobado, el de la clínica sigue saliendo mientras lo revisan", async () => {
    const c = await clinic()
    await save(c, "recordatorio_cita", FORMAL)
    const [version] = await versionsOf(c)
    await whatsappSays(c, version!.templateName, "aprobada")
    const reverting = await run(c, (tx) => revertMessageText(tx, c.orgId, c.whatsappId, c.ownerId, "recordatorio_cita", OFFLINE))
    expect(reverting.current).toMatchObject({ body: FORMAL, status: "aprobada" })
    expect(reverting.pending).toMatchObject({ body: REMINDER, status: "en_revision", isDefault: true })
    await whatsappSays(c, "odentia_recordatorio_cita_v2", "aprobada")
    expect((await messageOf(c, "recordatorio_cita")).current).toMatchObject({ body: REMINDER, isDefault: true })
  })

  it("pide a WhatsApp el texto nuevo con otro nombre y los datos en el orden en que quedaron", async () => {
    const c = await clinic()
    const meta = fakeMeta()
    const moved = "{{citas}} es tu cita en {{lugar}}, {{persona}}. Si necesitas cambiarla, responde a este mensaje."
    await expect(
      run(c, (tx) => saveMessageText(tx, c.orgId, c.whatsappId, c.ownerId, "recordatorio_cita", moved, { fetch: meta.fetch, secretsKey: KEY })),
    ).rejects.toThrow("No puede empezar ni terminar con un dato")
    const text = `Tu cita: ${moved.replace(".", ", te esperamos.")}`
    await run(c, (tx) => saveMessageText(tx, c.orgId, c.whatsappId, c.ownerId, "recordatorio_cita", text, { fetch: meta.fetch, secretsKey: KEY }))
    const [version] = await versionsOf(c)
    expect(meta.calls).toHaveLength(1)
    expect(meta.calls[0]).toMatchObject({
      method: "POST",
      url: "https://graph.facebook.com/v25.0/WABA/message_templates",
      body: {
        name: version!.templateName,
        language: "es",
        category: "UTILITY",
        components: [
          {
            type: "BODY",
            text: "Tu cita: {{1}} es tu cita en {{2}}, {{3}}, te esperamos. Si necesitas cambiarla, responde a este mensaje.",
            example: { body_text: [["mañana, martes 13 de octubre, a las 10:00, con Dra. Ana Torres", "Clínica Sonríe, sede Centro", "Lucía"]] },
          },
          { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Confirmar" }, { type: "QUICK_REPLY", text: "No podré ir" }, { type: "QUICK_REPLY", text: "No más recordatorios" }] },
        ],
      },
    })
    expect((await run(c, (tx) => currentAutomationMessage(tx, c.orgId, "recordatorio_cita"))).variables).toEqual(["citas", "lugar", "persona"])
  })

  it("si WhatsApp no acepta la solicitud, el cambio no se guarda y dice el motivo", async () => {
    const c = await clinic()
    const meta = fakeMeta((call) => (call.method === "POST" ? { status: 400, json: { error: { message: "(#100) Invalid parameter" } } } : undefined))
    await expect(
      run(c, (tx) => saveMessageText(tx, c.orgId, c.whatsappId, c.ownerId, "recordatorio_cita", FORMAL, { fetch: meta.fetch, secretsKey: KEY })),
    ).rejects.toMatchObject({ code: "TEMPLATE_REQUEST_FAILED", message: "WhatsApp no aceptó la solicitud de plantilla: (#100) Invalid parameter" })
    expect(await versionsOf(c)).toEqual([])
    expect((await messageOf(c, "recordatorio_cita")).current.isDefault).toBe(true)
  })

  it("un rechazo de WhatsApp llega como 400 con la explicación de Meta, no como 502 que el proxy oculta", async () => {
    const c = await clinic()
    const userMsg = "Las variables no pueden estar al principio ni al final de la plantilla."
    const rejecting = fakeMeta((call) =>
      call.method === "POST"
        ? { status: 400, json: { error: { message: "Invalid parameter", code: 100, error_user_msg: userMsg } } }
        : undefined,
    )
    await expect(
      run(c, (tx) => saveMessageText(tx, c.orgId, c.whatsappId, c.ownerId, "recordatorio_cita", FORMAL, { fetch: rejecting.fetch, secretsKey: KEY })),
    ).rejects.toMatchObject({ code: "TEMPLATE_REQUEST_FAILED", status: 400, message: `WhatsApp no aceptó la solicitud de plantilla: ${userMsg}` })
    // Si Meta no responde (un 5xx), sigue siendo un 502.
    const down = fakeMeta((call) => (call.method === "POST" ? { status: 500, json: { error: { message: "Service unavailable" } } } : undefined))
    await expect(
      run(c, (tx) => saveMessageText(tx, c.orgId, c.whatsappId, c.ownerId, "recordatorio_cita", FORMAL, { fetch: down.fetch, secretsKey: KEY })),
    ).rejects.toMatchObject({ code: "TEMPLATE_REQUEST_FAILED", status: 502 })
  })

  it("sin WhatsApp activo vale el último texto guardado, y el ciclo lo deja vigente", async () => {
    const c = await clinic()
    await whatsappSays(c, "odentia_recordatorio_cita_v2", "aprobada")
    await save(c, "recordatorio_cita", FORMAL)
    expect((await run(c, (tx) => currentAutomationMessage(tx, c.orgId, "recordatorio_cita"))).template).toBe("odentia_recordatorio_cita_v2")
    await run(c, (tx) => setConnectionStatus(tx, c.orgId, c.whatsappId, "disabled"))
    await run(c, (tx) => requestNeededTemplates(tx, c.orgId, KEY, new Date(), { fetch, validateExternal: false }))
    // Lo que sale por correo ya es el texto de la clínica.
    expect((await run(c, (tx) => currentAutomationMessage(tx, c.orgId, "recordatorio_cita"))).body).toContain("Estimada {{1}}")
  })
})

describe("mensajes creados por la clínica", () => {
  const create = (c: Clinic, input: { title: string; body: string; buttonTitle?: string }, deps = OFFLINE) =>
    run(c, (tx) => createClinicMessage(tx, c.orgId, c.whatsappId, c.ownerId, input, deps))

  it("se crea con su título, su texto y su botón, y se pide a WhatsApp en el momento", async () => {
    const c = await clinic()
    const meta = fakeMeta()
    const created = await create(
      c,
      { title: "Tu trabajo ya está listo", body: "Hola, {{persona}}. Tu trabajo ya llegó a {{clinica}}. Escríbenos y coordinamos tu cita.", buttonTitle: "Quiero mi cita" },
      { fetch: meta.fetch, validateExternal: true, secretsKey: KEY },
    )
    expect(created).toMatchObject({
      origin: "clinica",
      title: "Tu trabajo ya está listo",
      when: null,
      line: null,
      pending: null,
      editable: true,
      deletable: true,
      canRevert: false,
      buttons: [{ title: "Quiero mi cita", does: "La persona responde y tu equipo puede escribirle con libertad durante 24 horas." }],
      variables: [
        { key: "persona", label: "Nombre de la persona", example: "Lucía", required: false },
        { key: "clinica", label: "Nombre de la clínica", example: "Clínica Sonríe", required: false },
      ],
    })
    expect(created.current).toMatchObject({ status: "en_revision", isDefault: false })
    const [version] = await versionsOf(c)
    expect(version!.templateName).toMatch(/^clinica_mensaje_[0-9a-f]{10}$/)
    expect(meta.of("POST", "/message_templates")[0]?.body).toMatchObject({
      name: version!.templateName,
      category: "UTILITY",
      components: [
        { type: "BODY", text: "Hola, {{1}}. Tu trabajo ya llegó a {{2}}. Escríbenos y coordinamos tu cita.", example: { body_text: [["Lucía", "Clínica Sonríe"]] } },
        { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Quiero mi cita" }] },
      ],
    })
    expect((await messages(c)).map((item) => item.id)).toHaveLength(20)
    await expect(create(c, { title: "tu trabajo ya está listo", body: "Otro texto." })).rejects.toMatchObject({
      status: 409,
      message: "Ya hay un mensaje con ese nombre.",
      fields: { title: "Ya hay un mensaje con ese nombre." },
    })
    await expect(create(c, { title: "Con datos de cita", body: "Hola. Tu cita: {{citas}}. Chau." })).rejects.toMatchObject({
      fields: { body: expect.stringContaining("«citas» no es un dato de este mensaje") },
    })
    // También se le cambia el texto, con la misma regla: el aprobado sigue hasta que aprueben el nuevo.
    await whatsappSays(c, version!.templateName, "aprobada")
    const edited = await save(c, created.id, "Hola, {{persona}}. Tu trabajo ya está en {{clinica}}. Escríbenos.")
    expect(edited.current.status).toBe("aprobada")
    expect(edited.pending).toMatchObject({ status: "en_revision" })
    await expect(run(c, (tx) => revertMessageText(tx, c.orgId, c.whatsappId, c.ownerId, created.id, OFFLINE))).rejects.toThrow(
      "Solo un mensaje que viene con odentIA tiene un texto al que volver.",
    )
  })

  it("eliminarlo lo quita de la cuenta de WhatsApp y lo archiva; uno de odentIA no se elimina", async () => {
    const c = await clinic()
    const created = await create(c, { title: "Resultados listos", body: "Hola, {{persona}}. Ya tenemos tus resultados en {{clinica}}. Te esperamos." })
    await save(c, created.id, "Hola, {{persona}}. Tus resultados ya están en {{clinica}}. Te esperamos.")
    const names = (await versionsOf(c)).map((version) => version.templateName)
    expect(names).toHaveLength(2)
    // En la cuenta solo sigue la primera: la segunda ya no está y no se pide borrar.
    const meta = fakeMeta((call) =>
      call.method === "GET" && call.url.includes("/message_templates")
        ? { json: { data: [{ id: "1", name: names[0], language: "es", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "x" }] }] } }
        : undefined,
    )
    expect(
      await run(c, (tx) => deleteClinicMessage(tx, c.orgId, c.whatsappId, c.ownerId, created.id, { fetch: meta.fetch, validateExternal: true, secretsKey: KEY })),
    ).toEqual({ ok: true })
    expect(meta.of("DELETE", "/message_templates").map((call) => call.url)).toEqual([
      `https://graph.facebook.com/v25.0/WABA/message_templates?name=${names[0]}`,
    ])
    expect((await messages(c)).map((item) => item.origin)).toEqual([...Array(14).fill("agente"), "bandeja", "plan", "plan", "plan", "plan"])
    const [row] = await ownerDb.select().from(clinicMessage).where(eq(clinicMessage.id, created.id))
    expect(row?.archivedAt).not.toBeNull()
    // La plantilla deja de servir, pero la fila se conserva: los mensajes que la usaron siguen diciendo cuál fue.
    expect((await run(c, (tx) => listChannelTemplates(tx, c.orgId, c.whatsappId))).filter((item) => names.includes(item.name)).map((item) => [item.status, item.reason])).toEqual([
      ["deshabilitada", "Eliminado por la clínica"],
      ["deshabilitada", "Eliminado por la clínica"],
    ])
    await expect(
      run(c, (tx) => deleteClinicMessage(tx, c.orgId, c.whatsappId, c.ownerId, "retomar_conversacion", OFFLINE)),
    ).rejects.toThrow("Los mensajes que vienen con odentIA no se eliminan")
    await expect(run(c, (tx) => deleteClinicMessage(tx, c.orgId, c.whatsappId, c.ownerId, created.id, OFFLINE))).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("si WhatsApp no deja quitarlo, no se archiva y dice el motivo", async () => {
    const c = await clinic()
    const created = await create(c, { title: "Promoción", body: "Este mes hay novedades en {{clinica}}. Escríbenos." })
    const [version] = await versionsOf(c)
    const meta = fakeMeta((call) => {
      if (call.method === "DELETE") return { status: 400, json: { error: { message: "(#200) Permissions error" } } }
      if (call.method === "GET" && call.url.includes("/message_templates")) {
        return { json: { data: [{ id: "1", name: version!.templateName, language: "es", status: "PENDING", category: "UTILITY", components: [] }] } }
      }
      return undefined
    })
    await expect(
      run(c, (tx) => deleteClinicMessage(tx, c.orgId, c.whatsappId, c.ownerId, created.id, { fetch: meta.fetch, validateExternal: true, secretsKey: KEY })),
    ).rejects.toMatchObject({ code: "TEMPLATE_DELETE_FAILED", message: "WhatsApp no eliminó la plantilla: (#200) Permissions error" })
    expect((await messages(c)).some((item) => item.id === created.id)).toBe(true)
  })
})

describe("Bandeja, pasadas las 24 horas", () => {
  const offered = (c: Clinic, conversationId: string, settings = true) =>
    run(c, (tx) => listApprovedMessages(tx, c.orgId, conversationId, (permission) => settings && permission === "settings.read"))
  const send = (c: Clinic, conversationId: string, messageId: string, values?: string[]) =>
    run(c, (tx) => sendApprovedMessage(tx, c.orgId, KEY, { conversationId, senderUserId: c.ownerId, messageId, ...(values ? { values } : {}) }))

  it("el detalle dice antes de escribir si la ventana está abierta", async () => {
    const c = await clinic()
    const open = await thread(c, "Ana Ríos", 2)
    const closed = await thread(c, "Lucía Paredes", 48)
    const never = await thread(c, "Jorge Salas", null)
    expect((await run(c, (tx) => getConversationDetail(tx, c.orgId, open))).whatsappWindow).toMatchObject({ open: true })
    const late = (await run(c, (tx) => getConversationDetail(tx, c.orgId, closed))).whatsappWindow
    expect(late?.open).toBe(false)
    expect(late?.lastInboundAt).not.toBeNull()
    expect((await run(c, (tx) => getConversationDetail(tx, c.orgId, never))).whatsappWindow).toEqual({ open: false, lastInboundAt: null })
  })

  it("mientras «Retomar» no esté aprobado dice por qué, solo ofrece ir a Configuración a quien puede abrirla y a los demás les dice a quién pedírselo", async () => {
    const c = await clinic()
    const id = await thread(c, "Lucía Paredes", 48)
    expect(await offered(c, id)).toEqual({
      data: [],
      none: {
        text: "Aún no se le puede escribir. «Retomar la conversación» está en revisión desde hoy; WhatsApp puede tardar hasta un día.",
        fixHref: "/settings/integrations/whatsapp",
      },
    })
    expect(await offered(c, id, false)).toEqual({
      data: [],
      none: {
        text: "Aún no se le puede escribir. «Retomar la conversación» está en revisión desde hoy; WhatsApp puede tardar hasta un día. Pídeselo a Dueña, que administra la clínica.",
        fixHref: null,
      },
    })
    await whatsappSays(c, "odentia_retomar_conversacion_v1", "rechazada", "SCAM")
    expect((await offered(c, id)).none?.text).toBe("Aún no se le puede escribir: WhatsApp rechazó «Retomar la conversación». Hay que cambiarle el texto.")
    await expect(send(c, id, "retomar_conversacion")).rejects.toMatchObject({ code: "APPROVED_MESSAGE_UNAVAILABLE", status: 409 })
  })

  it("a quien nunca escribió le dice por qué no hay mensaje, sin repetir lo que ya dice la zona de escritura", async () => {
    const c = await clinic()
    const never = await thread(c, "Jorge Salas", null)
    // Que nunca escribió lo dice `whatsappWindow` en el detalle; el motivo no lo repite.
    expect(await offered(c, never)).toEqual({
      data: [],
      none: {
        text: "«Retomar la conversación» solo sirve para continuar una consulta; para escribirle primero hace falta un mensaje aprobado creado por la clínica.",
        fixHref: "/settings/integrations/whatsapp",
      },
    })
  })

  it("ofrece «Retomar», los de la clínica y los de la cuenta con los datos de esa persona; nunca los cinco del agente", async () => {
    const c = await clinic()
    const id = await thread(c, "Lucía Paredes", 48)
    const own = await run(c, (tx) =>
      createClinicMessage(tx, c.orgId, c.whatsappId, c.ownerId, { title: "Tu trabajo ya está listo", body: "Hola, {{persona}}. Tu trabajo ya llegó a {{clinica}}. Escríbenos y coordinamos.", buttonTitle: "Quiero mi cita" }, OFFLINE),
    )
    const [version] = await versionsOf(c)
    await ownerDb.insert(channelTemplate).values([
      { organizationId: c.orgId, connectionId: c.whatsappId, name: "promo_mes", language: "es_PE", status: "aprobada", category: "marketing", body: "Este mes tenemos {{1}} en la clínica.", variables: 1 },
      { organizationId: c.orgId, connectionId: c.whatsappId, name: "en_espera", language: "es", status: "en_revision", body: "Todavía no.", variables: 0 },
    ])
    for (const name of ["odentia_retomar_conversacion_v1", "odentia_recordatorio_cita_v2", version!.templateName]) await whatsappSays(c, name, "aprobada")
    const { data, none } = await offered(c, id)
    expect(none).toBeNull()
    expect(data.map((item) => [item.title, item.buttons, item.fields])).toEqual([
      ["Retomar la conversación", ["Sí, continuemos"], []],
      ["Tu trabajo ya está listo", ["Quiero mi cita"], []],
      ["Promo mes", [], [{ index: 1, label: "Primer dato del mensaje de Meta" }]],
    ])
    expect(data[0]).toMatchObject({ id: "retomar_conversacion" })
    expect(data[0]!.previewParts).toEqual([
      { text: "Hola, ", data: false },
      { text: "Lucía", data: true },
      { text: ". Te escribimos de ", data: false },
      { text: "Clínica Sonríe", data: true },
      { text: " para continuar con tu consulta. ¿Seguimos por aquí?", data: false },
    ])
    expect(data[1]!.id).toBe(own.id)
    expect(data[2]!.previewParts).toEqual([
      { text: "Este mes tenemos ", data: false },
      { text: "dato 1", data: true, index: 1 },
      { text: " en la clínica.", data: false },
    ])
    // Un mensaje del agente pide los datos de una cita: no se envía a mano.
    await expect(send(c, id, "recordatorio_cita")).rejects.toMatchObject({ code: "APPROVED_MESSAGE_UNAVAILABLE" })
    await expect(send(c, id, data[2]!.id)).rejects.toMatchObject({
      message: "Completa el dato del mensaje.",
      fields: { "values[0]": "Completa este dato." },
    })
    // A quien nunca escribió no se le ofrece «Retomar»: no hay consulta que continuar.
    const cold = await thread(c, "Jorge Salas", null)
    expect((await offered(c, cold)).data.map((item) => item.title)).toEqual(["Tu trabajo ya está listo", "Promo mes"])
  })

  it("envía el mensaje con el texto armado, y no deja enviar otro hasta que responda o pase un día", async () => {
    const c = await clinic()
    const id = await thread(c, "Lucía Paredes", 48)
    await whatsappSays(c, "odentia_retomar_conversacion_v1", "aprobada")
    const sent = await send(c, id, "retomar_conversacion")
    expect(sent).toMatchObject({
      direction: "out",
      senderKind: "user",
      contentType: "template",
      status: "queued",
      body: "Hola, Lucía. Te escribimos de Clínica Sonríe para continuar con tu consulta. ¿Seguimos por aquí?",
      templateName: "odentia_retomar_conversacion_v1",
      templateLanguage: "es",
      templateParams: ["Lucía", "Clínica Sonríe"],
    })
    const [row] = await ownerDb.select().from(message).where(eq(message.id, sent.id))
    expect(row?.replyButtons).toHaveLength(1)
    expect(row!.replyButtons![0]!.title).toBe("Sí, continuemos")
    // El botón sigue la conversación: no lo resuelve el sistema.
    expect(parseReplyId(row!.replyButtons![0]!.id)?.action).toBe("responder")

    const waiting = await offered(c, id)
    expect(waiting.data).toEqual([])
    expect(waiting.none?.text).toMatch(/^Ya se le envió un mensaje aprobado hoy a las .+\. Cuando responda podrás escribirle con libertad; si no responde, podrás enviarle otro mañana a las .+\.$/)
    expect(waiting.none?.fixHref).toBeNull()
    await expect(send(c, id, "retomar_conversacion")).rejects.toMatchObject({ code: "APPROVED_MESSAGE_UNAVAILABLE", status: 409 })
    expect(await ownerDb.select({ id: message.id }).from(message).where(eq(message.conversationId, id))).toHaveLength(1)

    // Pasó un día sin respuesta: se puede enviar otro.
    await ownerDb.update(message).set({ createdAt: new Date(Date.now() - 25 * HOUR) }).where(eq(message.id, sent.id))
    expect((await offered(c, id)).data.map((item) => item.id)).toEqual(["retomar_conversacion"])
  })

  it("una plantilla de la cuenta que pide un dato se envía con lo que escribe quien la envía", async () => {
    const c = await clinic()
    const id = await thread(c, "Lucía Paredes", 48)
    const [template] = await ownerDb
      .insert(channelTemplate)
      .values({ organizationId: c.orgId, connectionId: c.whatsappId, name: "promo_mes", language: "es_PE", status: "aprobada", category: "marketing", body: "Este mes tenemos {{1}} en la clínica.", variables: 1 })
      .returning({ id: channelTemplate.id })
    const sent = await send(c, id, template!.id, ["  limpieza\ncon descuento "])
    expect(sent).toMatchObject({
      body: "Este mes tenemos limpieza con descuento en la clínica.",
      templateName: "promo_mes",
      templateLanguage: "es_PE",
      templateParams: ["limpieza con descuento"],
    })
  })
})

describe("la conexión de WhatsApp", () => {
  const connect = (orgId: string, meta: ReturnType<typeof fakeMeta>, input: { displayName?: string; config?: Record<string, unknown> } = {}) =>
    withOrgContext(appDb, orgId, (tx) =>
      createConnection(
        tx, orgId, KEY,
        { channel: "whatsapp", provider: "whatsapp_cloud_api", ...(input.displayName ? { displayName: input.displayName } : {}), config: input.config ?? WA_CONFIG },
        { fetch: meta.fetch, webhookBaseUrl: "https://api.clinica.test" },
      ),
    )

  it("al conectar dice lo que encontró, guarda la salud del número y pide los diecinueve mensajes de una vez", async () => {
    const { orgId } = await organization()
    const meta = fakeMeta((call) => (call.url.includes("fields=display_phone_number") ? { json: { id: `PNID-${orgId}`, display_phone_number: "+51 999 888 777", verified_name: "Clínica Sonríe" } } : undefined))
    const created = await connect(orgId, meta)
    // Sin nombre escrito, el verificado que da Meta.
    expect(created).toMatchObject({
      displayName: "Clínica Sonríe",
      externalId: `PNID-${orgId}`,
      status: "active",
      account: { name: "Clínica Sonríe", number: "+51 999 888 777" },
      templates: { canManage: true, requested: 19, error: null },
      health: { quality: "alta", dailyLimit: 2000, unlimited: false, number: "+51 999 888 777", name: "Clínica Sonríe" },
    })
    expect(created.webhookSecret).toBeTruthy()
    expect(created).not.toHaveProperty("templatesError")
    expect(meta.of("POST", "/message_templates").map((call) => (call.body as { name: string }).name)).toEqual([
      "odentia_recordatorio_cita_v2",
      "odentia_recordatorio_cita_datos_v1",
      "odentia_recordatorio_cita_confirmada_v1",
      "odentia_cita_sin_llegar_v1",
      "odentia_aviso_cita_reservada_v2",
      "odentia_aviso_cita_datos_v2",
      "odentia_aviso_cita_movida_v2",
      "odentia_aviso_cita_cancelada_v2",
      "odentia_recordatorio_control_v1",
      "odentia_seguimiento_presupuesto_v1",
      "odentia_seguimiento_oportunidad_v1",
      "odentia_seguimiento_inasistencia_v1",
      "odentia_cita_cancelada_v1",
      "odentia_invitar_a_volver_v1",
      "odentia_retomar_conversacion_v1",
      "odentia_presupuesto_listo_v2",
      "odentia_su_enlace_v1",
      "odentia_ver_respuesta_v1",
      "odentia_enlace_recibido_v1",
    ])
    const c: Clinic = { orgId, ownerId: `owner-${orgId}`, whatsappId: created.id }
    await whatsappSays(c, "odentia_recordatorio_cita_v2", "aprobada")
    await whatsappSays(c, "odentia_cita_cancelada_v1", "rechazada", "INVALID_FORMAT")
    await thread(c, "Lucía Paredes", 3)
    const [overview] = await run(c, (tx) => listConnectionsOverview(tx, orgId))
    expect(overview).toMatchObject({
      id: created.id,
      webhookVerifiedAt: null,
      health: { quality: "alta", dailyLimit: 2000 },
      messages: { aprobados: 1, enRevision: 17, rechazados: 1, pausados: 0, retirados: 0, sinPedir: 0 },
    })
    expect(Date.now() - new Date(overview!.lastInboundAt!).getTime()).toBeLessThan(4 * HOUR)
    expect(JSON.stringify(overview)).not.toContain("clave-1")

    // La misma cuenta no se conecta dos veces: dice en cuál está.
    await expect(connect(orgId, meta, { displayName: "Otra" })).rejects.toMatchObject({
      code: "CONNECTION_EXISTS",
      status: 409,
      message: "Esa cuenta ya está conectada como «Clínica Sonríe». Ábrela y cámbiale la clave en vez de crear otra conexión.",
    })
    const other = await organization()
    await expect(connect(other.orgId, meta)).rejects.toMatchObject({ code: "CONNECTION_EXISTS", message: "Esa cuenta ya está conectada en otra clínica de odentIA." })
  })

  it("si Meta no entrega la salud, queda sin dato; y una clave que no sirve se dice con su arreglo", async () => {
    const { orgId } = await organization()
    const meta = fakeMeta((call) => {
      if (call.url.includes("fields=display_phone_number")) return { json: { id: `PNID-${orgId}`, display_phone_number: "+51 911 222 333" } }
      if (call.url.includes("fields=quality_rating")) return { status: 400, json: { error: { message: "(#100) Tried accessing nonexisting field" } } }
      return undefined
    })
    const created = await connect(orgId, meta, { displayName: "Recepción" })
    expect(created.displayName).toBe("Recepción")
    expect(created.account).toEqual({ name: null, number: "+51 911 222 333" })
    expect(created.health).toMatchObject({ quality: null, dailyLimit: null, unlimited: false, number: "+51 911 222 333", name: null })

    const bad = fakeMeta((call) => (call.url.includes("fields=display_phone_number") ? { status: 401, json: { error: { message: "Invalid OAuth access token" } } } : undefined))
    const another = await organization()
    await expect(connect(another.orgId, bad)).rejects.toMatchObject({
      code: "CONNECTION_REJECTED",
      status: 400,
      message: "WhatsApp no aceptó esos datos: la clave no sirve o venció, o el identificador del número no es de esa cuenta. Copia la clave de nuevo; debe ser la permanente, no la temporal de 24 horas.",
    })
    await expect(connect(another.orgId, bad, { config: { ...WA_CONFIG, accessToken: "" } })).rejects.toMatchObject({
      message: "Falta la clave de acceso.",
      fields: { "config.accessToken": "Falta la clave de acceso." },
    })
    // Cuando Meta dice cuál dato rechazó (190: la clave; 100: el identificador), el error va a ese dato.
    const expired = fakeMeta((call) =>
      call.url.includes("fields=display_phone_number") ? { status: 401, json: { error: { message: "Error validating access token", code: 190 } } } : undefined,
    )
    await expect(connect(another.orgId, expired)).rejects.toMatchObject({
      code: "CONNECTION_REJECTED",
      fields: { "config.accessToken": expect.stringContaining("WhatsApp no aceptó esta clave") },
    })
    const unknownNumber = fakeMeta((call) =>
      call.url.includes("fields=display_phone_number") ? { status: 400, json: { error: { message: "Unsupported get request", code: 100 } } } : undefined,
    )
    await expect(connect(another.orgId, unknownNumber)).rejects.toMatchObject({
      code: "CONNECTION_REJECTED",
      fields: { "config.phoneNumberId": expect.stringContaining("WhatsApp no encuentra este número") },
    })
    expect(await ownerDb.select().from(channelConnection).where(eq(channelConnection.organizationId, another.orgId))).toEqual([])
  })

  it("si la clave no puede pedir mensajes, la conexión sigue y dice qué corregir", async () => {
    const { orgId } = await organization()
    const meta = fakeMeta((call) => {
      if (call.url.includes("fields=display_phone_number")) return { json: { id: `PNID-${orgId}`, display_phone_number: "+51 922 333 444", verified_name: "Clínica Sonríe" } }
      if (call.method === "POST") return { status: 403, json: { error: { message: "(#200) Permissions error" } } }
      return undefined
    })
    const created = await connect(orgId, meta)
    expect(created.status).toBe("active")
    expect(created.templates).toEqual({
      canManage: false,
      requested: 0,
      error: "WhatsApp no aceptó la solicitud de 19 mensajes: WhatsApp no aceptó la solicitud de plantilla: (#200) Permissions error. Dale a la clave el permiso para administrar mensajes (whatsapp_business_management) y vuelve a comprobar.",
    })
    expect(created.templatesError).toBe(created.templates?.error)
    const c: Clinic = { orgId, ownerId: `owner-${orgId}`, whatsappId: created.id }
    expect((await messages(c)).map((item) => item.current.status)).toEqual(Array(19).fill("sin_pedir"))
    expect((await run(c, (tx) => listConnectionsOverview(tx, orgId)))[0]?.messages).toMatchObject({ sinPedir: 19, enRevision: 0 })

    // Con la clave corregida se piden los que faltaban, sin crear otra conexión.
    const fixed = fakeMeta((call) => (call.url.includes("fields=display_phone_number") ? { json: { id: `PNID-${orgId}`, display_phone_number: "+51 922 333 444", verified_name: "Clínica Sonríe" } } : undefined))
    const before = (await ownerDb.select().from(channelConnection).where(eq(channelConnection.id, created.id)))[0]!
    const changed = await run(c, (tx) =>
      changeConnectionCredentials(tx, orgId, created.id, KEY, { config: { accessToken: "clave-2" } }, { fetch: fixed.fetch, webhookBaseUrl: "https://api.clinica.test" }),
    )
    expect(changed).toMatchObject({ id: created.id, account: { name: "Clínica Sonríe" }, templates: { canManage: true, requested: 19, error: null } })
    const after = (await ownerDb.select().from(channelConnection).where(eq(channelConnection.id, created.id)))[0]!
    // Solo cambia la clave: la conexión, su dirección y su clave de verificación siguen siendo las mismas.
    expect(decryptConfig(KEY, after.configEncrypted)).toEqual({ ...WA_CONFIG, accessToken: "clave-2" })
    expect(after).toMatchObject({ id: before.id, webhookSecret: before.webhookSecret, externalId: before.externalId, displayName: before.displayName, status: "active" })
    expect((await messages(c)).map((item) => item.current.status)).toEqual(Array(19).fill("en_revision"))

    // La clave de otra cuenta no entra aquí.
    const foreign = fakeMeta((call) => (call.url.includes("fields=display_phone_number") ? { json: { id: "PNID-otra", display_phone_number: "+51 900 000 000" } } : undefined))
    await expect(
      run(c, (tx) => changeConnectionCredentials(tx, orgId, created.id, KEY, { config: { accessToken: "clave-3" } }, { fetch: foreign.fetch })),
    ).rejects.toThrow("Esa clave es de otra cuenta.")
    expect(decryptConfig(KEY, (await ownerDb.select().from(channelConnection).where(eq(channelConnection.id, created.id)))[0]!.configEncrypted)["accessToken"]).toBe("clave-2")
  })

  it("probar dice qué encontró y no le cambia el nombre ni el estado", async () => {
    const { orgId } = await organization()
    const meta = fakeMeta((call) => (call.url.includes("fields=display_phone_number") ? { json: { id: `PNID-${orgId}`, display_phone_number: "+51 933 444 555", verified_name: "Nombre en Meta" } } : undefined))
    const created = await connect(orgId, meta, { displayName: "WhatsApp de recepción" })
    const c: Clinic = { orgId, ownerId: `owner-${orgId}`, whatsappId: created.id }
    await run(c, (tx) => setConnectionStatus(tx, orgId, created.id, "disabled"))
    const yellow = fakeMeta((call) => {
      if (call.url.includes("fields=display_phone_number")) return { json: { id: `PNID-${orgId}`, display_phone_number: "+51 933 444 555", verified_name: "Nombre en Meta" } }
      if (call.url.includes("fields=quality_rating")) return { json: { quality_rating: "YELLOW", whatsapp_business_manager_messaging_limit: "TIER_250" } }
      return undefined
    })
    const tested = await run(c, (tx) => testConnection(tx, orgId, created.id, KEY, { fetch: yellow.fetch }))
    expect(tested).toMatchObject({ ok: true, account: { name: "Nombre en Meta", number: "+51 933 444 555" }, problem: null })
    expect(Number.isNaN(Date.parse(tested.checkedAt))).toBe(false)
    const [row] = await ownerDb.select().from(channelConnection).where(eq(channelConnection.id, created.id))
    expect(row).toMatchObject({ displayName: "WhatsApp de recepción", status: "disabled", health: { quality: "media", dailyLimit: 250 } })

    const expired = fakeMeta((call) => (call.url.includes("fields=display_phone_number") ? { status: 401, json: { error: { message: "Session has expired" } } } : undefined))
    expect(await run(c, (tx) => testConnection(tx, orgId, created.id, KEY, { fetch: expired.fetch }))).toMatchObject({
      ok: false,
      account: null,
      problem: expect.stringContaining("la clave no sirve o venció"),
    })
    // Sin proveedor no se afirma que funcione.
    expect(await run(c, (tx) => testConnection(tx, orgId, created.id, KEY, { fetch, validateExternal: false }))).toMatchObject({ ok: false, account: null })
  })

  it("el alta a mano muestra siempre la dirección y la clave, y detecta sola la verificación y el primer mensaje", async () => {
    const c = await clinic()
    const setup = () => run(c, (tx) => getConnectionSetup(tx, c.orgId, c.whatsappId, "https://api.clinica.test/"))
    const [row] = await ownerDb.select().from(channelConnection).where(eq(channelConnection.id, c.whatsappId))
    expect(await setup()).toEqual({
      webhookUrl: `https://api.clinica.test/api/webhooks/channels/whatsapp_cloud_api/${c.whatsappId}`,
      verifyToken: row!.webhookSecret,
      webhookVerifiedAt: null,
      lastInboundAt: null,
    })
    await run(c, (tx) => markWebhookVerified(tx, c.orgId, c.whatsappId))
    await thread(c, "Lucía Paredes", 0)
    const ready = await setup()
    expect(ready.webhookVerifiedAt).not.toBeNull()
    expect(ready.lastInboundAt).not.toBeNull()
  })

  it("«Actualizar» relee la cuenta, deja vigente lo aprobado y refresca la salud", async () => {
    const { orgId, ownerId } = await organization()
    const meta = fakeMeta((call) => (call.url.includes("fields=display_phone_number") ? { json: { id: `PNID-${orgId}`, display_phone_number: "+51 944 555 666", verified_name: "Clínica Sonríe" } } : undefined))
    const created = await connect(orgId, meta)
    const c: Clinic = { orgId, ownerId, whatsappId: created.id }
    await whatsappSays(c, "odentia_recordatorio_cita_v2", "aprobada")
    await run(c, (tx) => saveMessageText(tx, orgId, created.id, ownerId, "recordatorio_cita", FORMAL, { fetch: meta.fetch, secretsKey: KEY }))
    const [version] = await versionsOf(c)
    // El aviso de WhatsApp no llegó: la aprobación se ve al leer la cuenta.
    const account = fakeMeta((call) => {
      if (call.method === "GET" && call.url.includes("/message_templates")) {
        return {
          json: {
            data: [
              { id: "1", name: "odentia_recordatorio_cita_v2", language: "es", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "x {{1}} {{2}} {{3}}" }] },
              { id: "2", name: version!.templateName, language: "es", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "y {{1}} {{2}} {{3}}" }] },
              { id: "3", name: "bienvenida_clinica", language: "es", status: "APPROVED", category: "UTILITY", components: [{ type: "BODY", text: "Gracias por escribir." }] },
            ],
          },
        }
      }
      if (call.url.includes("fields=quality_rating")) return { json: { quality_rating: "RED", whatsapp_business_manager_messaging_limit: "TIER_UNLIMITED" } }
      return undefined
    })
    await run(c, (tx) => syncConnectionAccount(tx, orgId, created.id, KEY, { fetch: account.fetch }))
    const items = await messages(c)
    expect(items[0]!.current).toMatchObject({ body: FORMAL, status: "aprobada" })
    expect(items[0]!.pending).toBeNull()
    expect(items.at(-1)).toMatchObject({ origin: "cuenta", title: "bienvenida_clinica", editable: false, deletable: false, canRevert: false, variables: [] })
    expect((await ownerDb.select().from(channelConnection).where(eq(channelConnection.id, created.id)))[0]?.health).toMatchObject({
      quality: "baja",
      dailyLimit: null,
      unlimited: true,
      number: "+51 944 555 666",
    })
  })
})

describe("lo que faltó pedir", () => {
  it("el ciclo lo pide aunque el Administrador esté apagado: «Retomar» es de la Bandeja", async () => {
    const c = await clinic()
    await ownerDb.update(agentConfig).set({ advisor: { enabled: false } }).where(eq(agentConfig.organizationId, c.orgId))
    await ownerDb
      .delete(channelTemplate)
      .where(and(eq(channelTemplate.connectionId, c.whatsappId), eq(channelTemplate.name, "odentia_retomar_conversacion_v1")))
    expect((await messageOf(c, "retomar_conversacion")).current.status).toBe("sin_pedir")
    const meta = fakeMeta()
    await tickAutomations(ownerDb, appDb, new Date(), {
      secretsKey: KEY,
      publicBaseUrl: "https://clinica.test",
      templates: { fetch: meta.fetch },
    })
    const asked = meta.of("POST", "/message_templates").filter((call) => (call.body as { name: string }).name === "odentia_retomar_conversacion_v1")
    expect(asked).toHaveLength(1)
    expect((await messageOf(c, "retomar_conversacion")).current.status).toBe("en_revision")
  })
})

describe("Telegram recibe mensajes desde que se conecta", () => {
  it("una conexión real registra su dirección al crearse y al reactivarse", async () => {
    const { orgId } = await organization()
    const meta = fakeMeta()
    const created = await withOrgContext(appDb, orgId, (tx) =>
      createConnection(tx, orgId, KEY, { channel: "telegram", provider: "telegram_bot_api", config: { botToken: `tok-${orgId}` } }, { fetch: meta.fetch, webhookBaseUrl: "https://api.clinica.test" }),
    )
    // No hay nada que copiar: toma el nombre del bot y le dice a Telegram adónde avisar.
    expect(created).toMatchObject({ displayName: "@clinicabot", account: { name: "Clínica", number: "@clinicabot" }, templates: null })
    const registered = meta.of("POST", "/setWebhook")
    expect(registered).toHaveLength(1)
    expect(registered[0]).toMatchObject({
      url: `https://api.telegram.org/bottok-${orgId}/setWebhook`,
      body: { url: `https://api.clinica.test/api/webhooks/channels/telegram_bot_api/${created.id}`, secret_token: created.webhookSecret },
    })
    await withOrgContext(appDb, orgId, (tx) => setConnectionStatus(tx, orgId, created.id, "disabled"))
    await withOrgContext(appDb, orgId, (tx) =>
      setConnectionStatus(tx, orgId, created.id, "active", { secretsKey: KEY, deps: { fetch: meta.fetch, webhookBaseUrl: "https://api.clinica.test" } }),
    )
    expect(meta.of("POST", "/setWebhook")).toHaveLength(2)
    await expect(withOrgContext(appDb, orgId, (tx) => getConnectionSetup(tx, orgId, created.id, "https://api.clinica.test"))).rejects.toThrow(
      "Este canal no necesita copiar una dirección",
    )
  })

  it("si Telegram no acepta la dirección, la conexión no se crea", async () => {
    const { orgId } = await organization()
    const meta = fakeMeta((call) => {
      if (call.url.endsWith("/getMe")) return { json: { ok: true, result: { id: 78, username: "otrobot", first_name: "Otro" } } }
      if (call.url.endsWith("/setWebhook")) return { status: 400, json: { ok: false, description: "Bad Request: bad webhook" } }
      return undefined
    })
    await expect(
      withOrgContext(appDb, orgId, (tx) =>
        createConnection(tx, orgId, KEY, { channel: "telegram", provider: "telegram_bot_api", config: { botToken: "tok" } }, { fetch: meta.fetch, webhookBaseUrl: "https://api.clinica.test" }),
      ),
    ).rejects.toMatchObject({ code: "TELEGRAM_WEBHOOK_REJECTED", message: expect.stringContaining("Bad Request: bad webhook") })
    expect(await ownerDb.select().from(channelConnection).where(and(eq(channelConnection.organizationId, orgId)))).toEqual([])
  })
})

describe("un solo WhatsApp por clínica", () => {
  const second = { channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "Otro", config: { ...WA_CONFIG, phoneNumberId: "PNID-2" } }

  it("con uno conectado no deja conectar otro, y dice cuál es y qué hacer", async () => {
    const c = await clinic()
    await expect(run(c, (tx) => createConnection(tx, c.orgId, KEY, second, { fetch, validateExternal: false }))).rejects.toMatchObject({
      code: "WHATSAPP_ALREADY_CONNECTED",
      status: 409,
      message: expect.stringContaining("desconecta primero"),
    })
    const rows = await ownerDb.select().from(channelConnection).where(eq(channelConnection.organizationId, c.orgId))
    expect(rows).toHaveLength(1)
  })

  it("desconectado el primero se conecta otro número; el anterior no se reactiva mientras tanto", async () => {
    const c = await clinic()
    await run(c, (tx) => setConnectionStatus(tx, c.orgId, c.whatsappId, "disabled"))
    const other = await run(c, (tx) => createConnection(tx, c.orgId, KEY, second, { fetch, validateExternal: false }))
    expect(other.status).toBe("active")
    await expect(run(c, (tx) => setConnectionStatus(tx, c.orgId, c.whatsappId, "active"))).rejects.toMatchObject({
      code: "WHATSAPP_ALREADY_CONNECTED",
    })
    // Con el nuevo desconectado, el anterior vuelve con sus conversaciones.
    await run(c, (tx) => setConnectionStatus(tx, c.orgId, other.id, "disabled"))
    const back = await run(c, (tx) => setConnectionStatus(tx, c.orgId, c.whatsappId, "active"))
    expect(back.status).toBe("active")
  })

  it("reactivar el único WhatsApp y conectar otros canales no choca con la regla", async () => {
    const c = await clinic()
    const again = await run(c, (tx) => setConnectionStatus(tx, c.orgId, c.whatsappId, "active"))
    expect(again.status).toBe("active")
    const telegram = await run(c, (tx) =>
      createConnection(tx, c.orgId, KEY, { channel: "telegram", provider: "telegram_bot_api", config: { botToken: `tok-${c.orgId}` } }, { fetch, validateExternal: false }),
    )
    expect(telegram.channel).toBe("telegram")
  })
})

describe("«Invitar a volver» por producto (issue 229)", () => {
  it("latidIA invita al año con su propia plantilla; odentIA sigue con la de seis meses", async () => {
    const dental = `vuelve-d-${randomUUID().slice(0, 8)}`
    const medical = `vuelve-m-${randomUUID().slice(0, 8)}`
    await insertOrg(ownerDb, dental, dental)
    await insertOrg(ownerDb, medical, medical)
    await ownerDb.update(orgProfile).set({ product: "medical" }).where(eq(orgProfile.organizationId, medical))
    const message = (orgId: string) => withOrgContext(appDb, orgId, (tx) => currentAutomationMessage(tx, orgId, "invitar_a_volver"))
    expect(await message(dental)).toMatchObject({
      template: "odentia_invitar_a_volver_v1",
      body: expect.stringContaining("más de seis meses"),
    })
    expect(await message(medical)).toMatchObject({
      template: "latidia_invitar_a_volver_v1",
      body: expect.stringContaining("más de un año"),
    })
  })
})
