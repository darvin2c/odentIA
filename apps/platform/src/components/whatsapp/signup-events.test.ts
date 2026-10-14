import { describe, expect, it } from "vitest"
import { fromFacebook, readSessionEvent } from "./signup-events"

/**
 * Los avisos de la ventana de Meta con la forma que publica su guía. No
 * acredita lo que la ventana real envía: todavía no se ha abierto ninguna.
 */
describe("de quién viene el aviso", () => {
  it("solo se escucha a facebook.com y sus subdominios, por https", () => {
    expect(fromFacebook("https://www.facebook.com")).toBe(true)
    expect(fromFacebook("https://business.facebook.com")).toBe(true)
    expect(fromFacebook("https://facebook.com")).toBe(true)
    // Terminar en «facebook.com» no basta: tiene que ser ese dominio.
    expect(fromFacebook("https://nofacebook.com")).toBe(false)
    expect(fromFacebook("https://facebook.com.ejemplo.test")).toBe(false)
    expect(fromFacebook("http://www.facebook.com")).toBe(false)
    expect(fromFacebook("null")).toBe(false)
    expect(fromFacebook("")).toBe(false)
  })
})

describe("cómo terminó la ventana de Meta", () => {
  const event = (name: string, data: Record<string, unknown>) => JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: name, data })

  it("terminó con cuenta y número", () => {
    expect(readSessionEvent(event("FINISH", { phone_number_id: "106540352242922", waba_id: "524126980791429", business_id: "2729063490586005" }))).toEqual({
      kind: "finished",
      wabaId: "524126980791429",
      phoneNumberId: "106540352242922",
    })
    // También si el número venía de la aplicación de WhatsApp Business de un teléfono.
    expect(readSessionEvent(event("FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", { phone_number_id: "1", waba_id: "2" }))).toMatchObject({ kind: "finished" })
    // Ya leído como objeto, o con los identificadores como número, vale igual.
    expect(readSessionEvent({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: { phone_number_id: 11, waba_id: 22 } })).toEqual({
      kind: "finished",
      wabaId: "22",
      phoneNumberId: "11",
    })
  })

  it("terminó sin número", () => {
    expect(readSessionEvent(event("FINISH_ONLY_WABA", { waba_id: "2" }))).toEqual({ kind: "no-number" })
    expect(readSessionEvent(event("FINISH", { waba_id: "2" }))).toEqual({ kind: "no-number" })
  })

  it("cerró la ventana sin terminar", () => {
    expect(readSessionEvent(event("CANCEL", { current_step: "PHONE_NUMBER_SETUP" }))).toEqual({ kind: "cancelled" })
  })

  it("reportó un error, o Meta avisó uno", () => {
    expect(
      readSessionEvent(event("CANCEL", { error_message: "Your verified name violates WhatsApp guidelines.", error_code: "524126", session_id: "f34b", timestamp: "1746041036" })),
    ).toEqual({ kind: "error", message: "Your verified name violates WhatsApp guidelines." })
    expect(readSessionEvent(event("ERROR", {}))).toEqual({ kind: "error", message: null })
  })

  it("lo que no es un aviso de este flujo se ignora", () => {
    expect(readSessionEvent("no es json")).toBeNull()
    expect(readSessionEvent(JSON.stringify({ type: "otro", event: "FINISH" }))).toBeNull()
    expect(readSessionEvent(event("ALGO_NUEVO", {}))).toBeNull()
    expect(readSessionEvent(null)).toBeNull()
    expect(readSessionEvent(42)).toBeNull()
  })
})
