import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { type PersonalLinkView, withLinkViewDefaults } from "../../lib/booking-link"
import { draftUntilWords, personalLinkDraftKey, readDeviceDraft, sweepDeviceDrafts, writeDeviceDraft } from "../../lib/device-draft"
import { setOrgLocale } from "../../lib/locale"
import { bareProduct, declareProduct } from "../../product/product-ui"
import { unsignableWords } from "./link-steps"
import {
  beforeVisitCard,
  type DraftOnDevice,
  pendingItems,
  toldWords,
  validatePersonalLinkSearch,
  whatFollows,
} from "./personal-link-page"

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
    visit: null,
    told: null,
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
    // Confirmar esa cita va primero: es el botón principal.
    expect(after.next.map((item) => item.key)).toEqual(["cita", "datos"])
    expect(after.next[0]).toMatchObject({ abre: "cita", next: "Confirmar tu cita" })
    // El implante es de otra cita: queda para «Ver tus pendientes».
    expect(after.more).toBe(true)
    const confirmed = view({ consents: [] })
    const alone = whatFollows({ ...confirmed, appointment: confirmed.appointment && { ...confirmed.appointment, confirmed: true, canConfirm: false } }, { key: "datos", at: THURSDAY })
    expect(alone).toEqual({ next: [], more: false })
  })

  it("confirmar es solo de la cita de lo que terminó, y con el nombre de quien se atiende", () => {
    // El implante es de otra cita: confirmar la del jueves no es lo que sigue.
    expect(whatFollows(view(), { key: "firma:c2", at: LATER }).next).toEqual([])
    expect(whatFollows(view({ patientFirstName: "Mateo" }), { key: "datos", at: THURSDAY }).next[0]?.next).toBe("Confirmar la cita de Mateo")
  })

  it("lo aceptado sin cita también es algo más fuera de esa cita", () => {
    const after = whatFollows(view({ consents: [], data: null, toSchedule: [{ planItemId: "p1", title: "Corona" }] }), { key: "x", at: THURSDAY })
    expect(after.next.map((item) => item.key)).toEqual(["cita"])
    expect(after.more).toBe(true)
  })
})

// Mesa de formularios del 13 nov, entrega 8 (C2): antes había dos tarjetas y dos envíos.
describe("antes de su cita, una sola tarjeta", () => {
  const questions = { reason: true, pain: true, more: true }
  it("junta sus datos, su salud y su visita, y dice quién lo lee", () => {
    const items = pendingItems(
      view({ consents: [], data: { missing: [{ key: "birthDate", label: "Fecha de nacimiento" }], health: true }, visit: { purpose: null, questions } }),
      "odontólogo",
    )
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      abre: "datos",
      title: "Antes de tu cita",
      text: "Tus datos, tu salud, tus medicinas y a qué vienes.",
      detail: "Lo lee la Dra. Díaz antes de atenderte.",
      action: "Empezar",
    })
  })

  it("en una sesión le dice a qué viene; solo su visita es opcional", () => {
    const card = beforeVisitCard(
      view({ data: null, visit: { purpose: "sesión 2 de endodoncia", questions: { reason: false, pain: true, more: false } } }),
      "odontólogo",
    )
    expect(card).toMatchObject({ badge: "Opcional", text: "Vienes a: sesión 2 de endodoncia. Cuéntanos si te duele algo." })
  })

  it("sin cita por venir, sus datos siguen siendo «Tus datos»", () => {
    const items = pendingItems(view({ consents: [], appointment: null, visit: null }), "odontólogo")
    expect(items[0]).toMatchObject({ title: "Tus datos", action: "Completar" })
  })

  it("los enlaces que abrían el cuestionario de antes siguen abriendo", () => {
    expect(validatePersonalLinkSearch({ token: "t", abre: "cuestionario" })).toMatchObject({ abre: "cuestionario" })
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
    expect(unsignableWords({ why: "sin-fecha", speaksTo: "representante", patientFirstName: "Mateo" }).notice).toBe("Este lo firmas tú en la cita de Mateo, antes de empezar.")
    // Sin documento en su ficha: lo completa en «Tus datos» y firma aquí, sea paciente o quien decide por él.
    expect(unsignableWords({ why: "sin-documento", speaksTo: "representante", patientFirstName: "Mateo" }).notice).toBe("Para firmar desde aquí, primero completa tus datos.")
    expect(unsignableWords({ why: "sin-documento", speaksTo: "paciente", patientFirstName: "Rosa" }).inPlace).toBe("Firmas aquí cuando completes tus datos")
    expect(unsignableWords({ why: "menor", speaksTo: "paciente", patientFirstName: "Mateo" }).inPlace).toBe("Lo firma tu madre, padre o tutor en tu cita")
    expect(unsignableWords({ why: "sin-fecha", speaksTo: "paciente", patientFirstName: "Rosa" }).inPlace).toBe("Lo firmas en tu cita")
  })
})

// Mesa de formularios del 13 nov (C8): al volver a abrir el enlace no quedaba rastro de lo enviado.
describe("lo que nos contaste", () => {
  /** Los espacios de las horas («2:27 p. m.») son especiales: se comparan como espacios. */
  const plain = (text: string) => text.replace(/\s/g, " ")
  const SENT = "2026-11-13T19:27:00.000Z"
  const LATER_SENT = "2026-11-13T19:31:00.000Z"
  const told = (items: NonNullable<PersonalLinkView["told"]>["items"]) => ({ timeZone: "America/Lima", items })
  // La página fija el formato de la clínica al abrir el enlace.
  beforeAll(() => void setOrgLocale("es-PE", "America/Lima", "PE"))

  it("sin nada enviado no hay tarjeta", () => {
    expect(toldWords(view(), "odontólogo")).toBeNull()
  })

  it("dice qué envió y cuándo, junto lo del mismo envío, y quién lo lee", () => {
    const words = toldWords(
      view({ told: told([{ what: "datos", at: SENT }, { what: "salud", at: SENT }, { what: "visita", at: LATER_SENT }]) }),
      "odontólogo",
    )
    expect(words?.sent.map(plain)).toEqual([
      "Enviaste tus datos y tu salud el viernes, 13 de noviembre, 2:27 p. m.",
      "Enviaste lo de tu visita el viernes, 13 de noviembre, 2:31 p. m.",
    ])
    expect(words?.reader).toBe("Lo lee la Dra. Díaz antes de atenderte.")
  })

  it("quién lo lee: con «Dr.» lleva «el», sin tratamiento va el nombre, y sin nombre, quien atiende en su clínica", () => {
    const sent = told([{ what: "salud", at: SENT }])
    const withDoctor = (professionalName: string, clinician = "odontólogo") => {
      const base = view({ told: sent })
      return toldWords({ ...base, appointment: base.appointment && { ...base.appointment, professionalName } }, clinician)?.reader
    }
    expect(withDoctor("Dr. Luis Prado")).toBe("Lo lee el Dr. Luis Prado antes de atenderte.")
    expect(withDoctor("Luis Prado")).toBe("Lo lee Luis Prado antes de atenderte.")
    expect(withDoctor("", "médico")).toBe("Lo lee tu médico antes de atenderte.")
    expect(withDoctor("", "optómetra")).toBe("Lo lee tu optómetra antes de atenderte.")
  })

  // Revisión de la entrega 3: sin una cita por venir no hay «antes de atenderte» que prometer.
  it("sin cita por venir dice qué envió y cuándo, y no promete quién lo lee antes de atenderla", () => {
    const sent = told([{ what: "salud", at: SENT }])
    const none = toldWords(view({ told: sent, appointment: null }), "médico")
    expect(none?.sent.map(plain)).toEqual(["Enviaste tu salud el viernes, 13 de noviembre, 2:27 p. m."])
    expect(none?.reader).toBeNull()
    const cancelled = view({ told: sent })
    expect(toldWords({ ...cancelled, appointment: cancelled.appointment && { ...cancelled.appointment, cancelled: true } }, "optómetra")?.reader).toBeNull()
  })

  it("por un hijo, con su nombre", () => {
    const words = toldWords(
      view({ patientFirstName: "Mateo", told: told([{ what: "datos", at: SENT }, { what: "salud", at: SENT }, { what: "visita", at: SENT }]) }),
      "odontólogo",
    )
    expect(words?.sent.map(plain)).toEqual([
      "Enviaste los datos de Mateo, su salud y lo de la visita de Mateo el viernes, 13 de noviembre, 2:27 p. m.",
    ])
    expect(words?.reader).toBe("Lo lee la Dra. Díaz antes de atender a Mateo.")
  })
})

describe("mientras dura la entrega", () => {
  it("la vista de la API anterior, sin los campos nuevos, no rompe la página ni ofrece «Reservar otra»", () => {
    const { toSchedule, another, confirmVia, remindersVia, closed, told, visit, ...old } = view({
      consents: [{ id: "c1", title: "Exodoncia" } as PersonalLinkView["consents"][number]],
    })
    const ready = withLinkViewDefaults(old as PersonalLinkView)
    expect(ready).toMatchObject({ toSchedule: [], another: null, confirmVia: null, remindersVia: null, closed: null, told: null, visit: null })
    // Antes se firmaba siempre desde el teléfono.
    expect(ready.consents).toEqual([{ id: "c1", title: "Exodoncia", procedureRef: null, appointment: null, signable: true, why: null }])
    expect(() => whatFollows(ready, { key: "datos", at: THURSDAY })).not.toThrow()
    expect(() => whatFollows(old as PersonalLinkView, { key: "datos", at: THURSDAY })).toThrow()
  })
})

// Mesa de formularios del 13 nov, entrega 9 (C8): si la interrumpen, lo escrito sigue en su celular.
describe("si la interrumpen, lo escrito sigue en su celular", () => {
  const questions = { reason: true, pain: true, more: true }
  const marta = () =>
    view({
      firstName: "Marta",
      consents: [],
      data: { missing: [], health: true },
      visit: { purpose: null, questions },
    })
  /** El almacenamiento de su celular, en memoria. */
  const phone = () => {
    const items = new Map<string, string>()
    return {
      get length() {
        return items.size
      },
      clear: () => items.clear(),
      getItem: (key: string) => items.get(key) ?? null,
      key: (index: number) => [...items.keys()][index] ?? null,
      removeItem: (key: string) => void items.delete(key),
      setItem: (key: string, value: string) => void items.set(key, value),
    } as Storage
  }
  const token = "token-de-marta"
  const key = personalLinkDraftKey("dental-smile", token, THURSDAY)
  /** Lo que la tarjeta lee de su celular al abrir el enlace, como la página. */
  const onDevice = (): DraftOnDevice | null => {
    sweepDeviceDrafts()
    const saved = readDeviceDraft(key)
    return saved ? { step: saved.step, until: draftUntilWords(saved.expiresAt, Date.now(), "es-PE", "America/Lima") } : null
  }
  const CALL = new Date("2026-11-11T14:15:00-05:00").getTime()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(CALL)
    vi.stubGlobal("window", { localStorage: phone(), sessionStorage: phone() })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("C8: cierra en el paso 3 y vuelve una hora después: la tarjeta dice dónde iba y un toque sigue", () => {
    writeDeviceDraft(key, { medicationsText: "warfarina 5 mg" }, { item: "medicines", current: 3, total: 6 })
    vi.setSystemTime(CALL + 60 * 60 * 1000)
    const [card] = pendingItems(marta(), "odontólogo", onDevice())
    expect(card).toMatchObject({
      abre: "datos",
      title: "Antes de tu cita",
      badge: "Sin enviar",
      text: "Vas en el paso 3 de 6",
      action: "Seguir donde ibas",
      resume: true,
    })
    expect(card?.detail?.replace(/\s/g, " ")).toBe(
      "Lo que escribiste sigue guardado en este celular hasta mañana, 2:15 p. m. Todavía no lo enviaste.",
    )
    // Nunca lo que escribió.
    expect(JSON.stringify(card)).not.toContain("warfarina")
    // «Seguir donde ibas» abre el recorrido con lo escrito y su paso, sin volver a preguntar.
    expect(validatePersonalLinkSearch({ token, abre: "datos", sigue: 1 })).toMatchObject({ abre: "datos", sigue: true })
  })

  it("dos días después ya no está, y la tarjeta no promete otra cosa", () => {
    writeDeviceDraft(key, { medicationsText: "warfarina 5 mg" }, { item: "medicines", current: 3, total: 6 })
    vi.setSystemTime(CALL + 2 * 24 * 60 * 60 * 1000)
    const [card] = pendingItems(marta(), "odontólogo", onDevice())
    expect(card).toMatchObject({ title: "Antes de tu cita", action: "Empezar" })
    expect(card?.resume).toBeUndefined()
    expect(JSON.stringify(card)).not.toMatch(/guardado|paso 3/)
    // Y ya no está en su celular.
    expect(window.localStorage.length).toBe(0)
  })

  it("desde el celular de su hija (sin nada guardado), empieza en blanco", () => {
    expect(pendingItems(marta(), "odontólogo", onDevice())[0]).toMatchObject({ action: "Empezar" })
  })

  it("al terminar otra cosa, lo que sigue también dice «seguir donde ibas»", () => {
    const after = whatFollows(
      view({ data: { missing: [], health: true }, visit: { purpose: null, questions } }),
      { key: "firma:c1", at: THURSDAY },
      { step: { item: "medicines", current: 3, total: 6 }, until: "hasta mañana, 2:15 p. m." },
    )
    expect(after.next.find((item) => item.key === "datos")).toMatchObject({ next: "Antes de tu cita: seguir donde ibas", resume: true })
  })

  it("una dirección sin «sigue» no repone sola", () => {
    expect(validatePersonalLinkSearch({ token, abre: "datos" }).sigue).toBeUndefined()
    expect(validatePersonalLinkSearch({ token, abre: "datos", sigue: "no" }).sigue).toBeUndefined()
  })
})
