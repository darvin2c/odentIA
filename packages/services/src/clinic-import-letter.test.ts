/** La carta de bienvenida: lo que promete (buzón, fecha, plazo), lo que pide y que quepa en dos hojas. */
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
    ...content.after,
    ...content.clinicData,
    content.list.lead,
    ...content.list.items,
    content.list.tail,
    content.currentSystem ?? "",
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
      "Envíen los datos de su clínica y su lista de pacientes a soporte@odentia32.com hasta el viernes 13 de noviembre,",
    )
    expect(text).toContain(`como máximo, a los ${WELCOME_LETTER_RETENTION_DAYS} días de recibirlos`)
    expect(WELCOME_LETTER_RETENTION_DAYS).toBe(30)
    expect(text).toContain("una marca de SALLCA GROUP E.I.R.L.")
    expect(text).toContain("contrato de encargo de datos")
    expect(text).toContain("No los envíen por WhatsApp")
    // El celular va con espacios que no cortan: no se parte entre dos líneas.
    expect(content.help.body).toContain("carlos@odentia32.com · 987 654 321")
  })

  it("pide los datos de la clínica para cargarlos, no solo para tenerlos a mano", () => {
    const data = welcomeLetterContent(base).clinicData.join("\n")
    expect(data).toContain("razón social, RUC, nombre comercial y su logo")
    expect(data).toContain("Cada sede: nombre, dirección, teléfono y horario de atención")
    expect(data).toContain("Sus sillones")
    expect(data).toContain("de los odontólogos, su especialidad y su número de colegiatura (COP)")
    expect(data).toContain("Sus servicios y precios")
    expect(words(welcomeLetterContent(base))).not.toContain("tengan a mano")
  })

  it("latidIA: su marca, su dominio y sus palabras", () => {
    const content = welcomeLetterContent({ ...base, product: "medical", clinic: "Consultorio Vida" })
    const text = words(content)
    expect(content.brandName).toBe("latidIA")
    expect(content.inbox).toBe("soporte@latidia72.com")
    expect(content.title).toBe("Bienvenidos a latidIA")
    expect(text).toContain("Sus consultorios")
    expect(text).toContain("de los médicos, su especialidad y su número de colegiatura (CMP)")
    expect(text).not.toMatch(/odentIA|sillones|odontólogos|\(COP\)/)
  })

  it("sin teléfono de quien acompaña, solo su correo; sin la pregunta si ya se sabe qué usan", () => {
    const content = welcomeLetterContent({
      ...base,
      companion: { name: "Carlos Ruiz", email: "carlos@odentia32.com" },
      askCurrentSystem: false,
    })
    expect(content.help.body).toBe(
      "Escríbanle a Carlos Ruiz, quien los acompaña en el alta: carlos@odentia32.com.",
    )
    expect(content.currentSystem).toBeNull()
    expect(welcomeLetterContent(base).currentSystem).toContain(
      "Cuéntenle también a quien los acompaña",
    )
  })

  it("otro buzón si se indica; la fecha límite de otro año lleva el año", () => {
    const content = welcomeLetterContent({
      ...base,
      inbox: "cargas@odentia32.com",
      date: "2026-12-28",
      deadline: "2027-01-08",
    })
    expect(content.inbox).toBe("cargas@odentia32.com")
    expect(content.steps[1]?.lead).toContain("a cargas@odentia32.com hasta el viernes 8 de enero de 2027,")
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
  it.each(["dental", "medical"] as const)(
    "la carta en la primera hoja y lo que hay que enviar en la segunda (%s)",
    async (product) => {
      const { bytes, pages, content } = await welcomeLetterPdf({ ...base, product })
      expect(pages).toBe(2)
      const pdf = await PDFDocument.load(bytes)
      expect(pdf.getPageCount()).toBe(2)
      expect(pdf.getTitle()).toBe(content.title)
    },
  )

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
  ] as const)(
    "no pasa de dos hojas con todo en su largo máximo (%s, pregunta su sistema: %s)",
    async (product, askCurrentSystem) => {
      const { pages } = await welcomeLetterPdf({ ...longest, product, askCurrentSystem })
      expect(pages).toBe(2)
    },
  )
})
