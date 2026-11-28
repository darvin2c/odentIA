/**
 * La ficha del producto (lienzo «La ficha del producto»), contra una base real y un token firmado
 * como el de la cuenta: la plantilla de cada rubro, los datos del rubro y qué tan lista está para
 * Sofi, la cuadrícula de tallas y colores en el kardex, los códigos, lo que Sofi no supo, el
 * historial y el precio (revendedora, promoción por color, liquidación, combo, ofertas de Sofi y el
 * simulador), con lo que puede cada rol.
 */
import { randomUUID } from "node:crypto"
import { conversation, store, storeMember } from "@gestoria/db"
import { startTestDb, type TestDb } from "@gestoria/db/testing"
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { SOFI_ACTOR, withAgent } from "./agente.js"
import { createApp } from "./app.js"
import { isGtin } from "./catalogo.js"
import { quoteOrderIn } from "./pedidos.js"
import { addQuestionIn } from "./preguntas.js"

const ACCOUNT = "https://api.gestoria.test"
const WEB = "https://app.gestoria.test"

let db: TestDb
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]
let jwk: JWK
let app: ReturnType<typeof createApp>

const people = {
  rosa: { id: "u-rosa", email: "rosa@calzados.test", name: "Rosa Quispe" },
  mario: { id: "u-mario", email: "mario@calzados.test", name: "Mario Huamán" },
  lucia: { id: "u-lucia", email: "lucia@calzados.test", name: "Lucía Torres" },
}
type Who = keyof typeof people
const storeId = randomUUID()
const base = `/api/tiendas/${storeId}`
let deliveryId = ""
let paymentId = ""

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

// biome-ignore lint/suspicious/noExplicitAny: las pruebas leen respuestas JSON de forma libre
async function call(
  who: Who,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, any> }> {
  const response = await app.request(`https://servidor.gestoria.test${path}`, {
    method,
    headers: {
      origin: WEB,
      authorization: `Bearer ${await tokenFor(who)}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, json: text ? JSON.parse(text) : {} }
}

beforeAll(async () => {
  db = await startTestDb()
  const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
  privateKey = pair.privateKey
  jwk = { ...(await exportJWK(pair.publicKey)), alg: "EdDSA", kid: "k1" }
  app = createApp({
    appDb: db.appDb,
    ownerDb: db.ownerDb,
    account: { url: ACCOUNT, eventsSecret: "", keys: createLocalJWKSet({ keys: [jwk] }) },
    webURL: WEB,
  })
  for (const who of Object.keys(people) as Who[]) await call(who, "GET", "/api/yo")
  await db.ownerDb
    .insert(store)
    .values({ id: storeId, name: "Calzados Rosa", currency: "PEN", createdBy: "u-rosa" })
  await db.ownerDb.insert(storeMember).values([
    { storeId, userId: "u-rosa", role: "owner" },
    { storeId, userId: "u-mario", role: "admin", addedBy: "u-rosa" },
    { storeId, userId: "u-lucia", role: "sales", addedBy: "u-rosa" },
  ])
  const delivery = await call("rosa", "POST", `${base}/formas-de-entrega`, {
    name: "Reparto",
    type: "DeliveryModeOwnFleet",
    cost: "fijo",
    priceCents: 1000,
    maxDiscountCents: 1000,
  })
  deliveryId = delivery.json.method.id
  const payment = await call("rosa", "POST", `${base}/medios-de-pago`, {
    name: "Yape",
    typeCode: "68",
    collection: "comprobante",
  })
  paymentId = payment.json.method.id
})

afterAll(async () => {
  await db?.stop()
})

const newProduct = async (
  name: string,
  listPriceCents = 12900,
  minPriceCents: number | null = 9900,
) => {
  const created = await call("rosa", "POST", `${base}/productos`, {
    name,
    listPriceCents,
    minPriceCents,
  })
  expect(created.status).toBe(201)
  return created.json.product.id as string
}

const grid = (over: Record<string, unknown> = {}) => ({
  rows: {
    name: "Color",
    values: [
      { value: "blanca", hex: "#F2F0EA" },
      { value: "negra", hex: "#1f1f1f" },
    ],
  },
  columns: { name: "Talla", values: [{ value: "38" }, { value: "39" }] },
  cells: [
    { row: "blanca", column: "38", stock: 3, priceCents: null },
    { row: "blanca", column: "39", stock: 2, priceCents: null },
    { row: "negra", column: "38", stock: 2, priceCents: 11900 },
    { row: "negra", column: "39", stock: 0, priceCents: 11900 },
  ],
  ...over,
})

const quoteOf = (
  lines: { variantId: string; quantity: number; unitCents?: number | null }[],
  who: Who = "lucia",
) =>
  call(who, "POST", `${base}/pedidos/calcular`, {
    lines: lines.map((l) => ({ unitCents: null, ...l })),
    deliveryMethodId: deliveryId,
    paymentMethodId: paymentId,
  })

describe("la plantilla de cada rubro (decisión 1)", () => {
  it("trae los cinco rubros del prototipo; la tienda la ajusta y Ventas solo la ve", async () => {
    const seen = await call("lucia", "GET", `${base}/plantillas`)
    expect(seen.status).toBe(200)
    expect(seen.json.rubros.map((r: { id: string }) => r.id)).toEqual([
      "calzado",
      "ropa",
      "cosmetica",
      "tecnologia",
      "hogar",
    ])
    const tecnologia = seen.json.rubros.find((r: { id: string }) => r.id === "tecnologia")
    expect(tecnologia.fields.find((f: { key: string }) => f.key === "garantia")).toMatchObject({
      type: "opcion",
      needed: true,
    })
    const fields = [
      { key: "material", needed: true },
      { key: "horma", needed: true },
      { key: "plantilla", needed: true },
      { key: "limpia", needed: false },
      { label: "¿Es vegano?", type: "opcion", options: ["Sí", "No"], needed: false },
    ]
    expect((await call("lucia", "PATCH", `${base}/plantillas/calzado`, { fields })).status).toBe(
      403,
    )
    const saved = await call("mario", "PATCH", `${base}/plantillas/calzado`, { fields })
    expect(saved.status).toBe(200)
    // «ancho» no vino: se quitó. El orden es el de la tienda y el dato nuevo tiene su clave.
    expect(saved.json.template.fields.map((f: { key: string }) => f.key)).toEqual([
      "material",
      "horma",
      "plantilla",
      "limpia",
      "es_vegano",
    ])
    expect(saved.json.template.fields[2]).toMatchObject({
      label: "Largo de la plantilla",
      needed: true,
    })
  })
})

describe("los datos del rubro y qué tan lista está para Sofi (decisión 2)", () => {
  let id = ""
  it("se guardan contra la plantilla, con «No aplica»; lo que no está en ella no entra", async () => {
    id = await newProduct("Zapatilla de lona")
    const bad = await call("rosa", "PATCH", `${base}/productos/${id}`, {
      rubro: "calzado",
      rubroData: { material: "Plástico" },
    })
    expect(bad.status).toBe(400)
    expect(bad.json.error.fields["rubroData.material"]).toBeTruthy()
    expect(
      (
        await call("rosa", "PATCH", `${base}/productos/${id}`, {
          rubro: "calzado",
          rubroData: { ancho: "Una talla más" },
        })
      ).status,
    ).toBe(400)
    const ok = await call("rosa", "PATCH", `${base}/productos/${id}`, {
      rubro: "calzado",
      rubroData: {
        material: "lona",
        horma: "Normal",
        plantilla: { "38": 24 },
        es_vegano: { noAplica: true },
      },
      keywords: ["zapa", "Zapa", "tenis"],
      code: "ZAP-LONA",
      package: { weightG: 900, lengthMm: 320, widthMm: 200, heightMm: 120 },
      web: { visible: true, slug: "zapatilla-de-lona" },
    })
    expect(ok.status).toBe(200)
    const p = ok.json.product
    expect(p.rubroData).toEqual({
      material: "Lona",
      horma: "Normal",
      plantilla: { "38": 24 },
      es_vegano: { noAplica: true },
    })
    expect(p.keywords).toEqual(["zapa", "tenis"])
    // Le falta stock y fotos: dos de lo que Sofi necesita.
    expect(p.readiness.level).toBe("falta_poco")
    expect(
      p.readiness.items
        .filter((i: { ok: boolean; needed: boolean }) => i.needed && !i.ok)
        .map((i: { id: string }) => i.id),
    ).toEqual(["stock", "fotos"])
    expect(p.state).toBe("agotado")
  })

  it("el código del producto y su nombre en el link no se repiten en la tienda", async () => {
    const other = await newProduct("Botín")
    const code = await call("rosa", "PATCH", `${base}/productos/${other}`, { code: "zap-lona" })
    expect(code.status).toBe(409)
    expect(code.json.error.code).toBe("CODE_TAKEN")
    const slug = await call("rosa", "PATCH", `${base}/productos/${other}`, {
      web: { slug: "zapatilla-de-lona" },
    })
    expect(slug.json.error.code).toBe("SLUG_TAKEN")
  })

  it("el estado lo pone la tienda; disponible y agotado salen del stock", async () => {
    const encargo = await call("rosa", "PATCH", `${base}/productos/${id}`, {
      status: { kind: "encargo", days: 5 },
    })
    expect(encargo.json.product).toMatchObject({ state: "encargo", statusDays: 5 })
    // Por encargo se vende sin stock: Sofi y el equipo lo pueden anotar.
    expect(
      encargo.json.product.readiness.items.find((i: { id: string }) => i.id === "stock").ok,
    ).toBe(true)
    expect(
      (await call("rosa", "PATCH", `${base}/productos/${id}`, { status: { kind: "encargo" } }))
        .status,
    ).toBe(400)
    const back = await call("rosa", "PATCH", `${base}/productos/${id}`, { status: null })
    expect(back.json.product.state).toBe("agotado")
  })
})

describe("la cuadrícula de tallas y colores (decisión 6)", () => {
  let id = ""
  it("crea las variantes con sus colores y registra el stock como entradas del kardex", async () => {
    id = await newProduct("Zapatilla urbana")
    expect((await call("lucia", "POST", `${base}/productos/${id}/cuadricula`, grid())).status).toBe(
      403,
    )
    const saved = await call("rosa", "POST", `${base}/productos/${id}/cuadricula`, grid())
    expect(saved.status).toBe(200)
    expect(saved.json).toMatchObject({ entered: 7, lowered: 0, created: 4 })
    const p = saved.json.product
    expect(p.options).toEqual([
      { name: "Color", values: ["blanca", "negra"] },
      { name: "Talla", values: ["38", "39"] },
    ])
    expect(p.colorOption).toBe(0)
    expect(p.colors.map((c: { value: string; hex: string }) => [c.value, c.hex])).toEqual([
      ["blanca", "#f2f0ea"],
      ["negra", "#1f1f1f"],
    ])
    const negra38 = p.variants.find(
      (v: { optionValues: string[] }) => v.optionValues.join() === "negra,38",
    )
    expect(negra38).toMatchObject({ stock: 2, priceCents: 11900 })
    const kardex = await call("rosa", "GET", `${base}/variantes/${negra38.id}/kardex`)
    expect(kardex.json.movements).toMatchObject([{ kind: "entrada", quantity: 2, balance: 2 }])
  })

  it("un producto nuevo con una opción «Color» la tiene como su color, en el lugar que esté", async () => {
    const created = await call("rosa", "POST", `${base}/productos`, {
      name: "Botín con color",
      listPriceCents: 19900,
      options: [
        { name: "Talla", values: ["38"] },
        { name: "Color", values: ["marrón"] },
      ],
    })
    expect(created.status).toBe(201)
    const sheet = await call("rosa", "GET", `${base}/productos/${created.json.product.id}`)
    expect(sheet.json.product.colorOption).toBe(1)
    expect(sheet.json.product.colors).toMatchObject([{ value: "marrón", hex: null }])
  })

  it("el catálogo dice de cada producto sus colores, su estado y qué tan lista está para Sofi", async () => {
    const list = await call("lucia", "GET", `${base}/catalogo`)
    expect(list.status).toBe(200)
    const row = list.json.products.find((p: { id: string }) => p.id === id)
    expect(row).toMatchObject({
      colorOption: 0,
      colors: [
        { value: "blanca", hex: "#f2f0ea", hex2: null },
        { value: "negra", hex: "#1f1f1f", hex2: null },
      ],
      state: "disponible",
      stock: 7,
      soldOut: 1,
      variantCount: 4,
    })
    // La misma cuenta de la ficha: sin fotos de cada color, todavía no lo vende sola.
    const sheet = (await call("lucia", "GET", `${base}/productos/${id}`)).json.product
    expect(row.readiness).toEqual({
      level: sheet.readiness.level,
      sellsAlone: sheet.readiness.sellsAlone,
      complete: sheet.readiness.complete,
      done: sheet.readiness.done,
      total: sheet.readiness.total,
      neededMissing: sheet.readiness.items.filter(
        (i: { needed: boolean; ok: boolean }) => i.needed && !i.ok,
      ).length,
    })
    expect(row.readiness.sellsAlone).toBe(false)
  })

  it("con el stock que vio la pantalla, una venta de mientras tanto no se pisa: se suma lo cambiado", async () => {
    const own = await newProduct("Zapatilla vendida mientras tanto")
    await call("rosa", "POST", `${base}/productos/${own}/cuadricula`, grid())
    const variantOf = async (combo: string) =>
      (await call("rosa", "GET", `${base}/productos/${own}`)).json.product.variants.find(
        (v: { optionValues: string[] }) => v.optionValues.join() === combo,
      )
    // La pantalla vio la blanca 38 con 3 y la negra 38 con 2. Mientras edita, se vende una de
    // cada una (aquí, un ajuste del kardex: lo que importa es que el stock bajó por otro lado).
    for (const combo of ["blanca,38", "negra,38"]) {
      const v = await variantOf(combo)
      await call("rosa", "POST", `${base}/variantes/${v.id}/movimientos`, {
        kind: "ajuste",
        counted: v.stock - 1,
        reason: "Vendida en la tienda",
      })
    }
    // Sube la blanca 38 de 3 a 5 y deja la negra 38 como la vio (2): manda lo que vio.
    const seen = { "blanca,38": 3, "blanca,39": 2, "negra,38": 2, "negra,39": 0 }
    const saved = await call("rosa", "POST", `${base}/productos/${own}/cuadricula`, {
      ...grid(),
      cells: grid().cells.map((c) => {
        const key = `${c.row},${c.column}` as keyof typeof seen
        return { ...c, stock: key === "blanca,38" ? 5 : c.stock, seenStock: seen[key] }
      }),
    })
    expect(saved.status).toBe(200)
    // La blanca 38: lo vendido (3 → 2) más lo que subió la pantalla (+2) = 4, no 5.
    expect((await variantOf("blanca,38")).stock).toBe(4)
    // La negra 38 no la tocó: queda con lo vendido (1), no vuelve a 2.
    expect((await variantOf("negra,38")).stock).toBe(1)
    // Dice qué se vendió mientras tanto, para avisarlo en la pantalla.
    expect(saved.json.meanwhile).toEqual(
      expect.arrayContaining([
        { variant: "blanca · 38", seen: 3, now: 2 },
        { variant: "negra · 38", seen: 2, now: 1 },
      ]),
    )
    expect(saved.json).toMatchObject({ entered: 2, lowered: 0 })
  })

  it("bajar el stock pide motivo y queda como ajuste; cambiar un nombre no rehace la variante", async () => {
    const lower = grid({
      cells: grid().cells.map((c) =>
        c.row === "negra" && c.column === "38" ? { ...c, stock: 1 } : c,
      ),
    })
    const noReason = await call("rosa", "POST", `${base}/productos/${id}/cuadricula`, lower)
    expect(noReason.status).toBe(400)
    expect(noReason.json.error.fields.reason).toBeTruthy()
    const before = (await call("rosa", "GET", `${base}/productos/${id}`)).json.product
    const blanca38 = before.variants.find(
      (v: { optionValues: string[] }) => v.optionValues.join() === "blanca,38",
    )
    // «blanca» pasa a llamarse «crema», y la negra 38 baja a 1 con su motivo.
    const renamed = grid({
      rows: {
        name: "Color",
        values: [
          { was: "blanca", value: "crema", hex: "#efe6d8" },
          { value: "negra", hex: "#1f1f1f" },
        ],
      },
      cells: lower.cells.map((c) => (c.row === "blanca" ? { ...c, row: "crema" } : c)),
      reason: "par dañado",
    })
    const saved = await call("rosa", "POST", `${base}/productos/${id}/cuadricula`, renamed)
    expect(saved.status).toBe(200)
    expect(saved.json).toMatchObject({ entered: 0, lowered: 1, created: 0, removed: 0 })
    const crema38 = saved.json.product.variants.find(
      (v: { optionValues: string[] }) => v.optionValues.join() === "crema,38",
    )
    expect(crema38.id).toBe(blanca38.id)
    expect(crema38.stock).toBe(3)
    expect(saved.json.product.colors[0]).toMatchObject({ value: "crema", hex: "#efe6d8" })
    const negra38 = saved.json.product.variants.find(
      (v: { optionValues: string[] }) => v.optionValues.join() === "negra,38",
    )
    const kardex = await call("rosa", "GET", `${base}/variantes/${negra38.id}/kardex`)
    expect(kardex.json.movements[0]).toMatchObject({
      kind: "ajuste",
      quantity: -1,
      reason: "par dañado",
    })
  })

  it("cambiar dos colores de nombre entre sí no choca y cada uno conserva su hex", async () => {
    const swap = grid({
      rows: {
        name: "Color",
        values: [
          { was: "crema", value: "negra", hex: "#efe6d8" },
          { was: "negra", value: "crema", hex: "#1f1f1f" },
        ],
      },
      cells: grid().cells.map((c) => ({
        ...c,
        row: c.row === "blanca" ? "negra" : "crema",
        stock: c.row === "blanca" ? (c.column === "38" ? 3 : 2) : c.column === "38" ? 1 : 0,
      })),
    })
    const saved = await call("rosa", "POST", `${base}/productos/${id}/cuadricula`, swap)
    expect(saved.status).toBe(200)
    expect(saved.json).toMatchObject({ entered: 0, lowered: 0 })
    expect(
      saved.json.product.colors.map((c: { value: string; hex: string }) => [c.value, c.hex]),
    ).toEqual([
      ["negra", "#efe6d8"],
      ["crema", "#1f1f1f"],
    ])
    // Y vuelven a su nombre.
    const back = await call("rosa", "POST", `${base}/productos/${id}/cuadricula`, {
      ...swap,
      rows: {
        name: "Color",
        values: [
          { was: "negra", value: "crema", hex: "#efe6d8" },
          { was: "crema", value: "negra", hex: "#1f1f1f" },
        ],
      },
      cells: swap.cells.map((c) => ({ ...c, row: c.row === "negra" ? "crema" : "negra" })),
    })
    expect(back.status).toBe(200)
  })

  it("quitar un color con stock lo baja a 0 con el motivo y lo quita", async () => {
    const onlyCrema = {
      rows: { name: "Color", values: [{ value: "crema", hex: "#efe6d8" }] },
      columns: { name: "Talla", values: [{ value: "38" }, { value: "39" }] },
      cells: [
        { row: "crema", column: "38", stock: 3, priceCents: null },
        { row: "crema", column: "39", stock: 2, priceCents: null },
      ],
    }
    expect(
      (await call("rosa", "POST", `${base}/productos/${id}/cuadricula`, onlyCrema)).status,
    ).toBe(400)
    const saved = await call("rosa", "POST", `${base}/productos/${id}/cuadricula`, {
      ...onlyCrema,
      reason: "Ya no la traemos",
    })
    expect(saved.json).toMatchObject({ removed: 2, lowered: 1 })
    expect(saved.json.product.colors.map((c: { value: string }) => c.value)).toEqual(["crema"])
  })

  it("el código de barras es un GTIN con su dígito verificador y no se repite", async () => {
    expect(isGtin("7751234567898")).toBe(false)
    const valid = ["7750000000007", "96385074"].filter(isGtin)
    expect(valid).toHaveLength(2)
    const p = (await call("rosa", "GET", `${base}/productos/${id}`)).json.product
    const [a, b] = p.variants
    expect(
      (await call("rosa", "PATCH", `${base}/variantes/${a.id}`, { barcode: "7750000000003" }))
        .status,
    ).toBe(400)
    expect(
      (await call("rosa", "PATCH", `${base}/variantes/${a.id}`, { barcode: "775-0000-000007" }))
        .status,
    ).toBe(200)
    const taken = await call("rosa", "PATCH", `${base}/variantes/${b.id}`, {
      barcode: "7750000000007",
    })
    expect(taken.json.error.code).toBe("BARCODE_TAKEN")
  })

  it("cada cambio queda en el historial con quién; el costo solo lo ve quien ve costos", async () => {
    await call("rosa", "POST", `${base}/productos/${id}/cuadricula`, {
      rows: { name: "Color", values: [{ value: "crema", hex: "#efe6d8" }] },
      columns: { name: "Talla", values: [{ value: "38" }, { value: "39" }] },
      cells: [
        { row: "crema", column: "38", stock: 5, priceCents: null },
        { row: "crema", column: "39", stock: 2, priceCents: null },
      ],
      unitCostCents: 6800,
    })
    const owner = await call("rosa", "GET", `${base}/productos/${id}/historial`)
    expect(owner.json.events[0]).toMatchObject({ action: "cuadricula", actorName: "Rosa Quispe" })
    expect(owner.json.events[0].changes).toContainEqual({
      field: "unitCostCents",
      from: null,
      to: 6800,
    })
    expect(owner.json.events.at(-1).action).toBe("creado")
    const sales = await call("lucia", "GET", `${base}/productos/${id}/historial`)
    expect(
      sales.json.events[0].changes.some((c: { field: string }) => c.field === "unitCostCents"),
    ).toBe(false)
  })
})

describe("lo que Sofi no supo (decisión 11)", () => {
  let id = ""
  let questionId = ""
  it("Sofi la anota; Ventas responde y propone guardarla; el Dueño la guarda en la ficha", async () => {
    id = await newProduct("Sandalia")
    const [chat] = await db.ownerDb
      .insert(conversation)
      .values({ storeId, channel: "prueba", createdBy: "u-rosa" })
      .returning({ id: conversation.id })
    const asked = await withAgent(db.appDb, SOFI_ACTOR, storeId, (tx) =>
      addQuestionIn(tx, storeId, SOFI_ACTOR, {
        productId: id,
        conversationId: chat!.id,
        question: "¿Destiñe al lavarla?",
      }),
    )
    questionId = asked.id
    const open = await call("lucia", "GET", `${base}/preguntas`)
    expect(open.json.questions).toMatchObject([
      { question: "¿Destiñe al lavarla?", askedBy: "Sofi" },
    ])
    const proposed = await call("lucia", "POST", `${base}/preguntas/${questionId}/respuesta`, {
      answer: "No destiñe. Lávala a mano.",
      save: true,
    })
    expect(proposed.status).toBe(200)
    expect(proposed.json.product.questions[0]).toMatchObject({
      saveRequested: true,
      savedAt: null,
      answeredBy: "Lucía Torres",
    })
    // Ventas no ve lo que costó.
    expect(proposed.json.product.lastCostCents).toBeNull()
    expect(
      (await call("lucia", "POST", `${base}/preguntas/${questionId}/guardar`, {})).status,
    ).toBe(403)
    const saved = await call("rosa", "POST", `${base}/preguntas/${questionId}/guardar`, {
      answer: "No destiñe. Lávala a mano con agua fría.",
    })
    expect(saved.json.product.questions[0]).toMatchObject({
      saveRequested: false,
      savedBy: "Rosa Quispe",
      answer: "No destiñe. Lávala a mano con agua fría.",
    })
    // Ya guardada, Ventas no la cambia.
    expect(
      (await call("lucia", "POST", `${base}/preguntas/${questionId}/respuesta`, { answer: "Sí" }))
        .status,
    ).toBe(403)
    expect((await call("lucia", "GET", `${base}/preguntas`)).json.questions).toEqual([])
  })

  it("el Dueño la saca de la ficha o anota una que ya sabe", async () => {
    const removed = await call("rosa", "POST", `${base}/preguntas/${questionId}/quitar`)
    expect(removed.json.product.questions[0].savedAt).toBeNull()
    const added = await call("rosa", "POST", `${base}/productos/${id}/preguntas`, {
      question: "¿Es impermeable?",
      answer: "No. Es de lona.",
    })
    expect(added.status).toBe(201)
    expect(added.json.product.questions[0]).toMatchObject({
      question: "¿Es impermeable?",
      savedBy: "Rosa Quispe",
    })
    expect(
      (
        await call("lucia", "POST", `${base}/productos/${id}/preguntas`, {
          question: "¿Pesa?",
          answer: "Poco",
        })
      ).status,
    ).toBe(403)
  })
})

describe("el precio de la ficha (dinero)", () => {
  let id = ""
  let variants: { id: string; optionValues: string[] }[] = []
  const variant = (values: string) => variants.find((v) => v.optionValues.join() === values)!.id

  it("la promoción de un color baja solo ese color; la de toda la talla, esa talla", async () => {
    id = await newProduct("Zapatilla promo")
    const saved = await call(
      "rosa",
      "POST",
      `${base}/productos/${id}/cuadricula`,
      grid({
        cells: grid().cells.map((c) => ({ ...c, stock: 10, priceCents: null })),
      }),
    )
    variants = saved.json.product.variants
    const today = new Date().toISOString().slice(0, 10)
    const promo = await call("rosa", "PATCH", `${base}/productos/${id}`, {
      promotions: [
        {
          name: "Negra",
          percentOff: 30,
          startsOn: "2020-01-01",
          endsOn: "2099-12-31",
          scope: { optionIndex: 0, optionValue: "NEGRA" },
        },
        {
          name: "Talla 39",
          percentOff: 10,
          startsOn: "2020-01-01",
          endsOn: "2099-12-31",
          scope: { optionIndex: 1, optionValue: "39" },
        },
      ],
    })
    expect(promo.status).toBe(200)
    expect(promo.json.product.promotions[0].scope).toEqual({ optionIndex: 0, optionValue: "negra" })
    const negra = await quoteOf([{ variantId: variant("negra,38"), quantity: 1 }])
    expect(negra.json.quote.lines[0].autoUnitCents).toBe(9030)
    const blanca39 = await quoteOf([{ variantId: variant("blanca,39"), quantity: 1 }])
    expect(blanca39.json.quote.lines[0].autoUnitCents).toBe(11610)
    // La negra 39 tiene las dos: va la mejor, sin sumar.
    const negra39 = await quoteOf([{ variantId: variant("negra,39"), quantity: 1 }])
    expect(negra39.json.quote.lines[0].autoUnitCents).toBe(9030)
    // Una promoción de un color que no está no se guarda.
    const missing = await call("rosa", "PATCH", `${base}/productos/${id}`, {
      promotions: [
        {
          name: "Roja",
          percentOff: 10,
          startsOn: today,
          endsOn: today,
          scope: { optionIndex: 0, optionValue: "roja" },
        },
      ],
    })
    expect(missing.status).toBe(400)
  })

  it("la revendedora paga el por mayor desde sus unidades", async () => {
    const set = await call("rosa", "PATCH", `${base}/productos/${id}`, {
      promotions: [],
      wholesale: { minQuantity: 6, unitPriceCents: 8500 },
    })
    expect(set.json.product.wholesale).toEqual({ minQuantity: 6, unitPriceCents: 8500 })
    expect(
      (
        await call("rosa", "PATCH", `${base}/productos/${id}`, {
          wholesale: { minQuantity: 6, unitPriceCents: 13000 },
        })
      ).status,
    ).toBe(400)
    const five = await quoteOf([{ variantId: variant("blanca,38"), quantity: 5 }])
    expect(five.json.quote.lines[0].autoUnitCents).toBe(12900)
    const six = await quoteOf([
      { variantId: variant("blanca,38"), quantity: 3 },
      { variantId: variant("negra,38"), quantity: 3 },
    ])
    expect(six.json.quote.lines.map((l: { autoUnitCents: number }) => l.autoUnitCents)).toEqual([
      8500, 8500,
    ])
  })

  it("en liquidación no se negocia; lo que ya no se vende no entra a un pedido", async () => {
    await call("rosa", "PATCH", `${base}/productos/${id}`, {
      wholesale: null,
      status: { kind: "liquidacion" },
    })
    const haggle = await quoteOf([
      { variantId: variant("blanca,38"), quantity: 1, unitCents: 11000 },
    ])
    expect(haggle.json.fields["lines.0.unitCents"]).toMatch(/No se negocia/)
    await call("rosa", "PATCH", `${base}/productos/${id}`, { status: { kind: "no_se_vende" } })
    const gone = await quoteOf([{ variantId: variant("blanca,38"), quantity: 1 }])
    expect(gone.json.fields["lines.0.variantId"]).toBe("Ese producto ya no se vende")
    await call("rosa", "PATCH", `${base}/productos/${id}`, { status: null })
  })

  it("lo que combina baja su combo si va junto", async () => {
    const medias = await newProduct("Medias", 2000, null)
    const mediasVariant = (await call("rosa", "GET", `${base}/productos/${medias}`)).json.product
      .variants[0].id
    await call("rosa", "POST", `${base}/variantes/${mediasVariant}/movimientos`, {
      kind: "entrada",
      quantity: 5,
    })
    await call("rosa", "PATCH", `${base}/productos/${id}`, {
      comboPercentOff: 10,
      links: [{ productId: medias, kind: "combina" }],
    })
    const alone = await quoteOf([{ variantId: mediasVariant, quantity: 1 }])
    expect(alone.json.quote.lines[0].autoUnitCents).toBe(2000)
    const together = await quoteOf([
      { variantId: variant("blanca,38"), quantity: 1 },
      { variantId: mediasVariant, quantity: 1 },
    ])
    expect(
      together.json.quote.lines.map((l: { autoUnitCents: number }) => l.autoUnitCents),
    ).toEqual([12900, 1800])
  })

  it("Sofi solo cede lo que el producto deja ofrecer; el equipo, como siempre", async () => {
    await call("rosa", "PATCH", `${base}/productos/${id}`, {
      offers: { discount: false, delivery: false },
    })
    const input = {
      customerId: null,
      customerName: "",
      customerPhone: null,
      channel: "otro" as const,
      address: "",
      notes: "",
      lines: [{ variantId: variant("blanca,38"), quantity: 1, unitCents: 11000, gift: false }],
      deliveryMethodId: deliveryId,
      zone: null,
      deliveryListCents: null,
      deliveryCents: null,
      paymentMethodId: paymentId,
      deliverOn: null,
    }
    const today = new Date().toISOString().slice(0, 10)
    const team = await quoteOf(
      [{ variantId: variant("blanca,38"), quantity: 1, unitCents: 11000 }],
      "rosa",
    )
    expect(team.json.quote).toBeTruthy()
    const sofi = await withAgent(db.appDb, SOFI_ACTOR, storeId, (tx) =>
      quoteOrderIn(tx, storeId, input, today, { byAgent: true }),
    )
    expect(sofi.fields["lines.0.unitCents"]).toMatch(/no se ofrece rebaja/)
    const delivery = await withAgent(db.appDb, SOFI_ACTOR, storeId, (tx) =>
      quoteOrderIn(
        tx,
        storeId,
        { ...input, lines: [{ ...input.lines[0]!, unitCents: null }], deliveryCents: 0 },
        today,
        {
          byAgent: true,
        },
      ),
    )
    expect(delivery.fields.deliveryCents).toBe("Con estos productos no se ofrece el envío")
    await call("rosa", "PATCH", `${base}/productos/${id}`, {
      offers: { discount: true, delivery: true },
    })
  })

  it("el simulador sale de la misma regla; lo que se gana solo con costos", async () => {
    await call("rosa", "POST", `${base}/variantes/${variant("blanca,38")}/movimientos`, {
      kind: "entrada",
      quantity: 1,
      unitCostCents: 6800,
    })
    const owner = await call("rosa", "POST", `${base}/productos/${id}/simular`, {
      variantId: variant("blanca,38"),
      quantity: 1,
      deliveryMethodId: deliveryId,
    })
    expect(owner.status).toBe(200)
    expect(owner.json).toMatchObject({
      autoUnitCents: 12900,
      reason: "lista",
      floorUnitCents: 9900,
      negotiable: true,
      deliveryListCents: 1000,
      costCents: 6800,
      gainCents: 9900 - 6800,
    })
    expect(owner.json.lowest.totalCents).toBe(10900)
    const sales = await call("lucia", "POST", `${base}/productos/${id}/simular`, {
      variantId: variant("blanca,38"),
      quantity: 1,
    })
    expect(sales.json).toMatchObject({ costCents: null, gainCents: null })
    expect(sales.json.lowest.totalCents).toBe(9900)
  })
})
