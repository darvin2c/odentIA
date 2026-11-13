import {
  kairosItem,
  saasClient,
  saasClientContact,
  saasInboundEmail,
} from "@odentia/db/schema/admin-arm"
import { adminStaff } from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import { saasFollowUp } from "@odentia/db/schema/saas-billing"
import { eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { clientTimeline } from "./admin-clients.js"
import { type AdminActor, setAdminStaffActive } from "./admin-core.js"
import {
  assignInboundEmail,
  getInboundEmail,
  type InboundEmailInput,
  inboundPersonOf,
  ingestInboundEmail,
} from "./admin-inbound-email.js"
import { kairosDone } from "./admin-kairos.js"
import {
  markOutreachSent,
  outreachEmail,
  prepareEmailReply,
  prepareOutreach,
  quotedEmail,
  replyReferences,
  replySubject,
  resolveOutreach,
} from "./admin-sales.js"
import { setStaffMail, staffMailLocalProblem, staffShortName } from "./admin-staff-mail.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

/**
 * El correo de la administración: a quién le llega cada correo (los buzones y la dirección de
 * cada persona del equipo), cómo se liga por el hilo, quién firma lo que sale y la respuesta.
 */
setupTestDb()
const admin: AdminActor = { userId: "co-admin", role: "admin" }
const other: AdminActor = { userId: "co-otra", role: "admin" }
const support: AdminActor = { userId: "co-support", role: "support" }
const gone: AdminActor = { userId: "co-gone", role: "admin" }
const plain: AdminActor = { userId: "co-plain", role: "admin" }
let clientId: string
let latidiaClient: string

function mail(overrides: Partial<InboundEmailInput> = {}): InboundEmailInput {
  return {
    mailbox: "hola",
    product: "dental",
    messageId: `<${crypto.randomUUID()}@gmail.com>`,
    from: "dra.rosa@gmail.com",
    fromName: "Rosa Mamani",
    to: "hola@odentia32.com",
    subject: "Quiero saber más",
    text: "Hola,\n¿cuánto cuesta?",
    receivedAt: new Date(),
    attachments: [],
    senderVerified: true,
    ...overrides,
  }
}

async function mailLocalOf(userId: string) {
  const [row] = await ownerDb
    .select({ mailLocal: adminStaff.mailLocal, firstSentAt: adminStaff.mailFirstSentAt })
    .from(adminStaff)
    .where(eq(adminStaff.userId, userId))
  return row
}

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: admin.userId, name: "Ada María Lovelace Byron", email: "ada@gmail.com" },
    { id: other.userId, name: "Beto Paz", email: "beto.paz@odentia32.com" },
    { id: support.userId, name: "Sofía Soporte", email: "sofia@gmail.com" },
    { id: gone.userId, name: "Gonzalo Ido", email: "gonzalo@gmail.com" },
    { id: plain.userId, name: "Sin Dirección", email: "sin@gmail.com" },
  ])
  // La base pone la dirección al crear la fila (aceptar la invitación, la semilla…).
  await ownerDb.insert(adminStaff).values([
    { userId: admin.userId, role: "admin" },
    { userId: other.userId, role: "admin", mailCopyTo: "beto@gmail.com" },
    { userId: support.userId, role: "support" },
    { userId: gone.userId, role: "admin", active: false },
    { userId: plain.userId, role: "admin" },
  ])
  // Una persona sin dirección escribe desde hola@.
  await ownerDb
    .update(adminStaff)
    .set({ mailLocal: null })
    .where(eq(adminStaff.userId, plain.userId))
  const [client] = await ownerDb
    .insert(saasClient)
    .values({ name: "Clínica del Hilo (ficticia)", product: "dental" })
    .returning({ id: saasClient.id })
  const [medical] = await ownerDb
    .insert(saasClient)
    .values({ name: "Consultorio Latido (ficticio)", product: "medical" })
    .returning({ id: saasClient.id })
  if (!client || !medical) throw new Error("sin cliente")
  clientId = client.id
  latidiaClient = medical.id
  await ownerDb.insert(saasClientContact).values([
    { clientId, name: "Rosa Mamani", email: "rosa@hilo.test", isPrimary: true },
    { clientId: latidiaClient, name: "Lía", email: "lia@latido.test", isPrimary: true },
  ])
})

describe("la dirección de cada persona", () => {
  it("se asigna sola: la parte local nuestra, o primer nombre y primer apellido", async () => {
    expect((await mailLocalOf(admin.userId))?.mailLocal).toBe("ada.lovelace")
    expect((await mailLocalOf(other.userId))?.mailLocal).toBe("beto.paz")
    expect(staffShortName("Ada María Lovelace Byron")).toBe("Ada Lovelace")
    expect(staffShortName("Juan de la Cruz")).toBe("Juan Cruz")
    expect(staffShortName("Darvin Cotrina Ruiz")).toBe("Darvin Cotrina")
  })

  it("solo Administración la corrige; reservados, signos y duplicados no", async () => {
    expect(staffMailLocalProblem("hola")).toMatch(/buzón/)
    expect(staffMailLocalProblem("Ana Paz")).not.toBeNull()
    await expect(
      setStaffMail(ownerDb, support, admin.userId, { mailLocal: "ada" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      setStaffMail(ownerDb, admin, other.userId, { mailLocal: "soporte" }),
    ).rejects.toMatchObject({ code: "VALIDATION", fields: { mailLocal: expect.any(String) } })
    await expect(
      setStaffMail(ownerDb, admin, other.userId, { mailLocal: "ada.lovelace" }),
    ).rejects.toMatchObject({
      code: "MAIL_LOCAL_TAKEN",
      status: 409,
      // Lo mismo junto al campo y en el mensaje: el formulario no lo dice dos veces.
      message: "ada.lovelace@ ya es de otra persona del equipo",
      fields: { mailLocal: "ada.lovelace@ ya es de otra persona del equipo" },
    })
    await expect(
      setStaffMail(ownerDb, admin, other.userId, { copyTo: "no-es-correo" }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    expect(
      await setStaffMail(ownerDb, admin, other.userId, {
        mailLocal: " Beto ",
        copyTo: "Beto@Gmail.com",
      }),
    ).toMatchObject({ mailLocal: "beto", copyTo: "beto@gmail.com", firstSentAt: null })
  })
})

describe("quién firma lo que sale", () => {
  it("«Escribir» sale con el nombre y la dirección de quien escribe, su Message-ID y la respuesta a él", async () => {
    const row = await ownerDb.transaction((tx) =>
      prepareOutreach(tx, admin, latidiaClient, {
        channel: "correo",
        contactId: null,
        to: "lia@latido.test",
        subject: "Su prueba",
        body: "Hola, Lía.",
      }),
    )
    expect(row.from).toBe("ada.lovelace@latidia72.com")
    const email = await ownerDb.transaction((tx) => outreachEmail(tx, row.id))
    expect(email.from).toEqual({
      name: "Ada Lovelace · latidIA",
      address: "ada.lovelace@latidia72.com",
    })
    expect(email.replyTo).toBe("ada.lovelace@latidia72.com")
    expect(email.messageId).toMatch(/^<[0-9a-f-]{36}@latidia72\.com>$/)
    expect(email.headers).toEqual({})
    // Ya salió algo con su dirección: queda fija.
    expect((await mailLocalOf(admin.userId))?.firstSentAt).toBeInstanceOf(Date)
    await expect(
      setStaffMail(ownerDb, admin, admin.userId, { mailLocal: "ada" }),
    ).rejects.toMatchObject({ code: "MAIL_LOCAL_FIXED", status: 409 })
    // La copia sí cambia.
    await setStaffMail(ownerDb, admin, admin.userId, { copyTo: "ada@gmail.com" })
  })

  it("sin dirección, desde hola@ de la marca; quien ya no está activo no escribe", async () => {
    const row = await ownerDb.transaction((tx) =>
      prepareOutreach(tx, plain, clientId, {
        channel: "correo",
        to: "rosa@hilo.test",
        subject: "Hola",
        body: "Hola, Rosa.",
      }),
    )
    const email = await ownerDb.transaction((tx) => outreachEmail(tx, row.id))
    expect(email.from).toEqual({ name: "odentIA", address: "hola@odentia32.com" })
    expect(email.replyTo).toBe("hola@odentia32.com")
    await expect(
      ownerDb.transaction((tx) =>
        prepareOutreach(tx, gone, clientId, {
          channel: "correo",
          to: "rosa@hilo.test",
          subject: "Hola",
          body: "Hola.",
        }),
      ),
    ).rejects.toMatchObject({ code: "STAFF_INACTIVE", status: 403 })
  })
})

describe("a quién le llega un correo", () => {
  it("la dirección de una persona: entra con su copia; la de nadie, 404", async () => {
    const result = await ingestInboundEmail(
      ownerDb,
      mail({ mailbox: "persona", localPart: "Beto", to: "beto@odentia32.com" }),
    )
    expect(result).toMatchObject({ duplicate: false, copyTo: "beto@gmail.com" })
    const [row] = await ownerDb
      .select()
      .from(saasInboundEmail)
      .where(eq(saasInboundEmail.id, result.id))
    expect(row).toMatchObject({ mailbox: "persona", staffUserId: other.userId })
    await expect(
      ingestInboundEmail(ownerDb, mail({ mailbox: "persona", localPart: "nadie" })),
    ).rejects.toMatchObject({ code: "MAILBOX_UNKNOWN", status: 404 })
    await expect(ingestInboundEmail(ownerDb, mail({ mailbox: "persona" }))).rejects.toMatchObject({
      code: "VALIDATION",
    })
    // Los buzones fijos no tienen copia: la hace el worker con FORWARD_TO.
    expect(await ingestInboundEmail(ownerDb, mail({ mailbox: "fundadores" }))).toMatchObject({
      copyTo: null,
    })
  })

  it("una persona que ya no está: solo entra la respuesta a un correo que salió con su dirección", async () => {
    await ownerDb
      .update(adminStaff)
      .set({ mailLocal: "gonzalo" })
      .where(eq(adminStaff.userId, gone.userId))
    await expect(
      ingestInboundEmail(ownerDb, mail({ mailbox: "persona", localPart: "gonzalo" })),
    ).rejects.toMatchObject({ code: "MAILBOX_UNKNOWN" })
    // Uno que escribió antes de irse.
    await ownerDb.update(adminStaff).set({ active: true }).where(eq(adminStaff.userId, gone.userId))
    const sent = await ownerDb.transaction((tx) =>
      prepareOutreach(tx, gone, clientId, {
        channel: "correo",
        to: "rosa@hilo.test",
        subject: "Antes de irme",
        body: "Hola.",
      }),
    )
    await ownerDb
      .update(adminStaff)
      .set({ active: false })
      .where(eq(adminStaff.userId, gone.userId))
    const email = await ownerDb.transaction((tx) => outreachEmail(tx, sent.id))
    const answer = await ingestInboundEmail(
      ownerDb,
      mail({
        mailbox: "persona",
        localPart: "gonzalo",
        from: "rosa@hilo.test",
        inReplyTo: email.messageId,
      }),
    )
    expect(answer).toMatchObject({ duplicate: false, clientId, matchedBy: "hilo" })
  })

  it("la respuesta a un envío nuestro se liga por el hilo si viene del mismo correo y verificado", async () => {
    const sent = await ownerDb.transaction((tx) =>
      prepareOutreach(tx, admin, clientId, {
        channel: "correo",
        to: "otra.direccion@gmail.com",
        subject: "Le escribo",
        body: "Hola.",
      }),
    )
    const { messageId } = await ownerDb.transaction((tx) => outreachEmail(tx, sent.id))
    const references = `<antes@gmail.com> ${messageId}`
    expect(
      await ingestInboundEmail(
        ownerDb,
        mail({ from: "otra.direccion@gmail.com", references, mailbox: "contacto" }),
      ),
    ).toMatchObject({ clientId, matchedBy: "hilo" })
    // Otro remitente, o sin verificar: no.
    expect(
      await ingestInboundEmail(ownerDb, mail({ from: "intruso@gmail.com", references })),
    ).toMatchObject({ clientId: null })
    expect(
      await ingestInboundEmail(
        ownerDb,
        mail({ from: "otra.direccion@gmail.com", references, senderVerified: false }),
      ),
    ).toMatchObject({ clientId: null })
  })
})

describe("responder un correo", () => {
  it("Re: sin repetir, el hilo y la cita", () => {
    expect(replySubject("Precios")).toBe("Re: Precios")
    expect(replySubject("RE:  Precios")).toBe("RE: Precios")
    expect(replySubject(null)).toBe("Re: su correo")
    expect(
      replyReferences({ references: "<a@x> <b@x>", inReplyTo: null, messageId: "<c@x>" }),
    ).toBe("<a@x> <b@x> <c@x>")
    expect(replyReferences({ references: "<c@x>", inReplyTo: null, messageId: "<c@x>" })).toBe(
      "<c@x>",
    )
    const quote = quotedEmail({
      fromName: "Rosa",
      fromAddress: "rosa@x.test",
      receivedAt: new Date("2026-11-12T15:05:00Z"),
      textBody: "Hola\n¿cuánto?",
    })
    expect(quote[0]).toMatch(/^El 12 de noviembre de 2026.*10:05.*, Rosa escribió:$/)
    expect(quote[1]).toBe("> Hola\n> ¿cuánto?")
    expect(
      quotedEmail({ fromName: null, fromAddress: "r@x", receivedAt: new Date(), textBody: null }),
    ).toEqual([])
  })

  it("sin cliente: sale igual, con quien responde, el hilo y la cita; al ligarlo pasa a su cliente", async () => {
    const inbound = await ingestInboundEmail(
      ownerDb,
      mail({
        subject: "Re: Precios",
        references: "<primero@gmail.com>",
        from: "nadie.conocida@gmail.com",
      }),
    )
    expect(inbound.clientId).toBeNull()
    const reply = await ownerDb.transaction((tx) =>
      prepareEmailReply(tx, admin, inbound.id, { body: "Hola, le cuento." }),
    )
    expect(reply).toMatchObject({
      clientId: null,
      to: "nadie.conocida@gmail.com",
      subject: "Re: Precios",
      from: "ada.lovelace@odentia32.com",
      inReplyToEmailId: inbound.id,
    })
    const [stored] = await ownerDb
      .select({ messageId: saasInboundEmail.messageId })
      .from(saasInboundEmail)
      .where(eq(saasInboundEmail.id, inbound.id))
    const email = await ownerDb.transaction((tx) => outreachEmail(tx, reply.id))
    expect(email.headers).toEqual({
      "In-Reply-To": stored?.messageId,
      References: `<primero@gmail.com> ${stored?.messageId}`,
    })
    expect(email.from.address).toBe("ada.lovelace@odentia32.com")
    expect(email.text).toContain("Hola, le cuento.")
    expect(email.text).toContain("Rosa Mamani escribió:")
    expect(email.text).toContain("> ¿cuánto cuesta?")
    expect(email.html).toContain("&gt; ¿cuánto cuesta?")
    // No se adjunta una propuesta a un correo sin cliente.
    await expect(
      ownerDb.transaction((tx) =>
        prepareEmailReply(tx, admin, inbound.id, {
          body: "Otra",
          proposalId: "00000000-0000-4000-8000-000000000000",
        }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    await ownerDb.transaction((tx) => markOutreachSent(tx, admin, reply.id, "enviado"))
    await assignInboundEmail(ownerDb, admin, inbound.id, clientId)
    const entries = await ownerDb
      .select({ body: saasFollowUp.body, direction: saasFollowUp.direction })
      .from(saasFollowUp)
      .where(eq(saasFollowUp.clientId, clientId))
    expect(entries).toContainEqual({ body: "Re: Precios\n\nHola, le cuento.", direction: "salio" })
  })

  it("lo de soporte@ sale desde soporte@ y lo responde Soporte; lo demás, solo Administración", async () => {
    const toSupport = await ingestInboundEmail(
      ownerDb,
      mail({ mailbox: "soporte", to: "soporte@odentia32.com", subject: "No entra" }),
    )
    const reply = await ownerDb.transaction((tx) =>
      prepareEmailReply(tx, support, toSupport.id, { body: "Ya lo vemos." }),
    )
    const email = await ownerDb.transaction((tx) => outreachEmail(tx, reply.id))
    expect(email.from).toEqual({ name: "Soporte · odentIA", address: "soporte@odentia32.com" })
    expect(email.replyTo).toBe("soporte@odentia32.com")
    // Soporte no responde lo comercial, ni ve ni resuelve sus envíos.
    const toHola = await ingestInboundEmail(ownerDb, mail({ mailbox: "hola" }))
    await expect(
      ownerDb.transaction((tx) => prepareEmailReply(tx, support, toHola.id, { body: "Hola" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 })
    const commercial = await ownerDb.transaction((tx) =>
      prepareEmailReply(tx, admin, toHola.id, { body: "Hola" }),
    )
    await expect(
      ownerDb.transaction((tx) => resolveOutreach(tx, support, commercial.id, "salio")),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    // Cada respuesta con su propio Message-ID.
    const [a, b] = await Promise.all(
      [reply.id, commercial.id].map((id) => ownerDb.transaction((tx) => outreachEmail(tx, id))),
    )
    expect(a?.messageId).not.toBe(b?.messageId)
  })
})

describe("leer un correo y su historial", () => {
  it("el correo dice desde dónde saldría la respuesta de quien mira, y el historial lo abre", async () => {
    const inbound = await ingestInboundEmail(
      ownerDb,
      mail({ from: "rosa@hilo.test", subject: "Una duda", text: "¿Tienen agenda en línea?" }),
    )
    expect(inbound.clientId).toBe(clientId)
    const detail = await ownerDb.transaction((tx) => getInboundEmail(tx, admin, inbound.id))
    expect(detail).toMatchObject({
      canReply: true,
      replySubject: "Re: Una duda",
      replyFrom: { name: "Ada Lovelace · odentIA", address: "ada.lovelace@odentia32.com" },
      replySignature: "Ada Lovelace · odentIA",
      replyTo: "rosa@hilo.test",
      text: "¿Tienen agenda en línea?",
    })
    // Sin dirección, la respuesta saldría desde hola@; quien ya no está, no responde.
    expect(
      (await ownerDb.transaction((tx) => getInboundEmail(tx, plain, inbound.id))).replyFrom,
    ).toEqual({ name: "odentIA", address: "hola@odentia32.com" })
    expect(
      (await ownerDb.transaction((tx) => getInboundEmail(tx, gone, inbound.id))).replyFrom,
    ).toBeNull()
    // Lo comercial no existe para Soporte.
    await expect(
      ownerDb.transaction((tx) => getInboundEmail(tx, support, inbound.id)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })

    const reply = await ownerDb.transaction((tx) =>
      prepareEmailReply(tx, admin, inbound.id, { body: "Sí, la tenemos." }),
    )
    await ownerDb.transaction((tx) => markOutreachSent(tx, admin, reply.id, "enviado"))
    const history = await ownerDb.transaction((tx) =>
      clientTimeline(tx, admin, clientId, { filter: "contactos", limit: 100 }),
    )
    const came = history.items.find(
      (entry) => entry.title === "Nos escribió un correo" && entry.link?.id === inbound.id,
    )
    expect(came?.link).toEqual({ kind: "correo", id: inbound.id })
    const answered = history.items.find((entry) => entry.title === "Le respondimos su correo")
    expect(answered?.link).toEqual({ kind: "correo", id: inbound.id })
    // Soporte ve que llegó, pero no lo abre ni ve la respuesta (es comercial).
    const forSupport = await ownerDb.transaction((tx) =>
      clientTimeline(tx, support, clientId, { filter: "contactos", limit: 100 }),
    )
    expect(forSupport.items.some((entry) => entry.link?.id === inbound.id)).toBe(false)
    expect(forSupport.items.some((entry) => entry.title === "Le respondimos su correo")).toBe(false)
  })
})

/** Un ítem de Kairós de un correo, como lo deja la pasada (`responder_correo`). */
async function replyItem(emailId: string, adminOnly = true): Promise<string> {
  const [row] = await ownerDb
    .insert(kairosItem)
    .values({
      kind: "responder_correo",
      title: "Responder",
      reason: "Le escribió a hola@",
      payload: { emailId, body: "Hola, le cuento." },
      expectedState: {},
      idempotencyKey: `prueba:${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 48 * 3_600_000),
      adminOnly,
    })
    .returning({ id: kairosItem.id })
  if (!row) throw new Error("sin ítem")
  return row.id
}

async function activitiesOf(id: string) {
  return ownerDb
    .select({ body: saasFollowUp.body, adminOnly: saasFollowUp.adminOnly })
    .from(saasFollowUp)
    .where(eq(saasFollowUp.clientId, id))
}

describe("lo que corrigió la revisión", () => {
  it("Soporte no ve lo comercial: ni su actividad, ni su fila en el historial, ni lo asigna", async () => {
    const hola = await ingestInboundEmail(
      ownerDb,
      mail({ from: "rosa@hilo.test", subject: "Precio por sede" }),
    )
    const soporte = await ingestInboundEmail(
      ownerDb,
      mail({
        from: "rosa@hilo.test",
        mailbox: "soporte",
        to: "soporte@odentia32.com",
        subject: "No entra",
      }),
    )
    expect([hola.clientId, soporte.clientId]).toEqual([clientId, clientId])
    const acts = await activitiesOf(clientId)
    expect(acts).toContainEqual({ body: "Escribió a hola@: Precio por sede", adminOnly: true })
    expect(acts).toContainEqual({ body: "Escribió a soporte@: No entra", adminOnly: false })
    // Un correo del cliente sin su actividad: la fila del historial sale del correo.
    await ownerDb.insert(saasInboundEmail).values({
      clientId,
      mailbox: "persona",
      staffUserId: other.userId,
      product: "dental",
      messageId: "<sin-actividad@hilo.test>",
      fromAddress: "rosa@hilo.test",
      toAddress: "beto+ventas@odentia32.com",
      subject: "Sin actividad",
      receivedAt: new Date(Date.now() - 3_600_000),
    })
    const titles = async (actor: AdminActor) =>
      (
        await ownerDb.transaction((tx) =>
          clientTimeline(tx, actor, clientId, { filter: "contactos", limit: 100 }),
        )
      ).items.map((entry) => entry.title)
    // La dirección de la persona, no «persona@».
    expect(await titles(admin)).toContain("Nos escribió a beto@")
    expect((await titles(support)).some((title) => title.startsWith("Nos escribió a"))).toBe(false)
    // Asignar lo comercial: para Soporte no existe.
    const orphan = await ingestInboundEmail(
      ownerDb,
      mail({ from: "nadie.revision@gmail.com", mailbox: "contacto" }),
    )
    await expect(assignInboundEmail(ownerDb, support, orphan.id, clientId)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    })
    const orphanSupport = await ingestInboundEmail(
      ownerDb,
      mail({ from: "nadie.revision@gmail.com", mailbox: "soporte", to: "soporte@odentia32.com" }),
    )
    expect(await assignInboundEmail(ownerDb, support, orphanSupport.id, clientId)).toMatchObject({
      clientId,
    })
    // Lo comercial que asigna Administración queda solo suyo.
    await assignInboundEmail(ownerDb, admin, orphan.id, clientId)
    expect(await activitiesOf(clientId)).toContainEqual({
      body: "Escribió a contacto@: Quiero saber más",
      adminOnly: true,
    })
  })

  it("Soporte siempre escribe desde soporte@, también en «Escribir», y su dirección no queda fija", async () => {
    const row = await ownerDb.transaction((tx) =>
      prepareOutreach(tx, support, clientId, {
        channel: "correo",
        to: "rosa@hilo.test",
        subject: "Su acceso",
        body: "Hola, Rosa.",
      }),
    )
    expect(row.from).toBe("soporte@odentia32.com")
    const email = await ownerDb.transaction((tx) => outreachEmail(tx, row.id))
    expect(email.from).toEqual({ name: "Soporte · odentIA", address: "soporte@odentia32.com" })
    expect(email.replyTo).toBe("soporte@odentia32.com")
    expect((await mailLocalOf(support.userId))?.firstSentAt).toBeNull()
  })

  it("el cajón no le muestra a Soporte las respuestas solo de Administración", async () => {
    const inbound = await ingestInboundEmail(
      ownerDb,
      mail({ mailbox: "soporte", to: "soporte@odentia32.com", from: "otra.cosa@gmail.com" }),
    )
    const item = await replyItem(inbound.id)
    const reserved = await ownerDb.transaction((tx) =>
      prepareEmailReply(tx, admin, inbound.id, { body: "Lo vemos.", kairosItemId: item }),
    )
    const shown = async (actor: AdminActor) =>
      (await ownerDb.transaction((tx) => getInboundEmail(tx, actor, inbound.id))).replies.map(
        (reply) => reply.id,
      )
    expect(await shown(admin)).toEqual([reserved.id])
    expect(await shown(support)).toEqual([])
  })

  it("la respuesta va al Reply-To; el cliente se liga por el From verificado", async () => {
    const inbound = await ingestInboundEmail(
      ownerDb,
      mail({ from: "rosa@hilo.test", replyTo: " Recepcion@Hilo.test " }),
    )
    expect(inbound.clientId).toBe(clientId)
    const [row] = await ownerDb
      .select({ replyTo: saasInboundEmail.replyTo })
      .from(saasInboundEmail)
      .where(eq(saasInboundEmail.id, inbound.id))
    expect(row?.replyTo).toBe("recepcion@hilo.test")
    const reply = await ownerDb.transaction((tx) =>
      prepareEmailReply(tx, admin, inbound.id, { body: "Hola." }),
    )
    expect(reply.to).toBe("recepcion@hilo.test")
    // Un Reply-To que no es un correo no se guarda: la respuesta va al remitente.
    const odd = await ingestInboundEmail(ownerDb, mail({ replyTo: "no es correo" }))
    const [oddRow] = await ownerDb
      .select({ replyTo: saasInboundEmail.replyTo })
      .from(saasInboundEmail)
      .where(eq(saasInboundEmail.id, odd.id))
    expect(oddRow?.replyTo).toBeNull()
  })

  it("el aviso del Worker se guarda aparte: no se cita ni es parte del texto", async () => {
    const notice = "No se guardaron por su tipo (solo PDF, imagen, xlsx, csv y docx): lista.zip."
    const inbound = await ingestInboundEmail(ownerDb, mail({ text: "Les mando la lista.", notice }))
    const detail = await ownerDb.transaction((tx) => getInboundEmail(tx, admin, inbound.id))
    expect(detail).toMatchObject({ text: "Les mando la lista.", notice })
    const reply = await ownerDb.transaction((tx) =>
      prepareEmailReply(tx, admin, inbound.id, { body: "Recibido." }),
    )
    const email = await ownerDb.transaction((tx) => outreachEmail(tx, reply.id))
    expect(email.text).toContain("> Les mando la lista.")
    expect(email.text).not.toContain("lista.zip")
  })

  it("la respuesta lleva la firma de quien sale como remitente, una sola vez", async () => {
    const signed = async (actor: AdminActor, mailbox: "hola" | "soporte", body: string) => {
      const inbound = await ingestInboundEmail(
        ownerDb,
        mail({ mailbox, to: `${mailbox}@odentia32.com`, from: "firma@gmail.com" }),
      )
      const reply = await ownerDb.transaction((tx) =>
        prepareEmailReply(tx, actor, inbound.id, { body }),
      )
      return (await ownerDb.transaction((tx) => outreachEmail(tx, reply.id))).text
    }
    const ada = await signed(admin, "hola", "Hola, le cuento.")
    expect(ada).toMatch(/Hola, le cuento\.\s+Ada Lovelace · odentIA\s+El .+ escribió:/s)
    // Si ya termina con la firma, no se repite.
    const once = await signed(admin, "hola", "Hola.\n\nAda Lovelace · odentIA")
    expect(once.split("Ada Lovelace · odentIA")).toHaveLength(2)
    expect(await signed(plain, "hola", "Hola.")).toMatch(/Hola\.\s+El equipo de odentIA/)
    expect(await signed(support, "soporte", "Ya lo vemos.")).toMatch(
      /Ya lo vemos\.\s+Soporte · odentIA/,
    )
  })

  it("las cabeceras del hilo: References del padre o su In-Reply-To, más su Message-ID; nada inventado", async () => {
    expect(
      replyReferences({ references: null, inReplyTo: "<padre@x>", messageId: "<hijo@x>" }),
    ).toBe("<padre@x> <hijo@x>")
    expect(replyReferences({ references: "<a@x>", inReplyTo: "<b@x>", messageId: "<c@x>" })).toBe(
      "<a@x> <c@x>",
    )
    expect(
      replyReferences({ references: null, inReplyTo: "<a@x> <b@x>", messageId: "<c@x>" }),
    ).toBe("<c@x>")
    expect(
      replyReferences({
        references: null,
        inReplyTo: null,
        messageId: "<sin-id-abc@entrante.sallca>",
      }),
    ).toBeNull()
    const headersOf = async (input: Partial<InboundEmailInput>) => {
      const inbound = await ingestInboundEmail(ownerDb, mail(input))
      const reply = await ownerDb.transaction((tx) =>
        prepareEmailReply(tx, admin, inbound.id, { body: "Hola." }),
      )
      return (await ownerDb.transaction((tx) => outreachEmail(tx, reply.id))).headers
    }
    // Sin «<>»: se normaliza.
    expect(
      await headersOf({ messageId: "sin-corchetes-1@gmail.com", inReplyTo: "<padre-1@gmail.com>" }),
    ).toEqual({
      "In-Reply-To": "<sin-corchetes-1@gmail.com>",
      References: "<padre-1@gmail.com> <sin-corchetes-1@gmail.com>",
    })
    // El que puso el Worker porque el correo no traía: no va.
    expect(
      await headersOf({ messageId: `<sin-id-${crypto.randomUUID()}@entrante.sallca>` }),
    ).toEqual({})
  })

  it("quien deja el equipo: su respuesta entra sin copia, y al desactivarla se borra su copia", async () => {
    await ownerDb
      .update(adminStaff)
      .set({ active: true, mailCopyTo: "gonzalo@gmail.com" })
      .where(eq(adminStaff.userId, gone.userId))
    const out = await ownerDb.transaction((tx) =>
      prepareOutreach(tx, gone, clientId, {
        channel: "correo",
        to: "rosa@hilo.test",
        subject: "Antes de irme, otra vez",
        body: "Hola.",
      }),
    )
    await ownerDb
      .update(adminStaff)
      .set({ active: false })
      .where(eq(adminStaff.userId, gone.userId))
    const { messageId } = await ownerDb.transaction((tx) => outreachEmail(tx, out.id))
    expect(await inboundPersonOf(ownerDb, "gonzalo", [messageId ?? ""])).toEqual({
      userId: gone.userId,
      copyTo: null,
    })
    // Desactivar a alguien borra su copia.
    await setAdminStaffActive(ownerDb, admin, other.userId, false, "Dejó el equipo hoy")
    const [beto] = await ownerDb
      .select({ copyTo: adminStaff.mailCopyTo })
      .from(adminStaff)
      .where(eq(adminStaff.userId, other.userId))
    expect(beto?.copyTo).toBeNull()
  })

  it("a una persona de Soporte no se le copia lo que llega a su dirección: es comercial", async () => {
    await ownerDb
      .update(adminStaff)
      .set({ active: true, role: "support", mailCopyTo: "beto@gmail.com" })
      .where(eq(adminStaff.userId, other.userId))
    try {
      expect(await inboundPersonOf(ownerDb, "beto", [])).toEqual({
        userId: other.userId,
        copyTo: null,
      })
    } finally {
      await ownerDb
        .update(adminStaff)
        .set({ active: false, role: "admin", mailCopyTo: null })
        .where(eq(adminStaff.userId, other.userId))
    }
  })

  it("si alguien ya respondió, el borrador de Kairós no sale (409)", async () => {
    const inbound = await ingestInboundEmail(ownerDb, mail({ from: "carrera@gmail.com" }))
    const item = await replyItem(inbound.id)
    await ownerDb.transaction((tx) => prepareEmailReply(tx, admin, inbound.id, { body: "A mano." }))
    await expect(
      ownerDb.transaction((tx) =>
        prepareEmailReply(tx, admin, inbound.id, { body: "De Kairós.", kairosItemId: item }),
      ),
    ).rejects.toMatchObject({ code: "ALREADY_REPLIED", status: 409 })
  })
})

describe("lo que corrigió el recorrido en pantalla", () => {
  it("lo que llegó a soporte@ no lleva propuesta, tampoco de Administración (400 en proposalId)", async () => {
    const inbound = await ingestInboundEmail(
      ownerDb,
      mail({ mailbox: "soporte", to: "soporte@odentia32.com", from: "rosa@hilo.test" }),
    )
    expect(inbound.clientId).toBe(clientId)
    await expect(
      ownerDb.transaction((tx) =>
        prepareEmailReply(tx, admin, inbound.id, {
          body: "Ya lo vemos.",
          proposalId: "00000000-0000-4000-8000-000000000000",
        }),
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      status: 400,
      fields: { proposalId: expect.stringMatching(/soporte@/) },
    })
  })

  it("una respuesta a mano cierra el borrador de Kairós de ese correo, sin enviar nada", async () => {
    const inbound = await ingestInboundEmail(ownerDb, mail({ from: "a.mano@gmail.com" }))
    const otherEmail = await ingestInboundEmail(ownerDb, mail({ from: "otra.persona@gmail.com" }))
    const item = await replyItem(inbound.id)
    const untouched = await replyItem(otherEmail.id)
    const reply = await ownerDb.transaction((tx) =>
      prepareEmailReply(tx, admin, inbound.id, { body: "A mano." }),
    )
    const [closed] = await ownerDb.select().from(kairosItem).where(eq(kairosItem.id, item))
    expect(closed).toMatchObject({
      status: "vencida",
      error: "Ada Lovelace lo respondió a mano: este borrador no sale",
      result: null,
    })
    // Su clave queda libre, como lo vencido; el de otro correo sigue en espera.
    expect(closed?.idempotencyKey.startsWith(`vencida:${item}:`)).toBe(true)
    const [still] = await ownerDb
      .select({ status: kairosItem.status })
      .from(kairosItem)
      .where(eq(kairosItem.id, untouched))
    expect(still?.status).toBe("espera")
    // Solo la respuesta a mano, y todavía sin salir.
    const replies = await ownerDb.transaction((tx) => getInboundEmail(tx, admin, inbound.id))
    expect(replies.replies.map((row) => [row.id, row.status])).toEqual([[reply.id, "pendiente"]])
    // «Lo que hizo» lo dice; Soporte no lo ve (es solo de Administración).
    const done = await ownerDb.transaction((tx) => kairosDone(tx, admin, { limit: 200 }))
    expect(done.map((entry) => entry.words)).toContain(
      "Retiró su borrador «Responder»: Ada Lovelace respondió el correo a mano",
    )
    const forSupport = await ownerDb.transaction((tx) => kairosDone(tx, support, { limit: 200 }))
    expect(forSupport.some((entry) => entry.words.startsWith("Retiró su borrador"))).toBe(false)
  })

  it("en el historial, el correo que entró dice quién lo escribió: su nombre o su correo", async () => {
    const named = await ingestInboundEmail(
      ownerDb,
      mail({
        from: "rosa@hilo.test",
        subject: "Con nombre",
        receivedAt: new Date(Date.now() - 60_000),
      }),
    )
    const bare = await ingestInboundEmail(
      ownerDb,
      mail({ from: "rosa@hilo.test", fromName: null, subject: "Sin nombre" }),
    )
    const history = await ownerDb.transaction((tx) =>
      clientTimeline(tx, admin, clientId, { filter: "contactos", limit: 100 }),
    )
    const whoOf = (emailId: string) =>
      history.items.find(
        (entry) => entry.title === "Nos escribió un correo" && entry.link?.id === emailId,
      )?.who
    expect(whoOf(named.id)).toEqual({ kind: "clinica", name: "Rosa Mamani" })
    expect(whoOf(bare.id)).toEqual({ kind: "clinica", name: "rosa@hilo.test" })
  })
})
