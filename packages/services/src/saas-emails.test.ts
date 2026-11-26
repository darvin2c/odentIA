import { configureMailLinks, resetMailLinks } from "@odentia/mail"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  founderInvitationEmail,
  saasAlertEmail,
  saasBillingUrl,
  saasOverdueEmail,
  saasPlanStartedEmail,
  saasRestrictedEmail,
  saasRestrictionSoonEmail,
  saasSettlementEmail,
  saasTrialEndedEmail,
} from "./saas-emails.js"

const url = saasBillingUrl("https://app.odentia32.com/", "org_1")

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-10-18T12:00:00Z"))
  configureMailLinks("https://app.odentia32.com")
})

afterEach(() => {
  vi.useRealTimers()
  resetMailLinks()
})

describe("correos de Plan y pagos", () => {
  it("el botón lleva a Plan y pagos del panel; sin panel, no hay botón", () => {
    expect(url).toBe("https://app.odentia32.com/billing/org_1")
    expect(saasBillingUrl(undefined, "org_1")).toBeNull()
    const sinBoton = saasRestrictedEmail("Clínica Sonrisa", null)
    expect(sinBoton.html).not.toContain("Registrar mi comprobante")
  })

  it("un consultorio de latidIA recibe los avisos con su marca (entrega 4b del issue 229)", () => {
    const mail = saasRestrictedEmail("Consultorio San Martín", url, "latidia")
    expect(mail.brand).toBe("latidia")
    expect(mail.text).toContain("administras el plan de Consultorio San Martín en latidIA")
    expect(mail.html).not.toContain("odentIA")
    // odentIA, como siempre.
    expect(saasRestrictedEmail("Clínica Sonrisa", url).text).toContain("en odentIA")
  })

  it("cada aviso con el molde común", () => {
    const mails = {
      alertaCredito: saasAlertEmail(
        {
          family: "credito",
          level: "aviso",
          periodKey: "2026-10-01",
          title: "Aviso",
          message: "Tus agentes usaron 76 % del crédito del mes.",
          short: "Usaste 76 % del crédito",
          action: "ver_consumo",
        },
        "Clínica Sonrisa",
        url,
      ),
      alertaTope: saasAlertEmail(
        {
          family: "tope",
          level: "limite",
          periodKey: "2026-10-01",
          title: "Tope alcanzado",
          message: "Llegaste a tu tope de gasto.",
          short: "Llegaste a tu tope de gasto",
          action: "cambiar_tope",
        },
        "Clínica Sonrisa",
        url,
      ),
      pruebaTermino: saasTrialEndedEmail("Clínica Sonrisa", url),
      planEmpezo: saasPlanStartedEmail("Clínica Sonrisa", url),
      restringido: saasRestrictedEmail("Clínica Sonrisa", url),
      cargoVencido: saasOverdueEmail({
        clinic: "Clínica Sonrisa",
        lastDay: "sábado, 25 de octubre de 2026",
        amounts: ["US$ 49.00"],
        url,
      }),
    }
    expect(mails).toMatchSnapshot()
    expect(mails.alertaCredito.subject).toBe("Aviso: el crédito del mes")
    expect(mails.alertaCredito.html).not.toContain("#fdf3df")
    expect(mails.alertaTope.html).toContain("#fdeaea")
    expect(mails.cargoVencido.html).toContain("Plazo: hasta el sábado, 25 de octubre de 2026")
    expect(mails.cargoVencido.text).toContain("Monto pendiente: US$ 49.00")
    for (const mail of Object.values(mails)) expect(mail.subject).not.toMatch(/odentIA ·/)
  })

  it("la liquidación incluye el detalle antes del total, con escape", () => {
    const mail = saasSettlementEmail({
      sellerName: "Jorge <b>Ríos</b> & Cía",
      monthText: "septiembre de 2026",
      clinics: 2,
      gross: "123,45 USD",
      adjustments: "-5,00 USD",
      total: "118,45 USD",
      lines: [
        { label: "Clínica <Sonrisa> & Cía", amount: "100,00 USD" },
        { label: "Clínica Norte", amount: "23,45 USD" },
        { label: "Ajuste: cobro <duplicado> & otro", amount: "-5,00 USD" },
      ],
    })
    // Inclusión y orden: cada fila del detalle aparece una vez, antes del total.
    const detail = ["Clínica <Sonrisa> & Cía: 100,00 USD", "Clínica Norte: 23,45 USD", "Ajuste: cobro <duplicado> & otro: -5,00 USD"]
    const rows = mail.text.split("\n").filter((line) => detail.includes(line))
    expect(rows).toEqual(detail)
    for (const row of detail) {
      expect(mail.text.indexOf(row)).toBeLessThan(mail.text.indexOf("Total a pagarte: 118,45 USD"))
    }
    expect(mail).toMatchSnapshot()
    expect(mail.subject).toBe("Tu liquidación de septiembre de 2026")
    // Escape en HTML, texto plano intacto.
    expect(mail.html).not.toContain("<b>Ríos</b>")
    expect(mail.html).toContain("Jorge &lt;b&gt;Ríos&lt;/b&gt; &amp; Cía")
    expect(mail.html).not.toContain("Clínica <Sonrisa>")
    expect(mail.html).toContain("Clínica &lt;Sonrisa&gt; &amp; Cía")
    expect(mail.html).not.toContain("cobro <duplicado>")
    expect(mail.text).toContain("Total a pagarte: 118,45 USD")
    expect(mail.text).toContain("si algo no cuadra, escríbele a tu contacto en la administración")
    expect(mail.text).not.toContain("escríbenos desde Ayuda")
  })

  it("la víspera de la solo lectura con un comprobante en revisión no pide registrar otro", () => {
    const due = saasRestrictionSoonEmail({ clinic: "Clínica Sonrisa", amounts: ["S/ 100.00"], url })
    expect(due.text).toContain("sigue sin pagar")
    expect(due.html).toContain("Registrar mi comprobante")
    const review = saasRestrictionSoonEmail({ clinic: "Consultorio San Martín", amounts: ["S/ 100.00"], url, brand: "latidia", inReview: true })
    expect(review.subject).toBe("Mañana tu clínica pasa a solo lectura")
    expect(review.text).toContain("latidIA está revisando el comprobante de Consultorio San Martín")
    expect(review.text).toContain("Monto pendiente: S/ 100.00")
    expect(review.html).not.toContain("Registrar mi comprobante")
    expect(review.html).toContain("Ver Plan y pagos")
  })
})

describe("la invitación que manda el equipo", () => {
  const base = {
    firstName: "Ana",
    clinicName: "Clínica <Sonrisa>",
    email: "ana@clinicasonrisa.pe",
    url: "https://app.odentia32.com/register?invitation=abc",
    expiresText: "domingo 1 de noviembre",
  }

  it("dice la cuenta lista con el plan negociado, sus cifras y hasta cuándo vale, sin Fundadores ni lista de espera", () => {
    const mail = founderInvitationEmail({
      ...base,
      offer: { planName: "Especial", currency: "USD", priceCents: 0, trialCreditCents: 10_000, discountPercent: 50, guaranteeMonths: 12 },
      replyTo: "hola@odentia32.com",
    })
    expect(mail.subject).toBe("Tu cuenta en odentIA está lista")
    expect(mail.text).toContain("Te preparamos tu cuenta con Especial")
    expect(mail.text).toContain("USD 100 de regalo")
    expect(mail.text).toContain("sin cuota")
    expect(mail.text).toContain("50 % menos que el precio de lista")
    expect(mail.text).toContain("Esos precios valen 12 meses.")
    expect(mail.text).toContain("vence el domingo 1 de noviembre")
    expect(mail.text).toContain("responde este correo")
    expect(mail.html).toContain(`href="${base.url}"`)
    expect(mail.html).not.toContain("<Sonrisa>")
    for (const word of ["Fundador", "lista de espera", "pediste una invitación"]) expect(mail.text).not.toContain(word)
  })

  it("sin plan, descuento ni meses no los inventa; sin respuesta, se pide otro enlace a quien lo mandó", () => {
    const mail = founderInvitationEmail({
      ...base,
      offer: { currency: "USD", priceCents: 2900, trialCreditCents: 5_000, discountPercent: null, guaranteeMonths: null },
      brand: "latidia",
    })
    expect(mail.subject).toBe("Tu cuenta en latidIA está lista")
    expect(mail.text).toContain("Te preparamos tu cuenta con tu plan")
    expect(mail.text).toContain("con una cuota de USD 29 al mes")
    expect(mail.text).not.toContain("% menos")
    expect(mail.text).not.toContain("Esos precios valen")
    expect(mail.text).toContain("pídele otro a quien te escribió de latidIA")
  })
})
