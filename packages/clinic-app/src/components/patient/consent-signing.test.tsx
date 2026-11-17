// @vitest-environment jsdom

/**
 * La firma de la paciente no se pierde (QA del 16 nov, B7): el odontólogo nuevo, sin colegiatura,
 * la escribe en «Confirma que informaste» y se guarda en su perfil antes de firmar; volver atrás
 * conserva la firma de la paciente, y un rechazo del servidor por la colegiatura cae en su campo
 * sin pedirle a ella que firme otra vez.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { ConsentDocument } from "../../lib/clinical-forms"
import type { ProfessionalProfile } from "../../lib/encounters"
import { setOrgLocale } from "../../lib/locale"
import { bareProduct, declareProduct } from "../../product/product-ui"

const route = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>())
vi.mock("../../lib/api", async (original) => ({
  ...(await original<typeof import("../../lib/api")>()),
  apiFetch: route,
}))
vi.mock("../../lib/crm", () => ({ usePermission: () => true }))
vi.mock("../../lib/org", () => ({ useOrgProfile: () => ({ data: { countryCode: "PE" } }) }))

const { ApiError } = await import("../../lib/api")
const { ConsentSigningScreen } = await import("./consent-signing")

declareProduct(bareProduct("dental"))

const document = {
  id: "consent-1",
  titleSnapshot: "Tratamiento de conductos (endodoncia)",
  bodySnapshot: "Le explicaron el tratamiento.",
  sectionsSnapshot: null,
  declarationSnapshot: null,
  procedureRef: null,
  diagnosisCode: null,
  personSignedAt: null,
} as unknown as ConsentDocument

const newProfile: ProfessionalProfile = {
  userId: "u-demo",
  accountName: "Dr. Demo Odontólogo",
  signatureName: null,
  professionalTitle: "",
  registrationBody: "",
  registrationNumber: null,
  specialtyRegistration: null,
  complete: false,
  updatedAt: null,
}

let profile: ProfessionalProfile
/** Falso: el perfil no queda con la colegiatura (otra pestaña la quitó). */
let savesProfile = true
/** Los representantes legales vigentes de Carmen: con uno, primero se elige quién firma. */
let representatives: unknown[] = []
let sign: (body: Record<string, unknown>) => Promise<unknown>

beforeAll(() => {
  setOrgLocale("es-PE", "America/Lima")
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => []
  // El recuadro de firma captura el puntero; jsdom no lo tiene.
  HTMLElement.prototype.setPointerCapture ??= () => {}
  Element.prototype.scrollIntoView ??= () => {}
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as typeof HTMLCanvasElement.prototype.getContext
})

beforeEach(() => {
  profile = { ...newProfile }
  savesProfile = true
  representatives = []
  sign = async () => ({ data: { ...document, pdfDocumentId: "pdf-1" } })
  route.mockReset()
  route.mockImplementation(async (url, init) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    if (url === "/api/patients/p-carmen")
      return {
        data: {
          patient: {
            displayName: "Carmen Ruiz",
            docType: null,
            docNumber: null,
            patientNumber: 12,
          },
          contacts: [{ relationship: "self", contactId: "c-carmen", displayName: "Carmen Ruiz" }],
          isMinor: false,
        },
      }
    if (url === "/api/patients/p-carmen/responsibilities") return { data: representatives }
    if (url === "/api/clinical-forms/consent-sheet")
      return {
        data: { clinic: null, declaration: "Declaro que me explicaron.", signatureNote: "" },
      }
    if (url === "/api/clinical-forms/professionals/me/profile" && init?.method === "PUT") {
      const saved = {
        ...profile,
        ...body,
        complete: Boolean(body.registrationNumber),
      } as ProfessionalProfile
      if (savesProfile) profile = saved
      return { data: saved }
    }
    if (url === "/api/clinical-forms/professionals/me/profile") return { data: profile }
    if (url === "/api/clinical-forms/consents/consent-1/sign") return sign(body)
    throw new Error(`sin ruta: ${url}`)
  })
})

afterEach(cleanup)

function open(onSigned = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ConsentSigningScreen
        open
        documents={[document]}
        patientId="p-carmen"
        onClose={() => {}}
        onSigned={onSigned}
      />
    </QueryClientProvider>,
  )
  return onSigned
}

/** Carmen marca la casilla y firma con el dedo. */
async function carmenSigns() {
  fireEvent.click(await screen.findByRole("checkbox", { name: /Entendí lo que me explicaron/ }))
  const pad = screen.getByRole("img", { name: "Firma de Carmen Ruiz" })
  fireEvent.pointerDown(pad, { clientX: 10, clientY: 10, pointerId: 1 })
  fireEvent.pointerMove(pad, { clientX: 40, clientY: 20, pointerId: 1 })
  fireEvent.pointerUp(pad, { pointerId: 1 })
  fireEvent.click(screen.getByRole("button", { name: "Listo" }))
  await screen.findByText(/Informé a Carmen y resolví sus dudas/)
}

/** Lo que pide el perfil, como lo escribe el odontólogo nuevo. */
function writeRegistration(number: string) {
  fireEvent.change(screen.getByLabelText("Título profesional"), {
    target: { value: "Cirujano dentista" },
  })
  fireEvent.change(screen.getByLabelText("Colegio"), { target: { value: "COP" } })
  fireEvent.change(screen.getByLabelText("Número de colegiatura"), { target: { value: number } })
}

describe("«Confirma que informaste» sin colegiatura", () => {
  it("la pide ahí mismo, la guarda en su perfil y firma: Carmen firmó una sola vez", async () => {
    const onSigned = open()
    await carmenSigns()
    // No dice «Firmas como…» sin colegiatura: pide los mismos campos que el cierre.
    expect(screen.queryByText(/Firmas como/)).toBeNull()
    expect(screen.getByText("Falta tu colegiatura para firmar")).toBeTruthy()
    expect(
      screen.getByText("Se guarda en tu perfil profesional: no la volverá a pedir."),
    ).toBeTruthy()
    // Lo que firmó va dentro de la tarjeta, junto a lo que se confirma.
    const card = screen.getByText(/Informé a Carmen/).closest("div")
    expect(card?.textContent).toContain(
      "Lo que firmó Carmen: Tratamiento de conductos (endodoncia)",
    )

    writeRegistration("12345")
    const signs = vi.fn(sign)
    sign = signs
    fireEvent.click(screen.getByRole("button", { name: "Guardar y confirmar" }))
    await waitFor(() => expect(onSigned).toHaveBeenCalled())
    // Primero el perfil, después la firma, con el trazo de Carmen.
    const order = route.mock.calls.map(([url, init]) => `${init?.method ?? "GET"} ${url}`)
    expect(order.indexOf("PUT /api/clinical-forms/professionals/me/profile")).toBeLessThan(
      order.indexOf("POST /api/clinical-forms/consents/consent-1/sign"),
    )
    expect(profile.registrationNumber).toBe("12345")
    expect(signs).toHaveBeenCalledTimes(1)
    const [body] = signs.mock.calls[0] ?? []
    expect((body?.signatureData as { strokes: unknown[] } | undefined)?.strokes.length).toBe(1)
  })

  it("con un número mal escrito, «Volver» conserva la firma de Carmen", async () => {
    open()
    await carmenSigns()
    // QA del 16 nov, Q8 (B7c): «abc» se aceptaba y quedó «COP abc» en un consentimiento firmado.
    writeRegistration("abc")
    fireEvent.click(screen.getByRole("button", { name: "Guardar y confirmar" }))
    expect(
      await screen.findByText(/El número de colegiatura lleva solo números/),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Volver" }))
    // Su hoja vuelve con la firma puesta: no se le pide otra vez.
    expect(await screen.findByText("¿No quedó bien? Usa «Limpiar» y vuelve a firmar.")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Listo" }))
    await screen.findByText(/Informé a Carmen y resolví sus dudas/)
    expect(screen.queryByText(/Falta la firma de Carmen/)).toBeNull()
  })

  it("si el servidor rechaza la colegiatura, el aviso va en el número y la firma sigue", async () => {
    open()
    await carmenSigns()
    writeRegistration("12345")
    sign = async () => {
      throw new ApiError(409, {
        code: "PROFILE_INCOMPLETE",
        message: "Registra tu colegiatura en tu perfil profesional para firmar",
      })
    }
    // El perfil no quedó con la colegiatura (otra pestaña la quitó): el servidor no deja firmar.
    savesProfile = false
    fireEvent.click(screen.getByRole("button", { name: "Guardar y confirmar" }))
    expect(
      await screen.findByText("Registra tu colegiatura en tu perfil profesional para firmar"),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Volver" }))
    expect(await screen.findByText("¿No quedó bien? Usa «Limpiar» y vuelve a firmar.")).toBeTruthy()
  })
})

describe("«Volver» a «¿Quién firma?»", () => {
  /** Quien firma marca la casilla y traza su firma, sin pasar todavía de hoja. */
  async function marksAndDraws(name: string) {
    fireEvent.click(await screen.findByRole("checkbox", { name: /Entendí lo que me explicaron/ }))
    const pad = screen.getByRole("img", { name: `Firma de ${name}` })
    fireEvent.pointerDown(pad, { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(pad, { clientX: 40, clientY: 20, pointerId: 1 })
    fireEvent.pointerUp(pad, { pointerId: 1 })
    await screen.findByText("¿No quedó bien? Usa «Limpiar» y vuelve a firmar.")
  }

  async function chooses(label: RegExp) {
    fireEvent.click(await screen.findByRole("combobox", { name: /¿Quién firma\?/ }))
    const option = await screen.findByRole("option", { name: label })
    fireEvent.pointerDown(option, { pointerType: "mouse" })
    fireEvent.click(option)
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: /¿Quién firma\?/ }).textContent).toMatch(label),
    )
    fireEvent.click(screen.getByRole("button", { name: "Empezar" }))
  }

  beforeEach(() => {
    profile = {
      ...newProfile,
      professionalTitle: "Cirujano dentista",
      registrationBody: "COP",
      registrationNumber: "12345",
      complete: true,
    }
    representatives = [
      {
        id: "r-rosa",
        kind: "representante_legal",
        isCurrent: true,
        contact: {
          id: "c-rosa",
          displayName: "Rosa Ruiz",
          isActive: true,
          docType: "dni",
          docNumber: "44556677",
        },
      },
    ]
  })

  it("si se elige a otra persona, la casilla y la firma de Carmen no pasan a Rosa", async () => {
    open()
    await chooses(/Carmen Ruiz · paciente/)
    await marksAndDraws("Carmen Ruiz")
    fireEvent.click(screen.getByRole("button", { name: "Volver" }))
    await chooses(/Rosa Ruiz · representante legal/)
    // La hoja de Rosa empieza en blanco: ni la casilla ni el trazo de Carmen.
    await screen.findByRole("img", { name: "Firma de Rosa Ruiz" })
    expect(
      screen
        .getByRole("checkbox", { name: /Entendí lo que me explicaron/ })
        .getAttribute("aria-checked"),
    ).toBe("false")
    expect(screen.queryByText("¿No quedó bien? Usa «Limpiar» y vuelve a firmar.")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Listo" }))
    expect(await screen.findByText("Falta la firma de Rosa")).toBeTruthy()
  })

  it("si se vuelve a elegir a la misma persona, su firma sigue en la hoja", async () => {
    open()
    await chooses(/Carmen Ruiz · paciente/)
    await marksAndDraws("Carmen Ruiz")
    fireEvent.click(screen.getByRole("button", { name: "Volver" }))
    fireEvent.click(await screen.findByRole("button", { name: "Empezar" }))
    expect(await screen.findByText("¿No quedó bien? Usa «Limpiar» y vuelve a firmar.")).toBeTruthy()
  })
})

it("con colegiatura no pide nada y dice con qué firma", async () => {
  profile = {
    ...newProfile,
    professionalTitle: "Cirujano dentista",
    registrationBody: "COP",
    registrationNumber: "12345",
    complete: true,
  }
  route.mockImplementation(async (url, init) => {
    if (url === "/api/clinical-forms/professionals/me/profile") return { data: profile }
    if (url === "/api/patients/p-carmen")
      return {
        data: {
          patient: {
            displayName: "Carmen Ruiz",
            docType: null,
            docNumber: null,
            patientNumber: 12,
          },
          contacts: [{ relationship: "self", contactId: "c-carmen", displayName: "Carmen Ruiz" }],
          isMinor: false,
        },
      }
    if (url === "/api/patients/p-carmen/responsibilities") return { data: [] }
    if (url === "/api/clinical-forms/consent-sheet")
      return {
        data: { clinic: null, declaration: "Declaro que me explicaron.", signatureNote: "" },
      }
    if (url === "/api/clinical-forms/consents/consent-1/sign" && init?.method === "POST")
      return { data: { ...document, pdfDocumentId: "pdf-1" } }
    throw new Error(`sin ruta: ${url}`)
  })
  const onSigned = open()
  await carmenSigns()
  expect(screen.queryByText("Falta tu colegiatura para firmar")).toBeNull()
  expect(
    screen.getByText(/Firmas como Dr\. Demo Odontólogo · Cirujano dentista · COP 12345/),
  ).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Confirmar" }))
  await waitFor(() => expect(onSigned).toHaveBeenCalled())
  expect(route.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false)
})
