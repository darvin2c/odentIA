/** El aviso de las guías (ADR 0214): el correo que deja quien bajó una plantilla. */
import {
  saasClient,
  saasClientContact,
  saasOpportunity,
  saasWebContact,
} from "@odentia/db/schema/admin-arm"
import { saasWaitlistRequest } from "@odentia/db/schema/saas-billing"
import { eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { clientTimeline, UNKNOWN_CONTACT_NAME } from "./admin-clients.js"
import { submitWaitlistRequest, webPageOf } from "./saas-founders.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
import { markWebContactSent, submitWebContact, webContactInputSchema } from "./web-contacts.js"

setupTestDb()
const admin = { userId: "guias-admin", role: "admin" as const }
const GUIDE = "/guias/como-llenar-un-odontograma"

function contact(email: string, over: Record<string, unknown> = {}) {
  return webContactInputSchema.parse({
    email,
    page: GUIDE,
    sheets: ["odontograma", "odontograma-ninos"],
    ...over,
  })
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

  it("el aviso solo acepta páginas de las guías y plantillas que existen", () => {
    expect(
      webContactInputSchema.safeParse({
        email: "a@b.test",
        page: "/precios",
        sheets: ["odontograma"],
      }).success,
    ).toBe(false)
    expect(
      webContactInputSchema.safeParse({ email: "a@b.test", page: GUIDE, sheets: ["../secreto"] })
        .success,
    ).toBe(false)
    expect(
      webContactInputSchema.safeParse({ email: "a@b.test", page: GUIDE, sheets: [] }).success,
    ).toBe(false)
    expect(
      webContactInputSchema.safeParse({
        email: "milagros@clinica",
        page: GUIDE,
        sheets: ["odontograma"],
      }).success,
    ).toBe(false)
  })
})

describe("el correo del aviso", () => {
  it("crea un cliente con su contacto y su guía, sin abrir una venta", async () => {
    const result = await submitWebContact(ownerDb, contact("QA.Milagros@Example.com"), "dental")
    expect(result).toMatchObject({ send: true, sheets: ["odontograma", "odontograma-ninos"] })
    if (!result.send) throw new Error("debía enviarse")
    const [client] = await ownerDb
      .select()
      .from(saasClient)
      .where(eq(saasClient.id, result.clientId))
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
      {
        email: "qa.milagros@example.com",
        name: UNKNOWN_CONTACT_NAME,
        isPrimary: true,
        phone: null,
      },
    ])
    // Dejar un correo no es pedir entrar: no hay venta abierta ni tarea de llamar.
    expect(
      await ownerDb
        .select()
        .from(saasOpportunity)
        .where(eq(saasOpportunity.clientId, result.clientId)),
    ).toEqual([])
  })

  it("una vez por dirección al día: el repetido no manda otro correo", async () => {
    const first = await submitWebContact(ownerDb, contact("qa.dos@example.com"), "dental")
    if (!first.send) throw new Error("debía enviarse")
    // Mientras sale el primero, el segundo no sale (dos pestañas a la vez).
    expect(await submitWebContact(ownerDb, contact("qa.dos@example.com"), "dental")).toEqual({
      send: false,
      reason: "reciente",
    })
    await markWebContactSent(ownerDb, first.contactId)
    expect(await submitWebContact(ownerDb, contact("QA.DOS@example.com"), "dental")).toEqual({
      send: false,
      reason: "reciente",
    })
    // Al día siguiente sí, y es el mismo cliente.
    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000)
    const again = await submitWebContact(ownerDb, contact("qa.dos@example.com"), "dental", tomorrow)
    expect(again).toMatchObject({ send: true, clientId: first.clientId })
  })

  it("si el correo no salió, se puede volver a intentar en unos minutos", async () => {
    const first = await submitWebContact(ownerDb, contact("qa.fallo@example.com"), "dental")
    if (!first.send) throw new Error("debía enviarse")
    const later = new Date(Date.now() + 5 * 60 * 1000)
    expect(
      await submitWebContact(ownerDb, contact("qa.fallo@example.com"), "dental", later),
    ).toMatchObject({ send: true, clientId: first.clientId })
  })

  it("con una solicitud viva no crea nada más", async () => {
    await submitWaitlistRequest(ownerDb, request("qa.viva@example.com"))
    expect(await submitWebContact(ownerDb, contact("qa.viva@example.com"), "dental")).toEqual({
      send: false,
      reason: "solicitud",
    })
    expect(
      await ownerDb
        .select()
        .from(saasWebContact)
        .where(eq(saasWebContact.email, "qa.viva@example.com")),
    ).toEqual([])
  })

  it("si después pide entrar, es el mismo cliente y toma su nombre, su país y su celular", async () => {
    const left = await submitWebContact(ownerDb, contact("qa.despues@example.com"), "dental")
    if (!left.send) throw new Error("debía enviarse")
    const asked = await submitWaitlistRequest(
      ownerDb,
      { ...request("qa.despues@example.com"), countryCode: "cl" },
      "dental",
      {
        sourcePage: "/guias/presupuesto-dental",
      },
    )
    expect(asked.clientId).toBe(left.clientId)
    const [client] = await ownerDb.select().from(saasClient).where(eq(saasClient.id, left.clientId))
    // El origen es el primero: llegó por la guía del odontograma.
    expect(client).toMatchObject({
      name: "Consultorio Huamán",
      countryCode: "CL",
      originDetail: `Desde ${GUIDE}`,
    })
    const contacts = await ownerDb
      .select()
      .from(saasClientContact)
      .where(eq(saasClientContact.clientId, left.clientId))
    expect(contacts).toMatchObject([
      { name: "Milagros Huamán", phone: "+51987654321", email: "qa.despues@example.com" },
    ])
    const [row] = await ownerDb
      .select()
      .from(saasWaitlistRequest)
      .where(eq(saasWaitlistRequest.id, asked.id))
    expect(row?.sourcePage).toBe("/guias/presupuesto-dental")
    // Ahora sí hay venta: pidió entrar.
    expect(
      (
        await ownerDb
          .select()
          .from(saasOpportunity)
          .where(eq(saasOpportunity.clientId, left.clientId))
      ).length,
    ).toBe(1)
  })

  it("queda en el historial de su ficha, con su guía y si le llegaron las plantillas", async () => {
    const left = await submitWebContact(ownerDb, contact("qa.historial@example.com"), "dental")
    if (!left.send) throw new Error("debía enviarse")
    await markWebContactSent(ownerDb, left.contactId)
    const timeline = await clientTimeline(ownerDb, admin, left.clientId)
    expect(timeline.items.map((entry) => [entry.title, entry.detail])).toContainEqual([
      "Dejó su correo en una guía de la web",
      `Desde ${GUIDE} · le enviamos las plantillas`,
    ])
  })
})

describe("la solicitud con su página", () => {
  it("guarda la guía desde la que se envió y el cliente nuevo la lleva de origen", async () => {
    const { id, clientId } = await submitWaitlistRequest(
      ownerDb,
      request("qa.guia@example.com"),
      "dental",
      { sourcePage: GUIDE },
    )
    const [row] = await ownerDb
      .select()
      .from(saasWaitlistRequest)
      .where(eq(saasWaitlistRequest.id, id))
    expect(row?.sourcePage).toBe(GUIDE)
    const [client] = await ownerDb
      .select()
      .from(saasClient)
      .where(eq(saasClient.id, clientId ?? ""))
    expect(client?.originDetail).toBe(`Desde ${GUIDE}`)
  })

  it("una página que no es de la web no se guarda, y la solicitud entra igual", async () => {
    const { id } = await submitWaitlistRequest(ownerDb, request("qa.rara@example.com"), "dental", {
      sourcePage: "<script>",
    })
    const [row] = await ownerDb
      .select()
      .from(saasWaitlistRequest)
      .where(eq(saasWaitlistRequest.id, id))
    expect(row?.sourcePage).toBeNull()
  })
})
