import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  accessLinkTemplate,
  accountReminderTemplate,
  changeEmailConfirmationTemplate,
  changeEmailVerificationTemplate,
  configureMailLinks,
  invitationTemplate,
  LOGO_CIDS,
  legalUpdateTemplate,
  logoAttachments,
  type MailTemplate,
  passwordChangedTemplate,
  renderEmail,
  resetMailLinks,
  senderFor,
  staffInvitationTemplate,
  teamTwoFactorRequiredTemplate,
  supportInboxNoticeTemplate,
  supportReplyNoticeTemplate,
  verifyEmailTemplate,
} from "./index.js"

const URL = "https://app.odentia32.com/accion?token=abc&x=1"

/** Todas las plantillas de `@odentia/mail`, con datos de ejemplo; las de Plan y pagos y el libro viven en servicios. */
const TEMPLATES: Record<string, () => MailTemplate> = {
  verificar: () => verifyEmailTemplate({ url: URL }),
  confirmarCorreoNuevo: () => changeEmailVerificationTemplate({ url: URL }),
  autorizarCambioDeCorreo: () => changeEmailConfirmationTemplate({ newEmail: "lucia@nuevo.test", url: URL }),
  enlaceParaEntrar: () => accessLinkTemplate({ firstName: "Lucía", url: URL, expiresText: "9:42 (hora de Lima)" }),
  contrasenaCambio: () =>
    passwordChangedTemplate({ firstName: "Lucía", whenText: "9:12", deviceText: "Chrome en Windows", url: URL }),
  terminos: () =>
    legalUpdateTemplate({
      firstName: "Lucía",
      effectiveText: "1 de marzo de 2027",
      changes: ["Quién trata tus datos.", "Cómo se cobra por acción."],
      url: URL,
      replyTo: "soporte@odentia32.com",
    }),
  invitacion: () => invitationTemplate({ organizationName: "Clínica Sonrisa", inviterName: "María Pérez", url: URL }),
  invitacionAlPersonal: () => staffInvitationTemplate({ url: URL }),
  verificacionEnDosPasos: () =>
    teamTwoFactorRequiredTemplate({ firstName: "Lucía", organizationName: "Clínica Sonrisa", url: URL }),
  cuentaSinVerificar: () => accountReminderTemplate({ kind: "sin_verificar", url: URL, days: 7 }),
  cuentaSinClinica: () => accountReminderTemplate({ kind: "sin_clinica", url: URL }),
  soporteCasoNuevo: () =>
    supportInboxNoticeTemplate({
      kind: "caso_nuevo",
      clinic: "Clínica Sonrisa",
      caseKind: "problema",
      screen: "Automatizaciones",
      who: "Ana Torres",
      role: "Recepción",
      url: URL,
    }),
  soporteRespondio: () =>
    supportReplyNoticeTemplate({ kind: "respuesta", caseKind: "pregunta", topic: "Agenda", url: URL }),
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-10-18T12:00:00Z"))
  configureMailLinks("https://app.odentia32.com")
})

afterEach(() => {
  vi.useRealTimers()
  resetMailLinks()
})

describe("plantillas", () => {
  for (const [name, build] of Object.entries(TEMPLATES)) {
    it(`${name}: el molde común en HTML y en texto`, () => {
      const mail = build()
      expect(mail).toMatchSnapshot()
      // Molde común: documento completo, logotipo adjunto y pie con la firma.
      expect(mail.html).toMatch(/^<!doctype html>/)
      expect(mail.html).toContain('<meta charset="utf-8">')
      expect(mail.html).toContain(`cid:${LOGO_CIDS.logotipoClaro}`)
      expect(mail.html).toContain(`cid:${LOGO_CIDS.isotipoClaro}`)
      expect(mail.text).toContain("--\n")
      // Nunca una imagen remota.
      expect(mail.html).not.toMatch(/<img[^>]+src="https?:/)
    })
  }

  it("el primer enlace del correo es el botón (las pruebas e2e lo siguen)", () => {
    const mail = accessLinkTemplate({ url: URL })
    expect(mail.html.match(/href="([^"]+)"/)?.[1]).toBe(URL.replace("&", "&amp;"))
  })
})

describe("escape", () => {
  it("un nombre con <b> o & llega escrito tal cual y no rompe el correo", () => {
    const mail = invitationTemplate({
      organizationName: "Pérez & Hijos <b>",
      inviterName: `Ana "<script>"`,
      url: URL,
    })
    expect(mail.html).not.toContain("<b>")
    expect(mail.html).not.toContain("<script>")
    expect(mail.html).toContain("Pérez &amp; Hijos &lt;b&gt;")
    expect(mail.html).toContain("Ana &quot;&lt;script&gt;&quot;")
    expect(mail.text).toContain("Pérez & Hijos <b>")
    expect(mail.subject).toBe("Te invitaron a Pérez & Hijos <b>")
  })

  it("el enlace también va escapado en el atributo", () => {
    const mail = verifyEmailTemplate({ url: 'https://app.odentia32.com/x?a=1&b="2"' })
    expect(mail.html).toContain('href="https://app.odentia32.com/x?a=1&amp;b=&quot;2&quot;"')
  })
})

describe("pie", () => {
  it("lleva Términos, Privacidad, Ayuda y el © de la web de marketing", () => {
    const mail = verifyEmailTemplate({ url: URL })
    expect(mail.html).toContain('href="https://odentia32.com/terminos"')
    expect(mail.html).toContain('href="https://odentia32.com/privacidad"')
    expect(mail.html).toContain('href="https://odentia32.com/contacto"')
    expect(mail.html).toContain("© 2026 odentIA")
    expect(mail.text).toContain("odentIA · odentia32.com")
  })

  it("en local la web va en www.", () => {
    configureMailLinks("https://app.odentia.localhost")
    expect(verifyEmailTemplate({ url: URL }).html).toContain('href="https://www.odentia.localhost/terminos"')
  })

  it("sin configurar, el pie solo firma", () => {
    resetMailLinks()
    const mail = verifyEmailTemplate({ url: URL })
    expect(mail.html).not.toContain("/terminos")
    expect(mail.html).not.toContain("©")
  })

  it("un aviso interno lleva su etiqueta y no los enlaces del pie", () => {
    const mail = supportInboxNoticeTemplate({
      kind: "clinica_respondio",
      clinic: null,
      caseKind: "acceso",
      screen: "Entrar",
      who: "Ana",
      role: "",
      url: URL,
    })
    expect(mail.html).toContain("Interno · Soporte")
    expect(mail.html).not.toContain("/terminos")
    expect(mail.text).not.toContain("no recibe respuestas")
  })

  it("con buzón de respuesta dice adónde llega; sin él, que no se responde", () => {
    const withInbox = legalUpdateTemplate({ effectiveText: "1 de marzo", changes: ["Uno."], url: URL, replyTo: "soporte@odentia32.com" })
    expect(withInbox.replyTo).toBe("soporte@odentia32.com")
    expect(withInbox.text).toContain("responde este correo antes de esa fecha")
    expect(withInbox.text).toContain("Si respondes, tu mensaje llega al equipo de odentIA.")
    const without = legalUpdateTemplate({ effectiveText: "1 de marzo", changes: ["Uno."], url: URL })
    expect(without.replyTo).toBeUndefined()
    expect(without.text).toContain("escríbenos desde Ayuda antes de esa fecha")
    expect(without.text).toContain("Este correo no recibe respuestas")
  })
})

describe("variantes", () => {
  it("la banda de plazo y la de vencido, la ficha con total y las secciones", () => {
    const plazo = renderEmail({
      subject: "Plazo",
      preview: "p",
      title: "Plazo",
      band: { tone: "plazo", text: "Plazo: hasta el sábado" },
      paragraphs: ["Uno"],
      facts: [
        { label: "Cobros", value: "10,00 USD" },
        { label: "Total", value: "8,00 USD", total: true },
      ],
      sections: [{ title: "1. Datos", rows: [["Nombre", "Rosa\nQuispe"]] }],
      reason: "Porque sí.",
    })
    expect(plazo.html).toContain("#fdf3df")
    expect(plazo.html).toContain("Rosa<br>Quispe")
    expect(plazo.text).toContain("Total: 8,00 USD")
    expect(plazo.text).toContain("1. DATOS\nNombre: Rosa\nQuispe")
    const vencido = renderEmail({ ...{ subject: "V", preview: "v", title: "V", paragraphs: [], reason: "r" }, band: { tone: "vencido", text: "Ya pasó" } })
    expect(vencido.html).toContain("#fdeaea")
  })
})

describe("adjuntos", () => {
  it("adjunta solo las imágenes que el HTML nombra, en PNG: las de su marca", () => {
    for (const brand of ["odentia", "latidia"] as const) {
      const files = logoAttachments(verifyEmailTemplate({ url: URL, brand }).html)
      const own = Object.values(LOGO_CIDS).filter((cid) => cid.endsWith(`@${brand}`))
      expect(own).toHaveLength(4)
      expect(files.map((file) => file.cid).sort()).toEqual(own.sort())
      for (const file of files) {
        expect(file.contentType).toBe("image/png")
        // Firma PNG.
        expect([...file.content.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
      }
    }
    expect(logoAttachments("<p>sin logotipo</p>")).toEqual([])
  })

  it("latidIA (issue 229): su nombre, su morado, su remitente y su web en el pie", () => {
    configureMailLinks("https://app.odentia32.com", { latidia: "latidia72.com" })
    try {
      const mail = verifyEmailTemplate({ url: URL, brand: "latidia" })
      expect(mail.brand).toBe("latidia")
      expect(mail.html).toContain("Gracias por registrarte en latidIA.")
      expect(mail.html).toContain("#6d3fc0")
      expect(mail.html).not.toContain("odentIA")
      expect(mail.text).toContain("latidIA · latidia72.com")
      expect(senderFor("odentIA <no-reply@odentia32.com>", "latidia")).toBe("latidIA <no-reply@odentia32.com>")
      // odentIA, como siempre.
      const dental = verifyEmailTemplate({ url: URL })
      expect(dental.brand).toBeUndefined()
      expect(dental.text).toContain("odentIA · odentia32.com")
    } finally {
      resetMailLinks()
    }
  })
})
