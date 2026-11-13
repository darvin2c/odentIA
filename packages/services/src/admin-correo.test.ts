import { saasClient, saasClientContact, saasInboundEmail } from "@odentia/db/schema/admin-arm"
import { adminStaff } from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import { saasFollowUp } from "@odentia/db/schema/saas-billing"
import { eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { clientTimeline } from "./admin-clients.js"
import type { AdminActor } from "./admin-core.js"
import {
  assignInboundEmail,
  getInboundEmail,
  type InboundEmailInput,
  ingestInboundEmail,
} from "./admin-inbound-email.js"
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
    ).rejects.toMatchObject({ code: "MAIL_LOCAL_TAKEN", status: 409 })
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
    expect(replyReferences({ references: "<a@x> <b@x>", messageId: "<c@x>" })).toBe(
      "<a@x> <b@x> <c@x>",
    )
    expect(replyReferences({ references: "<c@x>", messageId: "<c@x>" })).toBe("<c@x>")
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
