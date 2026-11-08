import { describe, expect, it } from "vitest"
import type { PersonalLinkView } from "../../lib/booking-link"
import { bareProduct, declareProduct } from "../../product/product-ui"
import { unsignableWords } from "./link-steps"
import { validatePersonalLinkSearch, whatFollows } from "./personal-link-page"

declareProduct(bareProduct("dental"))

const THURSDAY = "2026-11-12T15:00:00.000Z"
const LATER = "2026-11-26T15:00:00.000Z"

function view(patch: Partial<PersonalLinkView> = {}): PersonalLinkView {
  return {
    status: "abierto",
    clinicName: "Dental Smile",
    locale: "es-PE",
    countryCode: "PE",
    firstName: "Rosa",
    patientFirstName: null,
    expiresAt: LATER,
    booking: null,
    branches: [],
    appointment: {
      startsAt: THURSDAY,
      endsAt: "2026-11-12T15:30:00.000Z",
      timeZone: "America/Lima",
      durationMin: 30,
      branchId: "b1",
      cancelled: false,
      confirmed: false,
      canChange: true,
      canConfirm: true,
      branchName: "Miraflores",
      branchAddress: null,
      branchDirectionsUrl: null,
      professionalName: "Dra. Díaz",
      serviceName: null,
    },
    data: { missing: [{ key: "birthDate", label: "Fecha de nacimiento" }], health: false },
    you: null,
    pending: null,
    budgets: [],
    consents: [
      { id: "c1", title: "Exodoncia", procedureRef: "Pieza 38", appointment: { startsAt: THURSDAY, timeZone: "America/Lima" }, signable: true, why: null },
      { id: "c2", title: "Implante", procedureRef: null, appointment: { startsAt: LATER, timeZone: "America/Lima" }, signable: true, why: null },
    ],
    questionnaire: null,
    toSchedule: [],
    another: null,
    confirmVia: null,
    remindersVia: null,
    closed: null,
    messages: null,
    ...patch,
  }
}

describe("al terminar algo", () => {
  it("sigue lo de esa misma cita y «Ver tus pendientes» solo si hay algo fuera de ella", () => {
    const after = whatFollows(view(), { key: "firma:c1", at: THURSDAY })
    expect(after.next.map((item) => item.key)).toEqual(["datos"])
    // El implante es de otra cita: queda para «Ver tus pendientes».
    expect(after.more).toBe(true)
    const alone = whatFollows(view({ consents: [] }), { key: "datos", at: THURSDAY })
    expect(alone).toEqual({ next: [], more: false })
  })

  it("lo aceptado sin cita también es algo más fuera de esa cita", () => {
    const after = whatFollows(view({ consents: [], data: null, toSchedule: [{ planItemId: "p1", title: "Corona" }] }), { key: "x", at: THURSDAY })
    expect(after).toEqual({ next: [], more: true })
  })
})

describe("la dirección", () => {
  it("abre solo lo que conoce, y el id es de una cosa", () => {
    expect(validatePersonalLinkSearch({ token: "t", abre: "firma", id: "6f0c1e8a-6c4c-4f43-9a5d-0d6f3f1d2b3c" })).toMatchObject({ abre: "firma", id: "6f0c1e8a-6c4c-4f43-9a5d-0d6f3f1d2b3c" })
    expect(validatePersonalLinkSearch({ token: "t", abre: "historia", id: "1; drop" })).toMatchObject({ abre: undefined, id: undefined })
  })
})

describe("sin firmar desde el teléfono", () => {
  it("le habla a quien abre: al tutor por el nombre del paciente, al propio menor y a la persona", () => {
    expect(unsignableWords({ why: "sin-documento", speaksTo: "representante", patientFirstName: "Mateo" }).notice).toBe("Este lo firmas tú en la cita de Mateo, antes de empezar.")
    expect(unsignableWords({ why: "menor", speaksTo: "paciente", patientFirstName: "Mateo" }).inPlace).toBe("Lo firma tu madre, padre o tutor en tu cita")
    expect(unsignableWords({ why: "sin-fecha", speaksTo: "paciente", patientFirstName: "Rosa" }).inPlace).toBe("Lo firmas en tu cita")
  })
})
