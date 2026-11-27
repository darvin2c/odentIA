/**
 * La IA de fotos contra una base real, un token firmado como el de la cuenta, un almacenamiento en
 * memoria y un modelo controlado (nunca la red): qué ve el modelo, qué propuestas quedan y cuáles
 * se descartan, quién puede pedirlas y usarlas, que usar pasa por la operación de siempre con su
 * historial, el tope del día, lo que pasa si la IA falla, la carga (juntar fotos y «Crear») y las
 * reglas de la base.
 */

import { randomUUID } from "node:crypto"
import {
  aiLook,
  aiProposal,
  productColor,
  productEvent,
  productPhoto,
  store,
  storeMember,
} from "@gestoria/db"
import { startTestDb, type TestDb } from "@gestoria/db/testing"
import { and, eq, sql } from "drizzle-orm"
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose"
import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { SOFI_ACTOR, withAgent } from "./agente.js"
import { createApp } from "./app.js"
import { memoryStorage } from "./archivos.js"
import { type ChatRequest, ModelError, type ModelReply, scriptedModel } from "./sofi/modelo.js"

const ACCOUNT = "https://api.gestoria.test"
const WEB = "https://app.gestoria.test"

let db: TestDb
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]
let jwk: JWK
let app: ReturnType<typeof createApp>
let tight: ReturnType<typeof createApp>
const storage = memoryStorage()
const steps: ((request: ChatRequest) => Partial<ModelReply>)[] = []
const model = scriptedModel(steps, "gpt-6-luna")

const people = {
  rosa: { id: "u-rosa", email: "rosa@calzados.test", name: "Rosa Quispe" },
  lucia: { id: "u-lucia", email: "lucia@calzados.test", name: "Lucía Torres" },
}
type Who = keyof typeof people
const storeId = randomUUID()
const base = `/api/tiendas/${storeId}`

async function tokenFor(who: Who) {
  const p = people[who]
  const iat = Math.floor(Date.now() / 1000)
  return new SignJWT({ email: p.email, emailVerified: true, name: p.name, image: null })
    .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
    .setSubject(p.id)
    .setIssuer(ACCOUNT)
    .setAudience("gestoria")
    .setIssuedAt(iat)
    .setExpirationTime(iat + 900)
    .sign(privateKey)
}

async function call(
  who: Who,
  method: string,
  path: string,
  body?: unknown,
  raw?: { type: string; data: Uint8Array },
  on = app,
) {
  const headers: Record<string, string> = {
    origin: WEB,
    authorization: `Bearer ${await tokenFor(who)}`,
    "content-type": raw?.type ?? "application/json",
  }
  const response = await on.request(`https://servidor.gestoria.test${path}`, {
    method,
    headers,
    ...(raw ? { body: raw.data } : body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  // biome-ignore lint/suspicious/noExplicitAny: las pruebas leen respuestas JSON de forma libre
  let json: Record<string, any> = {}
  try {
    json = text ? JSON.parse(text) : {}
  } catch {}
  return { status: response.status, json }
}

const jpeg = async (r: number, g: number, b: number) =>
  new Uint8Array(
    await sharp({ create: { width: 600, height: 600, channels: 3, background: { r, g, b } } })
      .jpeg()
      .toBuffer(),
  )

/** Lo que respondería el modelo al mirar un producto, con lo que cada prueba cambia. */
function lookReply(over: Record<string, unknown> = {}) {
  return {
    content: JSON.stringify({
      mismo_producto: true,
      aviso: null,
      leido: [],
      nombre: { valor: "Zapatilla de lona", porque: "Se ve en la foto 1" },
      categoria: { valor: "Zapatillas", porque: "Por la forma" },
      rubro: null,
      colores: [{ nombre: "Negra", hex: "#1F1F1F", hex2: null, fotos: [1, 2], porque: "Foto 1" }],
      datos: [
        { clave: "material", valor: "lona", de: "foto", porque: "Se ve la trama" },
        // Cómo calza no se ve en una foto: se descarta y se pregunta.
        { clave: "horma", valor: "Normal", de: "foto", porque: "Parece" },
        { clave: "talla", valor: "38", de: "foto", porque: "?" },
      ],
      palabras: ["zapatilla", "lona", "negra", "cómoda"],
      descripcion: "Zapatilla negra de lona, con pasadores blancos.",
      ...over,
    }),
    usage: { input: 2000, cached: 0, output: 300 },
  }
}

let zapatilla = ""
let fotos: string[] = []

beforeAll(async () => {
  db = await startTestDb()
  const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
  privateKey = pair.privateKey
  jwk = { ...(await exportJWK(pair.publicKey)), alg: "EdDSA", kid: "k1" }
  const deps = {
    appDb: db.appDb,
    ownerDb: db.ownerDb,
    account: { url: ACCOUNT, eventsSecret: "", keys: createLocalJWKSet({ keys: [jwk] }) },
    webURL: WEB,
    storage,
    photosModel: model,
  }
  app = createApp({ ...deps, photosCapPerDay: 50 })
  tight = createApp({ ...deps, photosCapPerDay: 2 })
  for (const who of Object.keys(people) as Who[]) await call(who, "GET", "/api/yo")
  await db.ownerDb
    .insert(store)
    .values({ id: storeId, name: "Calzados Rosa", currency: "PEN", createdBy: "u-rosa" })
  await db.ownerDb.insert(storeMember).values([
    { storeId, userId: "u-rosa", role: "owner" },
    { storeId, userId: "u-lucia", role: "sales", addedBy: "u-rosa" },
  ])
  const created = await call("rosa", "POST", `${base}/productos`, {
    name: "Zapatilla",
    listPriceCents: 12900,
    options: [{ name: "Talla", values: ["38", "39"] }],
  })
  zapatilla = created.json.product.id
  await call("rosa", "PATCH", `${base}/productos/${zapatilla}`, { rubro: "calzado" })
  fotos = []
  for (const color of [[30, 30, 30] as const, [40, 40, 40] as const]) {
    const up = await call("rosa", "POST", `${base}/productos/${zapatilla}/fotos`, undefined, {
      type: "image/jpeg",
      data: await jpeg(color[0], color[1], color[2]),
    })
    fotos.push(up.json.photo.id)
  }
})

afterAll(async () => {
  await db?.stop()
})

describe("la IA mira las fotos de un producto y propone", () => {
  it("quien vende ve, pero no pide ni usa; quien cambia el catálogo pide", async () => {
    expect((await call("lucia", "POST", `${base}/productos/${zapatilla}/ia`)).status).toBe(403)
    const seen = await call("lucia", "GET", `${base}/productos/${zapatilla}/ia`)
    expect(seen.status).toBe(200)
    expect(seen.json).toMatchObject({ proposals: [], canDecide: false })
    expect(seen.json.cap).toMatchObject({ available: true, used: 0, cap: 50, left: 50 })
  })

  it("propone solo lo que pasa la revisión y pregunta lo que no se ve; nunca el precio", async () => {
    steps.push(() => lookReply())
    const asked = await call("rosa", "POST", `${base}/productos/${zapatilla}/ia`)
    expect(asked.status).toBe(200)
    // Lo que vio el modelo: las reglas como mensaje de sistema y las fotos, sin la tienda.
    const request = model.requests.at(-1)!
    expect(request.messages[0]).toMatchObject({ role: "system" })
    expect(String(request.messages[0]!.content)).toContain("Nunca propones el precio")
    const parts = request.messages[1]!.content as { type: string }[]
    expect(parts.filter((p) => p.type === "image_url")).toHaveLength(2)
    expect(request.responseFormat?.json_schema.strict).toBe(true)
    expect(JSON.stringify(request.messages)).not.toContain("12900")

    const byField = Object.fromEntries(
      asked.json.proposals.map((p: { field: string; value: unknown }) => [p.field, p.value]),
    )
    expect(byField).toMatchObject({
      nombre: "Zapatilla de lona",
      categoria: "Zapatillas",
      "dato:material": "Lona",
      color: { name: "negra", hex: "#1f1f1f", hex2: null, photos: fotos },
      palabras: ["zapatilla", "lona", "negra"],
      descripcion: "Zapatilla negra de lona, con pasadores blancos.",
      "pregunta:horma": null,
    })
    // Lo que no se ve no se propone: ni cómo calza, ni un dato que no está en la plantilla.
    expect(byField).not.toHaveProperty("dato:horma")
    expect(byField).not.toHaveProperty("dato:talla")
    expect(byField).not.toHaveProperty("precio")
    const pregunta = asked.json.proposals.find(
      (p: { field: string }) => p.field === "pregunta:horma",
    )
    expect(pregunta.reason).toBe("¿Cómo calza? No se ve en las fotos.")
    // El costo y lo que miró quedan anotados.
    const [look] = await db.ownerDb.select().from(aiLook).where(eq(aiLook.productId, zapatilla))
    expect(look).toMatchObject({
      state: "lista",
      photos: 2,
      model: "gpt-6-luna",
      inputTokens: 2000,
      outputTokens: 300,
      costMicros: 350,
      requestedBy: "u-rosa",
    })
    // Nada cambió en la ficha.
    const detail = (await call("rosa", "GET", `${base}/productos/${zapatilla}`)).json.product
    expect(detail).toMatchObject({ name: "Zapatilla", rubroData: {}, keywords: [] })
  })

  const proposalOf = async (field: string) =>
    (await call("rosa", "GET", `${base}/productos/${zapatilla}/ia`)).json.proposals.find(
      (p: { field: string }) => p.field === field,
    ) as { id: string; value: unknown }

  it("usar pasa por la ficha, queda en su historial y a nombre de quien la usó", async () => {
    const nombre = await proposalOf("nombre")
    expect(
      (await call("lucia", "POST", `${base}/ia/propuestas/${nombre.id}/usar`, {})).status,
    ).toBe(403)
    const used = await call("rosa", "POST", `${base}/ia/propuestas/${nombre.id}/usar`, {})
    expect(used.status).toBe(200)
    expect(used.json.result.name).toBe("Zapatilla de lona")
    const [row] = await db.ownerDb.select().from(aiProposal).where(eq(aiProposal.id, nombre.id))
    expect(row).toMatchObject({ state: "usada", decidedBy: "u-rosa", appliedValue: null })
    const events = await db.ownerDb
      .select()
      .from(productEvent)
      .where(eq(productEvent.productId, zapatilla))
    expect(events.at(-1)).toMatchObject({
      action: "cambiado",
      reason: "Propuesta de la IA",
      changes: [{ field: "name", from: "Zapatilla", to: "Zapatilla de lona" }],
    })
    // Una ya decidida no se vuelve a usar.
    const again = await call("rosa", "POST", `${base}/ia/propuestas/${nombre.id}/usar`, {})
    expect(again.status).toBe(409)
  })

  it("«Cambiar» guarda lo que eligió la persona, con la regla de la plantilla", async () => {
    const material = await proposalOf("dato:material")
    const bad = await call("rosa", "POST", `${base}/ia/propuestas/${material.id}/usar`, {
      value: "Plástico",
    })
    expect(bad.status).toBe(400)
    const changed = await call("rosa", "POST", `${base}/ia/propuestas/${material.id}/usar`, {
      value: "Sintético",
    })
    expect(changed.status).toBe(200)
    expect(changed.json.result.rubroData).toMatchObject({ material: "Sintético" })
    const [row] = await db.ownerDb.select().from(aiProposal).where(eq(aiProposal.id, material.id))
    expect(row).toMatchObject({ state: "cambiada", appliedValue: "Sintético" })
  })

  it("el color se usa con «Tallas y stock»: su hex, su foto y las fotos de ese color", async () => {
    const color = await proposalOf("color")
    const used = await call("rosa", "POST", `${base}/ia/propuestas/${color.id}/usar`, {})
    expect(used.status).toBe(200)
    expect(used.json.result.options).toEqual([
      { name: "Color", values: ["negra"] },
      { name: "Talla", values: ["38", "39"] },
    ])
    const [look] = await db.ownerDb
      .select()
      .from(productColor)
      .where(eq(productColor.productId, zapatilla))
    expect(look).toMatchObject({ value: "negra", hex: "#1f1f1f", photoId: fotos[0] })
    const photos = await db.ownerDb
      .select({ colorId: productPhoto.colorId })
      .from(productPhoto)
      .where(eq(productPhoto.productId, zapatilla))
    expect(photos.every((p) => p.colorId === look!.id)).toBe(true)
  })

  it("una pregunta se responde al usarla; descartar no cambia nada", async () => {
    const pregunta = await proposalOf("pregunta:horma")
    expect(
      (await call("rosa", "POST", `${base}/ia/propuestas/${pregunta.id}/usar`, {})).status,
    ).toBe(400)
    expect(
      (await call("rosa", "POST", `${base}/ia/propuestas/${pregunta.id}/usar`, { value: "  " }))
        .status,
    ).toBe(400)
    const answered = await call("rosa", "POST", `${base}/ia/propuestas/${pregunta.id}/usar`, {
      value: "Chico",
    })
    expect(answered.json.result.rubroData).toMatchObject({ horma: "Chico" })
    const palabras = await proposalOf("palabras")
    const dropped = await call("rosa", "POST", `${base}/ia/propuestas/${palabras.id}/descartar`)
    expect(dropped.json).toEqual({ id: palabras.id, state: "descartada" })
    const detail = (await call("rosa", "GET", `${base}/productos/${zapatilla}`)).json.product
    expect(detail.keywords).toEqual([])
  })

  it("«Aplicar todos» usa lo que espera y deja las preguntas", async () => {
    const all = await call("rosa", "POST", `${base}/productos/${zapatilla}/ia/aplicar-todos`)
    expect(all.status).toBe(200)
    expect(all.json).toMatchObject({ applied: 2, skipped: [] })
    expect(all.json.product).toMatchObject({
      category: "Zapatillas",
      description: "Zapatilla negra de lona, con pasadores blancos.",
    })
    const left = (await call("rosa", "GET", `${base}/productos/${zapatilla}/ia`)).json.proposals
    expect(left.every((p: { kind: string }) => p.kind === "pregunta")).toBe(true)
    // La pregunta por el material ya no está: el dato ya tiene valor.
    expect(left.map((p: { field: string }) => p.field)).not.toContain("pregunta:material")
  })

  it("descarta lo inventado: cifras que no se leen, cualidades, precio y materiales que se preguntan", async () => {
    steps.push(() =>
      lookReply({
        nombre: { valor: "Zapatilla 2750 a S/ 129", porque: "?" },
        datos: [],
        palabras: ["original"],
        descripcion: "Zapatilla de cuero, muy cómoda.",
        colores: [{ nombre: "roja", hex: "rojo", hex2: null, fotos: [9], porque: "?" }],
      }),
    )
    const asked = await call("rosa", "POST", `${base}/productos/${zapatilla}/ia`)
    expect(asked.status).toBe(200)
    const fields = asked.json.proposals.map((p: { field: string }) => p.field)
    expect(fields).not.toContain("nombre")
    expect(fields).not.toContain("descripcion")
    expect(fields).not.toContain("palabras")
    expect(fields).not.toContain("color")
  })

  it("si la IA falla se dice, y no cuenta para el tope", async () => {
    const before = (await call("rosa", "GET", `${base}/ia`)).json.cap.used
    steps.push(() => {
      throw new ModelError("El proveedor respondió 500", 500)
    })
    const failed = await call("rosa", "POST", `${base}/productos/${zapatilla}/ia`)
    expect(failed.status).toBe(502)
    expect(failed.json.error.message).toMatch(/La IA no respondió/)
    expect((await call("rosa", "GET", `${base}/ia`)).json.cap.used).toBe(before)
  })

  it("cualquier error al mirar cierra lo que miraba; una respuesta ilegible se paga y cuenta", async () => {
    const before = (await call("rosa", "GET", `${base}/ia`)).json.cap.used
    steps.push(() => {
      throw new TypeError("fetch failed")
    })
    const down = await call("rosa", "POST", `${base}/productos/${zapatilla}/ia`)
    expect(down.status).toBe(502)
    steps.push(() => ({ content: "{ no es json", usage: { input: 1500, cached: 0, output: 20 } }))
    const garbled = await call("rosa", "POST", `${base}/productos/${zapatilla}/ia`)
    expect(garbled.status).toBe(502)
    expect(garbled.json.error.message).toBe("La IA respondió algo que no se pudo leer")
    const looks = await db.ownerDb
      .select()
      .from(aiLook)
      .where(and(eq(aiLook.productId, zapatilla), eq(aiLook.state, "fallo")))
    expect(looks.some((l) => l.outputTokens === 20 && l.costMicros === 160)).toBe(true)
    expect(looks.every((l) => l.finishedAt)).toBe(true)
    expect((await call("rosa", "GET", `${base}/ia`)).json.cap.used).toBe(before + 2)
  })

  it("al llegar al tope del día la persona lo sabe y sigue a mano", async () => {
    const cap = (await call("rosa", "GET", `${base}/ia`, undefined, undefined, tight)).json.cap
    expect(cap).toMatchObject({ available: false, reason: "tope", left: 0 })
    expect(cap.message).toMatch(/Sigue cargando a mano/)
    const stopped = await call(
      "rosa",
      "POST",
      `${base}/productos/${zapatilla}/ia`,
      undefined,
      undefined,
      tight,
    )
    expect(stopped.status).toBe(409)
    expect(stopped.json.error.code).toBe("AI_UNAVAILABLE")
    // Cargar a mano sigue igual.
    const manual = await call(
      "rosa",
      "PATCH",
      `${base}/productos/${zapatilla}`,
      { name: "Zapatilla negra" },
      undefined,
      tight,
    )
    expect(manual.status).toBe(200)
  })

  it("mejorar un texto no suma datos", async () => {
    steps.push(() => ({ content: JSON.stringify({ texto: "Zapatilla negra de cuero, cómoda." }) }))
    const added = await call("rosa", "POST", `${base}/ia/mejorar-texto`, {
      text: "zapatilla negra bonita",
    })
    expect(added.json).toMatchObject({ text: null, unchanged: true })
    steps.push(() => ({ content: JSON.stringify({ texto: "Una zapatilla negra muy bonita." }) }))
    const better = await call("rosa", "POST", `${base}/ia/mejorar-texto`, {
      text: "zapatilla negra bonita",
    })
    expect(better.json).toMatchObject({ text: "Una zapatilla negra muy bonita.", unchanged: false })
  })
})

describe("«Cargar muchos» con la IA", () => {
  let loadId = ""
  const photo = async (r: number, g: number, b: number) => {
    const up = await call("rosa", "POST", `${base}/cargas/${loadId}/fotos`, undefined, {
      type: "image/jpeg",
      data: await jpeg(r, g, b),
    })
    return up.json.photo as { id: string; itemId: string }
  }

  it("propone juntar fotos sueltas y Rosa confirma", async () => {
    loadId = (await call("rosa", "POST", `${base}/cargas`)).json.load.id
    const a = await photo(10, 10, 10)
    const b = await photo(12, 12, 12)
    const c = await photo(200, 100, 100)
    steps.push((request) => {
      expect(
        (request.messages[1]!.content as { type: string }[]).filter((p) => p.type === "image_url"),
      ).toHaveLength(3)
      return {
        content: JSON.stringify({
          grupos: [
            { fotos: [1, 2], porque: "La misma zapatilla, de frente y de lado" },
            { fotos: [3], porque: "Sola" },
          ],
        }),
      }
    })
    const asked = await call("rosa", "POST", `${base}/cargas/${loadId}/ia/juntar`)
    expect(asked.status).toBe(200)
    expect(asked.json.proposals).toHaveLength(1)
    const juntar = asked.json.proposals[0]
    expect(juntar).toMatchObject({ field: "juntar", value: { photos: [a.id, b.id] } })
    const used = await call("rosa", "POST", `${base}/ia/propuestas/${juntar.id}/usar`, {})
    expect(used.status).toBe(200)
    const detail = (await call("rosa", "GET", `${base}/cargas/${loadId}`)).json
    expect(detail.items).toHaveLength(2)
    const joined = detail.items.find((i: { id: string }) => i.id === a.itemId)
    expect(joined.photos.map((p: { id: string }) => p.id)).toEqual([a.id, b.id])
    expect(c.itemId).not.toBe(a.itemId)
  })

  it("lo de la ficha espera a «Crear» y pasa al producto, con el color y sus fotos", async () => {
    const detail = (await call("rosa", "GET", `${base}/cargas/${loadId}`)).json
    const item = detail.items.find((i: { photos: unknown[] }) => i.photos.length === 2)
    const other = detail.items.find((i: { photos: unknown[] }) => i.photos.length === 1)
    await call("rosa", "PATCH", `${base}/cargas/${loadId}/productos/${other.id}`, {
      state: "quitado",
    })
    steps.push(() =>
      lookReply({
        nombre: { valor: "Zapatilla urbana", porque: "Foto 1" },
        rubro: { valor: "calzado", porque: "Es un zapato" },
      }),
    )
    const asked = await call("rosa", "POST", `${base}/cargas/${loadId}/productos/${item.id}/ia`)
    expect(asked.status).toBe(200)
    const mine = asked.json.proposals.filter((p: { itemId: string }) => p.itemId === item.id)
    const of = (field: string) => mine.find((p: { field: string }) => p.field === field)
    expect(of("rubro")).toMatchObject({ value: "calzado", waitsForProduct: true })
    expect(of("nombre")).toMatchObject({ waitsForProduct: false })
    // Lo que es de la ficha no se usa en la carga.
    const early = await call("rosa", "POST", `${base}/ia/propuestas/${of("rubro").id}/usar`, {})
    expect(early.status).toBe(409)
    const all = await call(
      "rosa",
      "POST",
      `${base}/cargas/${loadId}/productos/${item.id}/ia/aplicar-todos`,
    )
    expect(all.json.applied).toBe(4)
    const after = (await call("rosa", "GET", `${base}/cargas/${loadId}`)).json.items.find(
      (i: { id: string }) => i.id === item.id,
    )
    expect(after).toMatchObject({ name: "Zapatilla urbana", colors: ["negra"] })
    // Pedir otra vez y usar el mismo color no lo repite al crear.
    steps.push(() => lookReply({ rubro: { valor: "calzado", porque: "Es un zapato" } }))
    const again = await call("rosa", "POST", `${base}/cargas/${loadId}/productos/${item.id}/ia`)
    const color = again.json.proposals.find(
      (p: { field: string; itemId: string }) => p.field === "color" && p.itemId === item.id,
    )
    expect((await call("rosa", "POST", `${base}/ia/propuestas/${color.id}/usar`, {})).status).toBe(
      200,
    )

    await call("rosa", "PATCH", `${base}/cargas/${loadId}/productos/${item.id}`, {
      listPriceCents: 9900,
    })
    const created = await call("rosa", "POST", `${base}/cargas/${loadId}/crear`)
    expect(created.status).toBe(200)
    const productId = created.json.productIds[0]
    const carried = (await call("rosa", "GET", `${base}/productos/${productId}/ia`)).json
    const fields = carried.proposals.map((p: { field: string }) => p.field).sort()
    expect(fields).toEqual(
      expect.arrayContaining(["dato:material", "palabras", "pregunta:horma", "rubro"]),
    )
    // El rubro y su dato se usan juntos.
    const material = carried.proposals.find((p: { field: string }) => p.field === "dato:material")
    const used = await call("rosa", "POST", `${base}/ia/propuestas/${material.id}/usar`, {})
    expect(used.json.result).toMatchObject({ rubro: "calzado", rubroData: { material: "Lona" } })
    const [look] = await db.ownerDb
      .select()
      .from(productColor)
      .where(eq(productColor.productId, productId))
    expect(look).toMatchObject({ value: "negra", hex: "#1f1f1f" })
    const photos = await db.ownerDb
      .select({ id: productPhoto.id, colorId: productPhoto.colorId })
      .from(productPhoto)
      .where(eq(productPhoto.productId, productId))
    expect(photos).toHaveLength(2)
    expect(photos.every((p) => p.colorId === look!.id)).toBe(true)
    expect(photos.map((p) => p.id)).toContain(look!.photoId)
  })
})

describe("las reglas de la base", () => {
  it("Sofi no ve ni escribe propuestas", async () => {
    const seen = await withAgent(db.appDb, SOFI_ACTOR, storeId, (tx) =>
      tx.select().from(aiProposal),
    )
    expect(seen).toEqual([])
    const [look] = await db.ownerDb.select().from(aiLook).limit(1)
    await expect(
      withAgent(db.appDb, SOFI_ACTOR, storeId, (tx) =>
        tx.insert(aiProposal).values({
          storeId,
          lookId: look!.id,
          productId: zapatilla,
          field: "nombre",
          value: "Otro",
          reason: "x",
          createdBy: SOFI_ACTOR,
          createdAt: sql`now()`,
        }),
      ),
    ).rejects.toThrow()
  })

  it("una propuesta decidida no cambia más, ni se decide a nombre de otro", async () => {
    const [decided] = await db.ownerDb
      .select()
      .from(aiProposal)
      .where(and(eq(aiProposal.productId, zapatilla), eq(aiProposal.state, "usada")))
      .limit(1)
    const { withPerson } = await import("@gestoria/db")
    const person = { userId: "u-rosa", email: "rosa@calzados.test", storeId }
    const changed = await withPerson(db.appDb, person, (tx) =>
      tx
        .update(aiProposal)
        .set({ state: "descartada" })
        .where(eq(aiProposal.id, decided!.id))
        .returning({ id: aiProposal.id }),
    )
    expect(changed).toEqual([])
    const [open] = await db.ownerDb
      .select()
      .from(aiProposal)
      .where(and(eq(aiProposal.productId, zapatilla), eq(aiProposal.state, "propuesta")))
      .limit(1)
    await expect(
      withPerson(db.appDb, person, (tx) =>
        tx
          .update(aiProposal)
          .set({ state: "usada", decidedBy: "u-lucia", decidedAt: sql`now()` })
          .where(eq(aiProposal.id, open!.id)),
      ),
    ).rejects.toThrow()
  })
})
