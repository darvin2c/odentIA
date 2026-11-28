/**
 * La revisión de lo que propone la IA de fotos, sin base ni red: lo que no cumple una regla se
 * descarta antes de llegar a la persona, y la medición cuenta bien lo inventado.
 */
import { PRODUCT_RUBROS, type ProductRubro } from "@gestoria/db"
import { describe, expect, it } from "vitest"
import { scoreGroups, scoreLook } from "./eval-fotos.js"
import { addedFacts, lookAtProduct, photosModelFromEnv, reviewLook } from "./ia-fotos.js"
import { RUBROS, type TemplateField } from "./rubros.js"
import { scriptedModel } from "./sofi/modelo.js"

const templates = Object.fromEntries(PRODUCT_RUBROS.map((r) => [r, RUBROS[r].fields])) as Record<
  ProductRubro,
  TemplateField[]
>
const photos = [
  { ref: "a", bytes: new Uint8Array([1]), contentType: "image/webp" },
  { ref: "b", bytes: new Uint8Array([2]), contentType: "image/webp" },
]

function reply(over: Record<string, unknown> = {}) {
  return {
    mismo_producto: true,
    aviso: null,
    leido: [] as string[],
    nombre: null,
    categoria: null,
    rubro: null,
    colores: [],
    datos: [],
    palabras: [],
    descripcion: null,
    ...over,
  } as Parameters<typeof reviewLook>[0]
}

const fields = (r: ReturnType<typeof reviewLook>) => r.proposals.map((p) => p.field)

describe("la revisión de lo propuesto", () => {
  it("un dato de etiqueta solo si está escrito, y una cifra solo si se lee", () => {
    const out = reviewLook(
      reply({
        leido: ["MAC", "Net wt 3,5 g"],
        datos: [
          { clave: "contenido", valor: "3,5 g", de: "etiqueta", porque: "Se lee" },
          { clave: "nso", valor: "NSOC12345-20PE", de: "etiqueta", porque: "?" },
          { clave: "piel", valor: "Sensible", de: "foto", porque: "Parece" },
        ],
      }),
      { photos, rubro: "cosmetica", templates },
      photos,
    )
    expect(out.proposals).toContainEqual({
      field: "dato:contenido",
      value: "3,5 g",
      reason: "Se lee",
    })
    expect(fields(out)).not.toContain("dato:nso")
    expect(fields(out)).not.toContain("dato:piel")
    expect(fields(out)).toEqual(
      expect.arrayContaining(["pregunta:nso", "pregunta:piel", "pregunta:vence"]),
    )
    expect(out.discarded.map((d) => d.field)).toEqual(["dato:nso", "dato:piel"])
  })

  it("lo que nunca se ve en una foto no se propone, aunque el modelo lo diga", () => {
    const out = reviewLook(
      reply({
        datos: [
          { clave: "garantia", valor: "1 año", de: "foto", porque: "?" },
          { clave: "estado_equipo", valor: "Nuevo", de: "foto", porque: "?" },
        ],
        descripcion: "Audífonos con batería de 20 horas.",
        palabras: ["audífonos", "bluetooth 5.0"],
      }),
      { photos, rubro: "tecnologia", templates },
      photos,
    )
    expect(fields(out)).toEqual([
      "pregunta:compatible",
      "pregunta:estado_equipo",
      "pregunta:garantia",
      "palabras",
    ])
    expect(out.proposals.at(-1)).toMatchObject({ value: ["audífonos"] })
  })

  it("si se pregunta el material, nada de lo propuesto lo afirma", () => {
    const out = reviewLook(
      reply({
        nombre: { valor: "Botín de cuero", porque: "?" },
        descripcion: "Botín negro con taco ancho.",
      }),
      { photos, rubro: "calzado", templates },
      photos,
    )
    expect(fields(out)).toContain("pregunta:material")
    expect(fields(out)).not.toContain("nombre")
    expect(fields(out)).toContain("descripcion")
  })

  it("«preciosa» o «girasoles» no hablan de precio; «S/ 129» sí", () => {
    const out = reviewLook(
      reply({ descripcion: "Cojín precioso con estampado de girasoles.", palabras: ["oferta"] }),
      { photos, rubro: null, templates },
      photos,
    )
    expect(fields(out)).toEqual(["descripcion"])
    expect(addedFacts("cojín azul", "Cojín azul a S/ 129", templates)).toBe("Suma una cifra")
    expect(addedFacts("cojín azul", "Cojín azul en oferta", templates)).toBe("Suma un precio")
  })

  it("el rubro lo propone si no tiene, y sin rubro de la lista no hay datos", () => {
    const out = reviewLook(
      reply({
        rubro: { valor: "mascotas", porque: "?" },
        datos: [{ clave: "material", valor: "Lona", de: "foto", porque: "?" }],
      }),
      { photos, rubro: null, templates },
      photos,
    )
    expect(out.proposals).toEqual([])
    expect(out.discarded.map((d) => d.field)).toEqual(["rubro", "dato:material"])
  })

  it("los colores: #rrggbb, sin repetir, y cada foto por su número", () => {
    const out = reviewLook(
      reply({
        colores: [
          { nombre: "Negra", hex: "#111111", hex2: null, fotos: [2, 2, 7], porque: "" },
          { nombre: "negra", hex: "#121212", hex2: null, fotos: [1], porque: "" },
          { nombre: "blanca, negra", hex: "#ffffff", hex2: null, fotos: [1], porque: "" },
        ],
      }),
      { photos, rubro: "calzado", templates },
      photos,
    )
    const colors = out.proposals.filter((p) => p.field === "color")
    expect(colors).toEqual([
      {
        field: "color",
        value: { name: "negra", hex: "#111111", hex2: null, photos: ["b"] },
        reason: "Se ve en la foto",
      },
    ])
  })

  it("lo que el producto ya tiene no se vuelve a proponer ni a preguntar", () => {
    const out = reviewLook(
      reply({ nombre: { valor: "zapatilla urbana", porque: "" } }),
      {
        photos,
        rubro: "calzado",
        templates,
        current: { name: "Zapatilla urbana", rubroData: { horma: "Normal", material: "Lona" } },
      },
      photos,
    )
    expect(fields(out)).toEqual([])
  })
})

describe("el pedido al modelo", () => {
  it("lleva las reglas, las fotos y el esquema estricto; sin respuesta legible, falla con su motivo", async () => {
    const model = scriptedModel([() => ({ content: "no es json" })])
    await expect(lookAtProduct(model, { photos, rubro: null, templates })).rejects.toThrow(
      "La IA respondió algo que no se pudo leer",
    )
    const request = model.requests[0]!
    expect(request.responseFormat).toMatchObject({
      type: "json_schema",
      json_schema: { name: "propuesta_de_producto", strict: true },
    })
    const user = request.messages[1]!.content as { type: string; text?: string }[]
    expect(user[0]!.text).toContain("Elige el rubro del producto")
    expect(user.filter((p) => p.type === "image_url")).toHaveLength(2)
  })

  it("«fake» no arranca en producción y, sin clave, no hay IA", () => {
    expect(() =>
      photosModelFromEnv({ GESTORIA_FOTOS_MODEL: "fake", NODE_ENV: "production" }),
    ).toThrow()
    expect(photosModelFromEnv({})).toBeNull()
    expect(photosModelFromEnv({ GESTORIA_OPENAI_API_KEY: "k" })?.name).toBe("gpt-6-luna")
  })
})

describe("mejorar un texto", () => {
  it("no suma cifras, precios, datos de la plantilla ni cualidades", () => {
    expect(addedFacts("zapatilla negra", "Zapatilla negra talla 38", templates)).toBe(
      "Suma una cifra",
    )
    expect(addedFacts("zapatilla negra", "Zapatilla negra de cuero", templates)).toBe(
      "Suma «Cuero»",
    )
    expect(addedFacts("zapatilla negra", "Zapatilla negra muy cómoda", templates)).toBe(
      "Suma «comoda»",
    )
    expect(
      addedFacts("zapatilla negra de cuero, 38", "Zapatilla negra de cuero, talla 38.", templates),
    ).toBeNull()
  })
})

describe("la medición", () => {
  const item = {
    id: "x",
    fotos: ["a"],
    producto: "Botín negro",
    se_ve: {
      rubro: "calzado" as const,
      nombre: ["botin"],
      colores: [["negro", "negra"]],
      datos: {},
      leido: [],
    },
    puede: [],
    no_se_ve: ["material", "horma"],
    debe_preguntar: ["horma", "material"],
    nunca: ["cuero"],
  }
  it("cuenta inventados, preguntas y aciertos", () => {
    const scored = scoreLook(item, {
      proposals: [
        { field: "rubro", value: "calzado", reason: "" },
        { field: "nombre", value: "Botín negro de cuero", reason: "" },
        { field: "dato:material", value: "Cuero", reason: "" },
        { field: "pregunta:horma", value: null, reason: "" },
        {
          field: "color",
          value: { name: "negro", hex: "#000000", hex2: null, photos: [] },
          reason: "",
        },
      ],
      discarded: [],
      read: [],
      sameProduct: true,
      notice: null,
    })
    expect(scored.inventados.map((i) => i.que)).toEqual([
      "dato material",
      "nombre",
      "dato:material",
    ])
    expect(scored.preguntas).toEqual({ esperadas: 2, hechas: 1, faltan: ["material"] })
    expect(scored.aciertos).toMatchObject({ posibles: 3, logrados: 3 })
  })

  it("en juntar, un par que no va junto es inventado", () => {
    const scored = scoreGroups(
      { id: "g", fotos: ["a", "b", "c"], grupos: [["a", "b"]], puede_juntar: [] },
      [{ field: "juntar", value: { photos: ["a", "b", "c"] }, reason: "" }],
    )
    expect(scored.inventados).toHaveLength(2)
    expect(scored.aciertos).toMatchObject({ posibles: 1, logrados: 1 })
  })
})
