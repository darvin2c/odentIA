import { readFileSync } from "node:fs"
import { join } from "node:path"
import { saasAd, saasChat, saasClient } from "@odentia/db/schema/admin-arm"
import { adminAudit } from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import { and, eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import {
  chatAppOf,
  chatProductFromText,
  kairosChooseChatProduct,
  listAdsToTie,
  salesWhatsAppLink,
  salesWhatsAppText,
  setAdProduct,
  setChatProduct,
} from "./admin-chat-app.js"
import type { AdminActor } from "./admin-core.js"
import {
  getChat,
  type InboundChatInput,
  ingestInboundChat,
  kairosChatSignature,
} from "./admin-inbound-chat.js"
import { listInbox } from "./admin-inbox.js"
import { kairosChatContext, kairosClinicData } from "./kairos-sells.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

/** A1: un solo WhatsApp para todas las apps, y cada conversación sabe de cuál le hablan. */
describe("lo que dice el texto de un mensaje sobre la app", () => {
  it("el mensaje ya escrito de un enlace es «por el enlace»", () => {
    expect(chatProductFromText(salesWhatsAppText("medical"))).toEqual({
      product: "medical",
      source: "enlace",
    })
    expect(chatProductFromText("hola, quiero informacion de VISTIA!!")).toEqual({
      product: "optical",
      source: "enlace",
    })
    expect(chatProductFromText("Hola, quiero información de latidIA. ¿Cuánto cuesta?")).toEqual({
      product: "medical",
      source: "enlace",
    })
  })

  it("nombrar una sola app es «lo dijo»; dos o ninguna no dicen nada", () => {
    expect(chatProductFromText("¿odentIA tiene odontograma?")).toEqual({
      product: "dental",
      source: "lo_dijo",
    })
    expect(chatProductFromText("¿Cuál es mejor, odentIA o latidIA?")).toBeNull()
    expect(chatProductFromText("Tengo una óptica")).toBeNull()
    expect(chatProductFromText("")).toBeNull()
    expect(chatProductFromText(null)).toBeNull()
  })

  it("el enlace abre wa.me con su texto, y la web arma el mismo texto", () => {
    expect(salesWhatsAppLink("+51 987 654 321", "optical")).toBe(
      `https://wa.me/51987654321?text=${encodeURIComponent("Hola, quiero información de vistIA")}`,
    )
    // La web no importa los servicios: arma el texto ella misma y tiene que ser el mismo.
    const site = readFileSync(
      join(import.meta.dirname, "../../../apps/web/src/lib/site.ts"),
      "utf8",
    )
    expect(site).toContain("`Hola, quiero información de ${name}`")
    expect(salesWhatsAppText("dental")).toBe("Hola, quiero información de odentIA")
  })

  it("con cliente manda la app de su ficha, diga lo que diga la entrada", () => {
    expect(
      chatAppOf({ product: "optical", productSource: "anuncio" }, { product: "medical" }),
    ).toEqual({
      product: "medical",
      source: "cliente",
    })
    expect(chatAppOf({ product: null, productSource: null }, null)).toBeNull()
  })
})

setupTestDb()
const NOW = new Date()
const HOUR = 3_600_000
const admin: AdminActor = { userId: "ca-admin", role: "admin" }
const support: AdminActor = { userId: "ca-support", role: "support" }
let seq = 0

function message(overrides: Partial<InboundChatInput> = {}): InboundChatInput {
  seq += 1
  return {
    channel: "whatsapp",
    address: `+5195433${String(seq).padStart(4, "0")}`,
    waId: null,
    displayName: null,
    externalId: `wamid.${crypto.randomUUID()}`,
    body: "Hola, buenas",
    media: [],
    receivedAt: new Date(NOW.getTime() - HOUR),
    ...overrides,
  }
}

const ingest = (input: InboundChatInput) =>
  ownerDb.transaction((tx) => ingestInboundChat(tx, input, NOW))
const chatRow = async (id: string) => {
  const [row] = await ownerDb.select().from(saasChat).where(eq(saasChat.id, id)).limit(1)
  if (!row) throw new Error("sin conversación")
  return row
}

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: admin.userId, name: "Ada Lovelace", email: "ada@ca.test" },
    { id: support.userId, name: "Sofía Soporte", email: "sofia@ca.test" },
  ])
})

describe("la conversación sabe su app al entrar", () => {
  it("sin anuncio ni enlace no se sabe, y Kairós no recibe hechos ni precios", async () => {
    const { chatId } = await ingest(message({ body: "Hola, vi que hacen sistemas" }))
    expect(await chatRow(chatId)).toMatchObject({ product: null, productSource: null, adId: null })
    const context = await ownerDb.transaction((tx) => kairosChatContext(tx, chatId, NOW))
    expect(context.app).toBeNull()
    expect(context.sales).toBeNull()
    // Lo que firma Kairós sin saber la app es del grupo, no de una app.
    expect(kairosChatSignature(context.app)).toBe("— Kairós · Grupo Sallca")
  })

  it("el mensaje ya escrito del botón de una web la deja «por el enlace»", async () => {
    const { chatId } = await ingest(message({ body: salesWhatsAppText("optical") }))
    expect(await chatRow(chatId)).toMatchObject({ product: "optical", productSource: "enlace" })
    const context = await ownerDb.transaction((tx) => kairosChatContext(tx, chatId, NOW))
    expect(context.sales?.name).toBe("vistIA")
    expect(kairosChatSignature(context.app)).toBe("— Kairós · vistIA")
  })

  it("un anuncio nuevo queda por atar; al atarlo, sus conversaciones y las que vengan toman su app", async () => {
    const referral = {
      sourceId: "ad-120001",
      sourceType: "ad",
      headline: "Tu consultorio en orden",
      body: "Agenda y recetas",
    }
    const first = await ingest(message({ body: "Hola", referral }))
    const firstRow = await chatRow(first.chatId)
    expect(firstRow).toMatchObject({ product: null })
    expect(firstRow.adId).not.toBeNull()
    const pending = await ownerDb.transaction((tx) => listAdsToTie(tx, admin))
    const listed = pending.find((ad) => ad.sourceId === "ad-120001")
    expect(listed).toMatchObject({ headline: "Tu consultorio en orden", waiting: 1 })
    await expect(ownerDb.transaction((tx) => listAdsToTie(tx, support))).rejects.toMatchObject({
      status: 403,
    })
    await expect(
      ownerDb.transaction((tx) => setAdProduct(tx, support, listed?.id ?? "", "medical", NOW)),
    ).rejects.toMatchObject({ status: 403 })
    const tied = await ownerDb.transaction((tx) =>
      setAdProduct(tx, admin, listed?.id ?? "", "medical", NOW),
    )
    expect(tied).toEqual({ product: "medical", chats: 1 })
    expect(await chatRow(first.chatId)).toMatchObject({
      product: "medical",
      productSource: "anuncio",
    })
    // La siguiente que llega por ese anuncio nace con la app, aunque el texto nombre otra.
    const second = await ingest(
      message({ body: "¿Esto es odentIA?", referral: { sourceId: "ad-120001" } }),
    )
    expect(await chatRow(second.chatId)).toMatchObject({
      product: "medical",
      productSource: "anuncio",
    })
    expect(
      (await ownerDb.transaction((tx) => listAdsToTie(tx, admin))).some(
        (ad) => ad.sourceId === "ad-120001",
      ),
    ).toBe(false)
    const [audit] = await ownerDb
      .select()
      .from(adminAudit)
      .where(
        and(
          eq(adminAudit.action, "chat.ad_product_set"),
          eq(adminAudit.entityId, listed?.id ?? ""),
        ),
      )
    expect(audit?.actorUserId).toBe(admin.userId)
  })

  it("el anuncio no pisa la app que ya tiene la conversación, y solo WhatsApp lo lee", async () => {
    const [ad] = await ownerDb
      .insert(saasAd)
      .values({ sourceId: "ad-120002", product: "dental", decidedAt: NOW, decidedBy: admin.userId })
      .returning()
    const address = "+51954339999"
    const { chatId } = await ingest(message({ address, body: salesWhatsAppText("optical") }))
    await ingest(message({ address, body: "Hola", referral: { sourceId: "ad-120002" } }))
    expect(await chatRow(chatId)).toMatchObject({
      product: "optical",
      productSource: "enlace",
      adId: ad?.id,
    })
    const ig = await ingest(
      message({
        channel: "instagram",
        address: "ig-ca-1",
        body: "Hola",
        referral: { sourceId: "ad-120002" },
      }),
    )
    expect(await chatRow(ig.chatId)).toMatchObject({ product: null, adId: null })
  })

  it("un texto raro del anuncio no frena el mensaje: se recorta", async () => {
    const { chatId, duplicate } = await ingest(
      message({
        body: "Hola",
        referral: { sourceId: "ad-120003", headline: "x".repeat(900), body: "y".repeat(5000) },
      }),
    )
    expect(duplicate).toBe(false)
    const [ad] = await ownerDb.select().from(saasAd).where(eq(saasAd.sourceId, "ad-120003"))
    expect(ad?.headline).toHaveLength(300)
    expect(ad?.body).toHaveLength(2000)
    expect((await chatRow(chatId)).adId).toBe(ad?.id)
  })
})

describe("elegir la app a mano y cuando lo dice la persona", () => {
  it("Administración la elige en la conversación; Soporte no; con cliente manda su ficha", async () => {
    const { chatId } = await ingest(message())
    await expect(
      ownerDb.transaction((tx) => setChatProduct(tx, support, chatId, "optical", NOW)),
    ).rejects.toMatchObject({
      status: 403,
    })
    await expect(
      ownerDb.transaction((tx) => setChatProduct(tx, admin, chatId, "gestoria", NOW)),
    ).rejects.toMatchObject({
      status: 400,
    })
    expect(
      await ownerDb.transaction((tx) => setChatProduct(tx, admin, chatId, "optical", NOW)),
    ).toEqual({
      product: "optical",
      source: "persona",
    })
    const detail = await ownerDb.transaction((tx) => getChat(tx, admin, chatId, NOW))
    expect(detail.app).toEqual({ product: "optical", source: "persona" })
    expect(detail.replySignature).toBe("— Ada · vistIA")
    // Lo que eligió una persona no lo cambia Kairós.
    expect(
      await ownerDb.transaction((tx) => kairosChooseChatProduct(tx, chatId, "dental", NOW)),
    ).toEqual({
      product: "optical",
      source: "persona",
    })
    const [clientRow] = await ownerDb
      .insert(saasClient)
      .values({ name: "Consultorio Ficticio", product: "medical" })
      .returning({ id: saasClient.id })
    await ownerDb.update(saasChat).set({ clientId: clientRow?.id }).where(eq(saasChat.id, chatId))
    await expect(
      ownerDb.transaction((tx) => setChatProduct(tx, admin, chatId, "dental", NOW)),
    ).rejects.toMatchObject({
      status: 409,
    })
    const inbox = await ownerDb.transaction((tx) =>
      listInbox(tx, admin, { cliente: clientRow?.id }, NOW),
    )
    expect(inbox.items.find((item) => item.id === chatId)?.app).toEqual({
      product: "medical",
      source: "cliente",
    })
  })

  it("Kairós anota lo que dijo y registra la clínica con esa app; sin app no la registra", async () => {
    const { chatId } = await ingest(message({ body: "Hola, se llama Visión Clara" }))
    await expect(
      ownerDb.transaction((tx) =>
        kairosClinicData(tx, chatId, { clinicName: "Visión Clara" }, NOW),
      ),
    ).rejects.toMatchObject({ status: 400 })
    expect(
      await ownerDb.transaction((tx) => kairosChooseChatProduct(tx, chatId, "optical", NOW)),
    ).toEqual({
      product: "optical",
      source: "lo_dijo",
    })
    const created = await ownerDb.transaction((tx) =>
      kairosClinicData(tx, chatId, { clinicName: "Visión Clara" }, NOW),
    )
    const [clientRow] = await ownerDb
      .select()
      .from(saasClient)
      .where(eq(saasClient.id, created.clientId))
    expect(clientRow?.product).toBe("optical")
    const inbox = await ownerDb.transaction((tx) =>
      listInbox(tx, admin, { cliente: created.clientId }, NOW),
    )
    expect(inbox.items.find((item) => item.id === chatId)?.app).toEqual({
      product: "optical",
      source: "cliente",
    })
  })
})
