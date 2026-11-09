/** La carta de bienvenida: lo que promete (buzón, fecha, plazo) y que quepa en una hoja. */
import { PDFDocument } from "pdf-lib"
import { describe, expect, it } from "vitest"
import {
  WELCOME_LETTER_RETENTION_DAYS,
  type WelcomeLetterInput,
  welcomeLetterContent,
  welcomeLetterPdf,
} from "./clinic-import-letter.js"

const base: WelcomeLetterInput = {
  clinic: "Clínica Dental Sonrisa",
  to: "Dra. Ana Pérez, directora",
  companion: { name: "Carlos Ruiz", email: "carlos@odentia32.com", phone: "987 654 321" },
  deadline: "2026-11-13",
  date: "2026-11-09",
}

function words(content: ReturnType<typeof welcomeLetterContent>): string {
  return [
    content.title,
    ...content.intro,
    ...content.steps.flatMap((step) => [step.lead, step.rest]),
    content.help.body,
    content.currentSystem ?? "",
    ...content.list,
    ...content.after,
  ].join("\n")
}

describe("welcomeLetterContent", () => {
  it("odentIA: el buzón de soporte, la fecha límite, el plazo de borrado y el titular", () => {
    const content = welcomeLetterContent(base)
    const text = words(content)
    expect(content.brandName).toBe("odentIA")
    expect(content.inbox).toBe("soporte@odentia32.com")
    expect(content.title).toBe("Bienvenidos a odentIA")
    expect(content.placeAndDate).toBe("Lima, 9 de noviembre de 2026")
    expect(content.steps[1]?.lead).toBe(
      "Envíen su lista de pacientes a soporte@odentia32.com hasta el viernes 13 de noviembre,",
    )
    expect(text).toContain(`como máximo, a los ${WELCOME_LETTER_RETENTION_DAYS} días de recibirlo`)
    expect(WELCOME_LETTER_RETENTION_DAYS).toBe(30)
    expect(text).toContain("una marca de SALLCA GROUP E.I.R.L.")
    expect(text).toContain("contrato de encargo de datos")
    expect(text).toContain("No la envíen por WhatsApp")
    expect(text).toContain("sus sillones")
    expect(text).toContain("de los odontólogos, su colegiatura")
    // El celular va con espacios que no cortan: no se parte entre dos líneas.
    expect(content.help.body).toContain("carlos@odentia32.com · 987 654 321")
  })

  it("latidIA: su marca, su dominio y sus palabras", () => {
    const content = welcomeLetterContent({
      ...base,
      product: "medical",
      clinic: "Consultorio Vida",
    })
    const text = words(content)
    expect(content.brandName).toBe("latidIA")
    expect(content.inbox).toBe("soporte@latidia72.com")
    expect(content.title).toBe("Bienvenidos a latidIA")
    expect(text).toContain("sus consultorios")
    expect(text).toContain("de los médicos, su colegiatura")
    expect(text).not.toMatch(/odentIA|sillones|odontólogos/)
  })

  it("sin teléfono de quien acompaña, solo su correo; sin la pregunta si ya se sabe qué usan", () => {
    const content = welcomeLetterContent({
      ...base,
      companion: { name: "Carlos Ruiz", email: "carlos@odentia32.com" },
      askCurrentSystem: false,
    })
    expect(content.help.body).toContain("en el alta: carlos@odentia32.com.")
    expect(content.currentSystem).toBeNull()
    expect(welcomeLetterContent(base).currentSystem).toContain("Cuéntenle también a quien los acompaña")
  })

  it("otro buzón si se indica; la fecha límite de otro año lleva el año", () => {
    const content = welcomeLetterContent({
      ...base,
      inbox: "cargas@odentia32.com",
      date: "2026-12-28",
      deadline: "2027-01-08",
    })
    expect(content.inbox).toBe("cargas@odentia32.com")
    expect(content.steps[1]?.lead).toContain("hasta el viernes 8 de enero de 2027,")
  })

  it("rechaza un día que no existe y, sin fecha de carta, una fecha límite ya pasada", () => {
    expect(() => welcomeLetterContent({ ...base, deadline: "2026-02-30" })).toThrow()
    expect(() => welcomeLetterContent({ ...base, date: "2026-11-31" })).toThrow()
    const { date: _date, ...withoutDate } = base
    expect(() => welcomeLetterContent({ ...withoutDate, deadline: "2020-01-01" })).toThrow(
      "La fecha límite es anterior a la carta",
    )
  })

  it("rechaza una fecha límite anterior a la carta y un correo que no es correo", () => {
    expect(() => welcomeLetterContent({ ...base, deadline: "2026-11-01" })).toThrow(
      "La fecha límite es anterior a la carta",
    )
    expect(() =>
      welcomeLetterContent({ ...base, companion: { name: "Carlos", email: "carlos" } }),
    ).toThrow()
  })
})

describe("welcomeLetterPdf", () => {
  const long: WelcomeLetterInput = {
    ...base,
    clinic: "Centro Odontológico Especializado Sonrisa Feliz de Lurigancho",
    to: "Dra. María Fernanda Quispe Huamán, directora general",
    companion: {
      name: "Carlos Alberto Ruiz Mendoza",
      email: "carlos.alberto.ruiz@odentia32.com",
      phone: "+51 987 654 321",
    },
  }

  // Cada texto, con palabras de verdad, en el largo máximo que admite el esquema.
  const fill = (words: string, length: number) => words.repeat(5).slice(0, length).trimEnd()
  const longest: WelcomeLetterInput = {
    ...base,
    clinic: fill("Centro Odontológico Especializado Sonrisa Feliz de Lurigancho ", 70),
    to: fill("Dra. María Fernanda Quispe Huamán de Rodríguez, directora ", 55),
    companion: {
      name: fill("Carlos Alberto Ruiz Mendoza de la Torre ", 50),
      email: `${fill("carlos.alberto.ruiz.mendoza.", 36)}@odentia32.com`,
      phone: "+51 987 654 321 0000",
    },
    inbox: `${fill("cargas.pacientes.nuevas.", 36)}@odentia32.com`,
  }

  it.each([
    ["dental", true],
    ["dental", false],
    ["medical", true],
    ["medical", false],
  ] as const)("cabe en una hoja con todo en su largo máximo (%s, pregunta su sistema: %s)", async (product, askCurrentSystem) => {
    const { pages } = await welcomeLetterPdf({ ...longest, product, askCurrentSystem })
    expect(pages).toBe(1)
  })

  it.each(["dental", "medical"] as const)(
    "cabe en una hoja aunque los nombres sean largos (%s)",
    async (product) => {
      const { bytes, pages, content } = await welcomeLetterPdf({ ...long, product })
      expect(pages).toBe(1)
      const pdf = await PDFDocument.load(bytes)
      expect(pdf.getPageCount()).toBe(1)
      expect(pdf.getTitle()).toBe(`${content.title} · ${content.clinic}`)
    },
  )
})
