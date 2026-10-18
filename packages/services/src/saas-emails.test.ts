import { configureMailLinks, resetMailLinks } from "@odentia/mail"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  saasAlertEmail,
  saasBillingUrl,
  saasOverdueEmail,
  saasPlanStartedEmail,
  saasRestrictedEmail,
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

  it("cada aviso con el molde común", () => {
    const mails = {
      alertaCredito: saasAlertEmail(
        {
          family: "credito",
          level: "aviso",
          periodKey: "2026-10-01",
          title: "Aviso",
          message: "Tus agentes usaron 76 % del crédito del mes.",
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

  it("la liquidación: montos con moneda, total destacado y el nombre escapado", () => {
    const mail = saasSettlementEmail({
      sellerName: "Jorge <b>Ríos</b> & Cía",
      monthText: "septiembre de 2026",
      clinics: 3,
      gross: "123,45 USD",
      adjustments: "-5,00 USD",
      total: "118,45 USD",
    })
    expect(mail).toMatchSnapshot()
    expect(mail.subject).toBe("Tu liquidación de septiembre de 2026")
    expect(mail.html).not.toContain("<b>Ríos</b>")
    expect(mail.html).toContain("Jorge &lt;b&gt;Ríos&lt;/b&gt; &amp; Cía")
    expect(mail.text).toContain("Total a pagarte: 118,45 USD")
    expect(mail.text).toContain("si algo no cuadra, escríbele a tu contacto en odentIA")
    expect(mail.text).not.toContain("escríbenos desde Ayuda")
  })
})
