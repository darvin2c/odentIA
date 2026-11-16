import { describe, expect, it } from "vitest"
import { kairosStageWords } from "./admin-kairos-drafts.js"
import {
  KAIROS_IMPROVE_CONTEXT_MAX,
  kairosImproveContext,
  kairosImproveLines,
} from "./kairos-improve.js"
import { KAIROS_BASIS_CHARS, KAIROS_BASIS_MAX, kairosBasisOf } from "./kairos-sells.js"

/**
 * Lo puro de «Mejorar con Kairós» y de lo que lee Kairós (ADR 0196), sin base: qué lee de una
 * conversación, cómo se guarda «En qué se basó» y la fase en vez de «Entró». Lo que lee de un chat
 * o de un hilo de correo lo prueba la ruta contra Postgres (`admin-kairos.test.ts` de la API).
 */
const at = (minute: number) => new Date(Date.UTC(2026, 10, 16, 14, minute))

describe("kairosImproveLines", () => {
  it("lo último, lo más viejo primero, como mucho seis", () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({
      who: i % 2 === 0 ? ("ellos" as const) : ("nosotros" as const),
      at: at(9 - i),
      body: `Mensaje ${9 - i}`,
    }))
    const lines = kairosImproveLines(rows)
    expect(lines).toHaveLength(KAIROS_IMPROVE_CONTEXT_MAX)
    expect(lines.map((line) => line.text)).toEqual([
      "Mensaje 4",
      "Mensaje 5",
      "Mensaje 6",
      "Mensaje 7",
      "Mensaje 8",
      "Mensaje 9",
    ])
  })

  it("sin lo de un paciente, sin lo citado, sin la firma de lo nuestro y con el asunto una vez", () => {
    expect(
      kairosImproveLines([
        {
          who: "ellos",
          at: at(1),
          body: "¿Cuánto cuesta?\nMi paciente con DNI 44556677 pregunta.\n> lo citado no viaja",
          subject: "Re: Precios",
        },
        {
          who: "nosotros",
          at: at(2),
          body: "Cuesta USD 49 al mes.\n— Ada · odentIA",
          subject: "Re: Precios",
        },
        { who: "ellos", at: at(3), body: null, files: 2 },
        { who: "ellos", at: at(4), body: "La paciente Juana Pérez tiene caries" },
      ]),
    ).toEqual([
      { who: "ellos", text: "Asunto: Precios. ¿Cuánto cuesta?" },
      { who: "nosotros", text: "Cuesta USD 49 al mes." },
      { who: "ellos", text: "(mandó archivos)" },
    ])
  })

  it("un mensaje largo se corta a 600 caracteres", () => {
    const body = Array.from(
      { length: 20 },
      () => "Esta es otra frase de un correo muy largo.",
    ).join("\n")
    const [line] = kairosImproveLines([{ who: "ellos", at: at(1), body }])
    expect(line?.text.length).toBe(600)
    expect(line?.text.endsWith("…")).toBe(true)
  })
})

describe("kairosImproveContext", () => {
  const tx = {} as Parameters<typeof kairosImproveContext>[0]

  it("solo Administración, y nunca con una conversación y un correo a la vez", async () => {
    await expect(
      kairosImproveContext(tx, { userId: "kr-sofia", role: "support" }, {}),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 })
    await expect(
      kairosImproveContext(
        tx,
        { userId: "kr-ana", role: "admin" },
        {
          chatId: "0b6a1c1e-1f3e-4a9b-8c2d-3e4f5a6b7c8d",
          emailId: "1c7b2d2f-2a4f-4b8c-9d3e-4f5a6b7c8d9e",
        },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION", fields: { emailId: expect.any(String) } })
  })

  it("sin conversación ni correo, mejora el texto solo y no lee la base", async () => {
    expect(await kairosImproveContext(tx, { userId: "kr-ana", role: "admin" }, {})).toEqual({
      conversation: [],
    })
  })
})

describe("kairosBasisOf", () => {
  it("cada cosa una vez, sin vacíos, corta y como mucho ocho", () => {
    expect(kairosBasisOf(undefined)).toEqual([])
    expect(kairosBasisOf(["los precios de la web", "  ", "los precios de la web"])).toEqual([
      "los precios de la web",
    ])
    const long = kairosBasisOf([`la guía de la Ayuda: «${"a".repeat(400)}»`])
    expect(long[0]?.length).toBe(KAIROS_BASIS_CHARS)
    expect(kairosBasisOf(Array.from({ length: 12 }, (_, i) => `cosa ${i}`))).toHaveLength(
      KAIROS_BASIS_MAX,
    )
  })
})

describe("kairosStageWords", () => {
  it("con cuenta dice su fase y no «Entró»; sin cuenta, la etapa de la venta", () => {
    expect(kairosStageWords({ stage: "entro", hasAccount: true, paid: false })).toBe("En alta")
    expect(kairosStageWords({ stage: "entro", hasAccount: true, paid: true })).toBe("Activo")
    expect(
      kairosStageWords({ stage: "presentacion_agendada", hasAccount: false, paid: false }),
    ).toBe("Presentación agendada")
    expect(kairosStageWords({ stage: "no_por_ahora", hasAccount: false, paid: false })).toBe(
      "No por ahora",
    )
  })
})
