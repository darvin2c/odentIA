/** La carta de bienvenida: lo que promete (buzón, fecha, plazo), lo que pide, su forma de carta y sus hojas. */
import { PDFDocument } from "pdf-lib"
import { describe, expect, it } from "vitest"
import {
  WELCOME_LETTER_MAX_PAGES,
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
    content.subject,
    content.salutation,
    ...content.intro,
    ...content.steps.flatMap((step) => [step.lead, step.rest]),
    ...content.after,
    content.closing,
    content.send.title,
    content.send.body,
    ...content.annex.flatMap((area) => [area.title, ...area.items]),
    content.list.lead,
    ...content.list.items,
    content.list.tail,
  ].join("\n")
}

describe("welcomeLetterContent", () => {
  it("odentIA: el buzón de soporte, la fecha límite, el plazo de borrado y el titular", () => {
    const content = welcomeLetterContent(base)
    const text = words(content)
    expect(content.brandName).toBe("odentIA")
    expect(content.inbox).toBe("soporte@odentia32.com")
    expect(content.title).toBe("Bienvenida a odentIA")
    expect(content.placeAndDate).toBe("Lima, 9 de noviembre de 2026")
    expect(content.steps[1]?.lead).toBe("Envío de la información, hasta el viernes 13 de noviembre.")
    expect(content.steps[1]?.rest).toContain("a soporte@odentia32.com, en uno o varios correos")
    expect(content.send.title).toBe("Enviar a soporte@odentia32.com hasta el viernes 13 de noviembre")
    expect(text).toContain(`como máximo, a los ${WELCOME_LETTER_RETENTION_DAYS} días de recibirlos`)
    expect(WELCOME_LETTER_RETENTION_DAYS).toBe(30)
    expect(text).toContain("la plataforma para clínicas odontológicas de SALLCA GROUP E.I.R.L.")
    expect(text).toContain("contrato de encargo de datos")
    expect(text).toContain("mientras no lo acepte, no podremos abrir lo que nos envíe")
    expect(text).toContain("le pedimos no usar WhatsApp")
  })

  it("es una carta formal: asunto, saludo sin suponer el género, despedida y firma", () => {
    const content = welcomeLetterContent({
      ...base,
      companion: { ...base.companion, role: "Implementación" },
    })
    expect(content.subject).toBe("Bienvenida a odentIA e información para la implementación")
    expect(content.salutation).toBe("De nuestra consideración:")
    expect(content.closing).toContain("quedamos a su disposición")
    // El celular va con espacios que no cortan: no se parte entre dos líneas.
    expect(content.signature).toEqual({
      name: "Carlos Ruiz",
      role: "Implementación",
      brand: "odentIA",
      contact: "carlos@odentia32.com · 987 654 321",
    })
    expect(welcomeLetterContent(base).signature.role).toBeNull()
  })

  it("pide todo lo que se puede cargar, por área, y la lista de pacientes al final", () => {
    const content = welcomeLetterContent(base)
    expect(content.annex.map((area) => area.title)).toEqual([
      "Empresa",
      "Sedes y unidades dentales",
      "Equipo y horarios",
      "Servicios y precios",
      "Inventario y proveedores",
      "Caja y gastos",
      "Atención a sus pacientes",
      "Canales de comunicación",
    ])
    expect(content.list.title).toBe("Lista de pacientes")
    const text = words(content)
    expect(text).toContain("Razón social, RUC, dirección fiscal y nombre comercial")
    expect(text).toContain("Unidades dentales de cada sede")
    expect(text).toContain("colegio profesional y número de colegiatura (COP)")
    expect(text).toContain("qué días y horas atiende cada profesional en cada sede")
    expect(text).toContain("cantidad actual y mínimo para reponer")
    expect(text).toContain("Proveedores: nombre o razón social, RUC, teléfono, correo y dirección")
    expect(text).toContain("Gastos fijos")
    expect(text).toContain("comisiones")
    expect(text).toContain("estacionamiento")
    expect(text).toContain("WhatsApp, las páginas de Facebook e Instagram")
    expect(content.send.body).toContain("No incluya contraseñas")
    expect(text).not.toContain("tengan a mano")
  })

  it("el pie es del remitente, no de la clínica", () => {
    const content = welcomeLetterContent(base)
    expect(content.footer).toBe("odentIA · odentia32.com · SALLCA GROUP E.I.R.L. · RUC 20603338741")
    expect(content.footer).not.toContain("Sonrisa")
  })

  it("latidIA: su marca, su dominio y sus palabras", () => {
    const content = welcomeLetterContent({ ...base, product: "medical", clinic: "Consultorio Vida" })
    const text = words(content)
    expect(content.brandName).toBe("latidIA")
    expect(content.inbox).toBe("soporte@latidia72.com")
    expect(content.title).toBe("Bienvenida a latidIA")
    expect(content.footer).toBe("latidIA · latidia72.com · SALLCA GROUP E.I.R.L. · RUC 20603338741")
    expect(text).toContain("la plataforma para clínicas y consultorios médicos")
    expect(content.annex[1]?.title).toBe("Sedes y consultorios")
    expect(text).toContain("Consultorios de cada sede")
    expect(text).toContain("colegio profesional y número de colegiatura (CMP)")
    expect(text).not.toMatch(/odentIA|unidades dentales|odontólogos|\(COP\)/i)
  })

  it("vistIA: su marca, su dominio y sus palabras", () => {
    const content = welcomeLetterContent({ ...base, product: "optical", clinic: "Óptica Clara" })
    const text = words(content)
    expect(content.brandName).toBe("vistIA")
    expect(content.inbox).toBe("soporte@vistia20.com")
    expect(content.title).toBe("Bienvenida a vistIA")
    expect(content.footer).toBe("vistIA · vistia20.com · SALLCA GROUP E.I.R.L. · RUC 20603338741")
    expect(text).toContain("la plataforma para ópticas")
    expect(content.annex[1]?.title).toBe("Sedes y salas de examen")
    expect(text).toContain("De los optómetras:")
    expect(text).toContain("colegio profesional y número de colegiatura (CTMP)")
    expect(text).not.toMatch(/odentIA|latidIA|unidades dentales|consultorios|odontólogos|médicos|\((COP|CMP)\)/i)
  })

  it("sin teléfono de quien acompaña, solo su correo; sin la consulta si ya se sabe qué usan", () => {
    const content = welcomeLetterContent({
      ...base,
      companion: { name: "Carlos Ruiz", email: "carlos@odentia32.com" },
      askCurrentSystem: false,
    })
    expect(content.signature.contact).toBe("carlos@odentia32.com")
    expect(content.currentSystem).toBeNull()
    expect(content.steps[2]?.rest).not.toContain("le consultaremos")
    const asking = welcomeLetterContent(base)
    expect(asking.currentSystem).toContain("le consultaremos qué utiliza hoy")
    expect(asking.steps[2]?.rest).toContain(asking.currentSystem ?? "")
    expect(asking.steps[2]?.rest).toContain("Carlos Ruiz coordinará con usted una reunión")
  })

  it("otro buzón si se indica; la fecha límite de otro año lleva el año", () => {
    const content = welcomeLetterContent({
      ...base,
      inbox: "cargas@odentia32.com",
      date: "2026-12-28",
      deadline: "2027-01-08",
    })
    expect(content.inbox).toBe("cargas@odentia32.com")
    expect(content.steps[1]?.lead).toBe("Envío de la información, hasta el viernes 8 de enero de 2027.")
    expect(content.send.title).toBe("Enviar a cargas@odentia32.com hasta el viernes 8 de enero de 2027")
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
  it.each(["dental", "medical", "optical"] as const)(
    "la carta con su firma en la primera hoja y el anexo desde la segunda (%s)",
    async (product) => {
      const { bytes, pages, letterPages, content } = await welcomeLetterPdf({
        ...base,
        product,
        companion: { ...base.companion, role: "Implementación" },
      })
      expect(letterPages).toBe(1)
      expect(pages).toBeGreaterThan(1)
      expect(pages).toBeLessThanOrEqual(WELCOME_LETTER_MAX_PAGES)
      const pdf = await PDFDocument.load(bytes)
      expect(pdf.getPageCount()).toBe(pages)
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
      name: fill("Carlos Alberto Ruiz Mendoza de la Torre ", 40),
      role: fill("Responsable de implementación y soporte ", 50),
      email: `${fill("carlos.alberto.ruiz.mendoza.", 26)}@odentia32.com`,
      phone: "+51 987 654 321 0000",
    },
    inbox: `${fill("cargas.pacientes.nuevas.", 26)}@odentia32.com`,
  }

  it.each([
    ["dental", true],
    ["dental", false],
    ["medical", true],
    ["medical", false],
    ["optical", true],
    ["optical", false],
  ] as const)(
    "con todo en su largo máximo, la firma sigue en la primera hoja y no pasa del tope (%s, consulta su sistema: %s)",
    async (product, askCurrentSystem) => {
      const { pages, letterPages } = await welcomeLetterPdf({ ...longest, product, askCurrentSystem })
      expect(letterPages).toBe(1)
      expect(pages).toBeLessThanOrEqual(WELCOME_LETTER_MAX_PAGES)
    },
  )
})
