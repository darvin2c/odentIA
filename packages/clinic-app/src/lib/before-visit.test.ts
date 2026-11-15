import { beforeAll, describe, expect, it } from "vitest"
import { beforeVisitWords, healthToReviewWords } from "./before-visit"
import { setOrgLocale } from "./locale"

// Mesa de formularios del 13 nov, entrega 10 (C10): recepción sabe si respondió, sin ver qué.
describe("antes de su cita, para recepción", () => {
  beforeAll(() => void setOrgLocale("es-PE", "America/Lima", "PE"))
  const base = { appointmentId: "a1", startsAt: "2026-11-16T14:00:00.000Z" }
  const plain = (text: string) => text.replace(/\s/g, " ")

  it("respondió: el día, y que lo lee el equipo clínico", () => {
    expect(beforeVisitWords({ ...base, state: "respondio", answeredAt: "2026-11-13T19:27:00.000Z", linkSent: null })).toEqual({
      state: "respondió el 13 nov",
      detail: "Lo lee el equipo clínico.",
    })
  })

  it("por responder: cuándo y por dónde salió su enlace, o que aún no salió", () => {
    const words = beforeVisitWords({
      ...base,
      state: "por_responder",
      answeredAt: null,
      linkSent: { at: "2026-11-12T23:10:00.000Z", channel: "whatsapp" },
    })
    expect(words.state).toBe("por responder")
    expect(plain(words.detail)).toBe("su enlace se le envió por WhatsApp el 12 nov, 6:10 p. m.")
    expect(beforeVisitWords({ ...base, state: "por_responder", answeredAt: null, linkSent: null }).detail).toBe(
      "aún no se le envió su enlace",
    )
  })
})

// Decisión del dueño sobre la entrega 10: una línea neutra, sin qué dijo.
describe("declaró datos de su salud, para recepción", () => {
  beforeAll(() => void setOrgLocale("es-PE", "America/Lima", "PE"))
  it("dice el día y quién lo revisa, y sin sexo registrado no supone ninguno", () => {
    expect(healthToReviewWords("2026-11-14T15:00:00.000Z", "F")).toBe("Declaró datos de su salud el 14 nov: los revisa quien la atiende.")
    expect(healthToReviewWords("2026-11-14T15:00:00.000Z", "M")).toBe("Declaró datos de su salud el 14 nov: los revisa quien lo atiende.")
    expect(healthToReviewWords("2026-11-14T15:00:00.000Z", null)).toBe("Declaró datos de su salud el 14 nov: los revisa quien atiende al paciente.")
  })
})