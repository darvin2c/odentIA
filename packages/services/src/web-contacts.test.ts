/** El aviso de las guías (ADR 0214): el correo que deja quien bajó una plantilla. */
import { randomUUID } from "node:crypto"
import {
  saasClient,
  saasClientContact,
  saasOpportunity,
  saasWebContact,
} from "@odentia/db/schema/admin-arm"
import { member, user } from "@odentia/db/schema/auth"
import { adminStaff } from "@odentia/db/schema/admin-core"
import { saasWaitlistRequest } from "@odentia/db/schema/saas-billing"
import { eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import type { AdminActor } from "./admin-core.js"
import {
  clientTimeline,
  createClient,
  mergeClients,
  UNKNOWN_CONTACT_NAME,
} from "./admin-clients.js"
import { submitWaitlistRequest, webPageOf } from "./saas-founders.js"
import { insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import {
  mailboxOf,
  markWebContactSent,
  submitWebContact,
  WEB_CONTACTS_PER_HOUR,
  type WebContactResult,
  webContactInputSchema,
} from "./web-contacts.js"

setupTestDb()
const admin: AdminActor = { userId: "guias-admin", role: "admin" }
const GUIDE = "/guias/como-llenar-un-odontograma"

beforeAll(async () => {
  await ownerDb.insert(user).values({ id: admin.userId, name: "Marta Admin", email: "admin@guias.test" })
  await ownerDb.insert(adminStaff).values({ userId: admin.userId, role: "admin" })
})

function contact(email: string, over: Record<string, unknown> = {}) {
  return webContactInputSchema.parse({
    email,
    page: GUIDE,
    sheets: ["odontograma", "odontograma-ninos"],
    ...over,
  })
}

/** Lo que devuelve un aviso que sí envía, con su cliente. */
function sent(result: WebContactResult) {
  if (!result.send) throw new Error(`debía enviarse (${result.reason})`)
  if (!result.clientId) throw new Error("debía tener cliente")
  return { ...result, clientId: result.clientId }
}

function request(email: string) {
  return {
    firstName: "Milagros",
    lastName: "Huamán",
    email,
    phone: "+51 987 654 321",
    clinicName: "Consultorio Huamán",
    countryCode: "pe",
    city: "Arequipa",
    professionals: "1" as const,
    currentTool: "cuaderno_excel" as const,
  }
}

async function teamClient(email: string, name = "Clínica del Equipo") {
  const { id } = await createClient(ownerDb, admin, {
    name,
    product: "dental",
    contact: { name: "Dra. Ana Real", email },
    origin: "referido",
    confirmNew: true,
  })
  return id
}

describe("la página desde la que llega algo", () => {
  it("solo guarda una ruta de la web, nunca otra cosa", () => {
    expect(webPageOf(GUIDE)).toBe(GUIDE)
    expect(webPageOf(" /guias/odontograma-en-ninos ")).toBe("/guias/odontograma-en-ninos")
    for (const bad of [
      "Cómo llenar un odontograma",
      "https://otra.com/guias/x",
      "/guias/../admin",
      "/Guias/X",
      "/",
      "",
      null,
      42,
    ])
      expect(webPageOf(bad), String(bad)).toBeNull()
  })

  it("el aviso solo acepta páginas de las guías, plantillas con nombre y correos válidos", () => {
    const base = { email: "a@b.test", page: GUIDE, sheets: ["odontograma"] }
    expect(webContactInputSchema.safeParse(base).success).toBe(true)
    for (const bad of [
      { page: "/precios" },
      { sheets: ["../secreto"] },
      { sheets: [] },
      { email: "milagros@clinica" },
      { email: `${"a".repeat(250)}@b.test` },
    ])
      expect(webContactInputSchema.safeParse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(
        false,
      )
  })
})

describe("el buzón de un correo", () => {
  it("sin la «+etiqueta» y, en Gmail, sin los puntos", () => {
    expect(mailboxOf("Ana.Perez+guias@Gmail.com")).toBe("anaperez@gmail.com")
    expect(mailboxOf("ana.perez@googlemail.com")).toBe("anaperez@gmail.com")
    expect(mailboxOf("ana.perez+x@clinica.pe")).toBe("ana.perez@clinica.pe")
    expect(mailboxOf("+raro@clinica.pe")).toBe("+raro@clinica.pe")
  })
})

describe("el correo del aviso", () => {
  it("crea un cliente con su contacto y su guía, sin abrir una venta", async () => {
    const result = sent(await submitWebContact(ownerDb, contact("QA.Milagros@Example.com"), "dental"))
    expect(result).toMatchObject({
      hasAccount: false,
      sheets: [
        { key: "odontograma", file: "odontograma.pdf", title: "Odontograma" },
        { key: "odontograma-ninos", file: "odontograma-ninos.pdf", title: "Odontograma de niños" },
      ],
    })
    const [client] = await ownerDb.select().from(saasClient).where(eq(saasClient.id, result.clientId))
    expect(client).toMatchObject({
      name: "qa.milagros@example.com",
      origin: "web",
      originDetail: `Desde ${GUIDE}`,
      product: "dental",
    })
    const contacts = await ownerDb
      .select()
      .from(saasClientContact)
      .where(eq(saasClientContact.clientId, result.clientId))
    expect(contacts).toMatchObject([
      { email: "qa.milagros@example.com", name: UNKNOWN_CONTACT_NAME, isPrimary: true, phone: null },
    ])
    // Dejar un correo no es pedir entrar: no hay venta abierta ni tarea de llamar.
    expect(
      await ownerDb.select().from(saasOpportunity).where(eq(saasOpportunity.clientId, result.clientId)),
    ).toEqual([])
  })

  it("solo las plantillas del producto: latidIA no tiene guías y una que no existe no se acepta", async () => {
    await expect(submitWebContact(ownerDb, contact("qa.medica@example.com"), "medical")).rejects.toMatchObject({
      status: 404,
    })
    await expect(
      submitWebContact(ownerDb, contact("qa.nada@example.com", { sheets: ["receta"] }), "dental"),
    ).rejects.toMatchObject({ status: 400, fields: { sheets: expect.any(String) } })
  })

  it("una vez por buzón al día, aunque se escriba de otra forma", async () => {
    const first = sent(await submitWebContact(ownerDb, contact("qa.dos@example.com"), "dental"))
    await markWebContactSent(ownerDb, first.contactId)
    for (const again of ["qa.dos@example.com", "QA.DOS+guias@example.com"])
      expect(await submitWebContact(ownerDb, contact(again), "dental"), again).toEqual({
        send: false,
        reason: "reciente",
      })
    sent(await submitWebContact(ownerDb, contact("qa.tres.gmail@gmail.com"), "dental"))
    expect(await submitWebContact(ownerDb, contact("qatresgmail+x@googlemail.com"), "dental")).toEqual({
      send: false,
      reason: "reciente",
    })
    // Al día siguiente sí, y es el mismo cliente.
    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000)
    const again = sent(await submitWebContact(ownerDb, contact("qa.dos@example.com"), "dental", tomorrow))
    expect(again.clientId).toBe(first.clientId)
  })

  it("si no se confirmó que salió, igual cuenta para el día: no se manda dos veces", async () => {
    sent(await submitWebContact(ownerDb, contact("qa.fallo@example.com"), "dental"))
    const later = new Date(Date.now() + 5 * 60 * 1000)
    expect(await submitWebContact(ownerDb, contact("qa.fallo@example.com"), "dental", later)).toEqual({
      send: false,
      reason: "reciente",
    })
  })

  it("dos pestañas a la vez: sale uno solo", async () => {
    const both = await Promise.all(
      [1, 2].map(() =>
        ownerDb.transaction((tx) => submitWebContact(tx, contact("qa.pestanas@example.com"), "dental")),
      ),
    )
    expect(both.filter((result) => result.send)).toHaveLength(1)
    expect(both.filter((result) => !result.send)).toEqual([{ send: false, reason: "reciente" }])
  })

  it("unos pocos por hora entre todos: pasado el tope, ninguno hasta que baja", async () => {
    // Un mes adelante, para contar solo los de esta prueba.
    const at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    await ownerDb.insert(saasWebContact).values(
      Array.from({ length: WEB_CONTACTS_PER_HOUR }, (_, index) => ({
        email: `qa.tope${index}@example.com`,
        mailbox: `qa.tope${index}@example.com`,
        product: "dental",
        sourcePage: GUIDE,
        sheets: ["odontograma"],
        createdAt: new Date(at.getTime() - 30 * 60 * 1000),
      })),
    )
    expect(await submitWebContact(ownerDb, contact("qa.tope.otro@example.com"), "dental", at)).toEqual({
      send: false,
      reason: "ocupado",
    })
    const later = new Date(at.getTime() + 31 * 60 * 1000)
    sent(await submitWebContact(ownerDb, contact("qa.tope.otro@example.com"), "dental", later))
  })

  it("con una solicitud viva también le llegan, en su mismo cliente: no dice que ya pidió", async () => {
    const asked = await submitWaitlistRequest(ownerDb, request("qa.viva@example.com"))
    const left = sent(await submitWebContact(ownerDb, contact("qa.viva@example.com"), "dental"))
    expect(left).toMatchObject({ clientId: asked.clientId, hasAccount: false })
  })

  it("si el correo es de alguien de una clínica con cuenta, es su cliente y no se lo invita a pedir entrar", async () => {
    const orgId = `guias-${randomUUID().slice(0, 8)}`
    await insertOrg(ownerDb, orgId, orgId)
    const userId = `u-${orgId}`
    await ownerDb.insert(user).values({ id: userId, name: "Lucía Rojas", email: "qa.equipo@example.com" })
    await ownerDb
      .insert(member)
      .values({ id: randomUUID(), organizationId: orgId, userId, role: "owner", createdAt: new Date() })
    const clientId = await teamClient("qa.duena@example.com", "Clínica con Cuenta")
    await ownerDb.update(saasClient).set({ organizationId: orgId }).where(eq(saasClient.id, clientId))
    const left = sent(await submitWebContact(ownerDb, contact("qa.equipo@example.com"), "dental"))
    expect(left).toMatchObject({ clientId, hasAccount: true })
  })

  it("si el correo es de dos clientes, no elige ni crea otro", async () => {
    await teamClient("qa.compartido@example.com", "Clínica Uno")
    await teamClient("qa.compartido@example.com", "Clínica Dos")
    const result = await submitWebContact(ownerDb, contact("qa.compartido@example.com"), "dental")
    expect(result).toMatchObject({ send: true, clientId: null })
    expect(
      await ownerDb.select().from(saasClient).where(eq(saasClient.name, "qa.compartido@example.com")),
    ).toEqual([])
  })

  it("si después pide entrar, es el mismo cliente y toma su nombre, su país y su celular", async () => {
    const left = sent(await submitWebContact(ownerDb, contact("qa.despues@example.com"), "dental"))
    const asked = await submitWaitlistRequest(
      ownerDb,
      { ...request("qa.despues@example.com"), countryCode: "cl" },
      "dental",
      { sourcePage: "/guias/presupuesto-dental" },
    )
    expect(asked.clientId).toBe(left.clientId)
    const [client] = await ownerDb.select().from(saasClient).where(eq(saasClient.id, left.clientId))
    // El origen es el primero: llegó por la guía del odontograma.
    expect(client).toMatchObject({ name: "Consultorio Huamán", countryCode: "CL", originDetail: `Desde ${GUIDE}` })
    const contacts = await ownerDb
      .select()
      .from(saasClientContact)
      .where(eq(saasClientContact.clientId, left.clientId))
    expect(contacts).toMatchObject([
      { name: "Milagros Huamán", phone: "+51987654321", email: "qa.despues@example.com" },
    ])
    const [row] = await ownerDb.select().from(saasWaitlistRequest).where(eq(saasWaitlistRequest.id, asked.id))
    expect(row?.sourcePage).toBe("/guias/presupuesto-dental")
    // Ahora sí hay venta: pidió entrar.
    expect(
      (await ownerDb.select().from(saasOpportunity).where(eq(saasOpportunity.clientId, left.clientId))).length,
    ).toBe(1)
  })

  it("la solicitud no cambia el contacto ni el cliente que cargó el equipo", async () => {
    const clientId = await teamClient("qa.cargada@example.com", "Clínica Cargada")
    const asked = await submitWaitlistRequest(ownerDb, request("qa.cargada@example.com"))
    expect(asked.clientId).toBe(clientId)
    const [client] = await ownerDb.select().from(saasClient).where(eq(saasClient.id, clientId))
    expect(client?.name).toBe("Clínica Cargada")
    const contacts = await ownerDb
      .select()
      .from(saasClientContact)
      .where(eq(saasClientContact.clientId, clientId))
    expect(contacts).toMatchObject([{ name: "Dra. Ana Real", phone: null, email: "qa.cargada@example.com" }])
  })

  it("queda en el historial de su ficha, con su guía y si se confirmó que le llegaron", async () => {
    const left = sent(await submitWebContact(ownerDb, contact("qa.historial@example.com"), "dental"))
    const entry = async () =>
      (await clientTimeline(ownerDb, admin, left.clientId)).items
        .filter((item) => item.title === "Dejó su correo en una guía de la web")
        .map((item) => item.detail)
    expect(await entry()).toEqual([`Desde ${GUIDE} · sin confirmar que salió el correo con las plantillas`])
    await markWebContactSent(ownerDb, left.contactId)
    expect(await entry()).toEqual([`Desde ${GUIDE} · le enviamos las plantillas`])
  })

  it("al fusionar su cliente con otro, el aviso pasa al que queda", async () => {
    const left = sent(await submitWebContact(ownerDb, contact("qa.fusion@example.com"), "dental"))
    const keep = await teamClient("qa.fusion.equipo@example.com", "Clínica que Queda")
    await mergeClients(ownerDb, admin, keep, left.clientId)
    const [row] = await ownerDb.select().from(saasWebContact).where(eq(saasWebContact.id, left.contactId))
    expect(row?.clientId).toBe(keep)
  })
})

describe("la solicitud con su página", () => {
  it("guarda la guía desde la que se envió y el cliente nuevo la lleva de origen", async () => {
    const { id, clientId } = await submitWaitlistRequest(ownerDb, request("qa.guia@example.com"), "dental", {
      sourcePage: GUIDE,
    })
    const [row] = await ownerDb.select().from(saasWaitlistRequest).where(eq(saasWaitlistRequest.id, id))
    expect(row?.sourcePage).toBe(GUIDE)
    const [client] = await ownerDb.select().from(saasClient).where(eq(saasClient.id, clientId ?? ""))
    expect(client?.originDetail).toBe(`Desde ${GUIDE}`)
  })

  it("una página que no es de la web no se guarda, y la solicitud entra igual", async () => {
    const { id } = await submitWaitlistRequest(ownerDb, request("qa.rara@example.com"), "dental", {
      sourcePage: "<script>",
    })
    const [row] = await ownerDb.select().from(saasWaitlistRequest).where(eq(saasWaitlistRequest.id, id))
    expect(row?.sourcePage).toBeNull()
  })
})
