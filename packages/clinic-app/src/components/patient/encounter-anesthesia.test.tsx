// @vitest-environment jsdom

/**
 * La línea de anestesia (QA del 16 nov, B5): sale de lo de hoy que usa anestesia local, dice sus
 * alergias, su medicación y lo que dijo del corazón (QA del 14 nov, A1), pide la ASA con un toque
 * y, con el peso, el máximo del anestésico elegido. Avisa y no frena.
 */
import type { Vitals } from "@odentia/clinical"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, expect, it, vi } from "vitest"
import { setOrgLocale } from "../../lib/locale"
import type { PatientHealth } from "../../lib/patients"

const setAsa = vi.hoisted(() => vi.fn())
vi.mock("../../lib/crm", () => ({ useMemberName: () => () => "Dra. Lucía Rojas" }))
vi.mock("../../lib/patients", async (original) => ({
  ...(await original<typeof import("../../lib/patients")>()),
  setPatientAsaApi: setAsa,
}))

const { AnesthesiaAtSigningView, anesthesiaAnswered, anesthesiaHealthWords, EncounterAnesthesiaLine } = await import("./encounter-anesthesia")

beforeAll(() => {
  setOrgLocale("es-PE", "America/Lima")
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => []
})
afterEach(cleanup)

const mateo = {
  allergies: [],
  conditions: [],
  medications: [],
  reviewStatus: { allergies: "none", conditions: "none", medications: "none" },
  asaClass: null,
} as unknown as PatientHealth

function line(props: {
  vitals?: Vitals | null
  ageYears?: number
  uses?: string[]
  atSign?: boolean
  weightFromOther?: boolean
  onAddWeight?: () => void
}) {
  const client = new QueryClient()
  return render(
    <QueryClientProvider client={client}>
      <EncounterAnesthesiaLine
        patientId="p-mateo"
        encounterId="e-1"
        uses={props.uses ?? ["Pulpectomía posterior, deciduo"]}
        asksAsa
        gaps={["asa"]}
        risks={[]}
        health={mateo}
        vitals={props.vitals === undefined ? { peso: 22 } : props.vitals}
        ageYears={props.ageYears ?? 7}
        anesthetic="lidocaina-2-epinefrina"
        onAnestheticChange={() => {}}
        canWrite
        atSign={props.atSign ?? false}
        weightFromOther={props.weightFromOther ?? false}
        onAddWeight={props.onAddWeight}
      />
    </QueryClientProvider>,
  )
}

it("Mateo, 22 kg, pulpectomía: pide la ASA con un toque y dice 96,8 mg, unos 2,6 cartuchos", async () => {
  setAsa.mockResolvedValue({ data: { ...mateo, asaClass: "II" } })
  line({ atSign: true })
  expect(screen.getByText("Anestesia local · Pulpectomía posterior, deciduo")).toBeTruthy()
  expect(
    screen.getByText(
      /Niega alergias, enfermedades y medicación\. Falta clasificar su riesgo anestésico \(ASA\)\. Puedes firmar igual\./,
    ),
  ).toBeTruthy()
  expect(
    screen.getByText(
      "Máximo para 22 kg con lidocaína 2 % con epinefrina (cartucho de 1,8 mL): 96,8 mg, unos 2,6 cartuchos.",
    ),
  ).toBeTruthy()
  // Sin cartuchos ni técnica: solo la ASA y el anestésico.
  expect(screen.queryByLabelText(/Cartuchos|Técnica/)).toBeNull()
  fireEvent.click(screen.getByRole("radio", { name: "ASA II" }))
  await waitFor(() => expect(setAsa).toHaveBeenCalledWith("p-mateo", "II", "e-1"))
})

it("sin peso no inventa un máximo: pide anotarlo", () => {
  line({ vitals: null, ageYears: 45, uses: ["Endodoncia posterior vital"] })
  expect(
    screen.getByText("Anota su peso en los signos vitales para ver la dosis máxima."),
  ).toBeTruthy()
  expect(screen.queryByText(/Máximo para/)).toBeNull()
})

// QA del 16 nov, Q18: el bloque entero (ASA, anestésico, dosis) ocupaba unos 260 px en la página y
// otra vez en el diálogo de firmar, aunque ya estuviera contestado.
it("contestada y sin nada que avisar va en dos líneas, con «Cambiar» que abre el bloque entero", () => {
  const client = new QueryClient()
  const healthy = {
    ...mateo,
    reviewStatus: { allergies: "none", conditions: "none", medications: "none" },
    asaClass: "I",
  } as unknown as PatientHealth
  const view = (health: PatientHealth, gaps: Array<"asa" | "allergies">) => (
    <QueryClientProvider client={client}>
      <EncounterAnesthesiaLine
        patientId="p-raul"
        encounterId="e-1"
        uses={["Endodoncia posterior vital"]}
        asksAsa
        gaps={gaps}
        risks={[]}
        health={health}
        vitals={{ peso: 78 }}
        ageYears={41}
        anesthetic="lidocaina-2-epinefrina"
        onAnestheticChange={() => {}}
        canWrite
      />
    </QueryClientProvider>
  )
  const page = render(view(healthy, []))
  // Lo mismo dicho en corto: la ASA, lo que niega y el máximo. Ningún control más que «Cambiar».
  expect(screen.getByText("Anestesia local · Endodoncia posterior vital")).toBeTruthy()
  expect(
    screen.getByText(/^ASA I · Niega alergias, enfermedades y medicación · Máximo para 78 kg .* 300 mg \(el tope\), unos 8,3 cartuchos\.$/),
  ).toBeTruthy()
  expect(screen.queryAllByRole("radio")).toHaveLength(0)
  expect(screen.queryByLabelText("Anestésico")).toBeNull()
  expect(page.container.querySelectorAll("button, select, input")).toHaveLength(1)
  fireEvent.click(screen.getByRole("button", { name: /Cambiar/ }))
  expect(screen.getAllByRole("radio")).toHaveLength(4)
  expect(screen.getByLabelText("Anestésico")).toBeTruthy()
  cleanup()
  // Con algo por preguntarle, el bloque va entero desde el principio: un aviso no se pliega.
  render(view(healthy, ["allergies"]))
  expect(screen.getAllByRole("radio")).toHaveLength(4)
})

it("una alergia, una enfermedad, lo que toma o lo que dijo del corazón dejan el bloque entero", () => {
  const base = {
    asksAsa: true,
    gaps: [],
    risks: [],
    warnings: [],
    today: "2026-11-16",
  }
  const healthy = { allergies: [], conditions: [], medications: [], asaClass: "II" } as unknown as PatientHealth
  expect(anesthesiaAnswered({ ...base, health: healthy })).toBe(true)
  expect(anesthesiaAnswered({ ...base, health: { ...healthy, asaClass: null } })).toBe(false)
  expect(
    anesthesiaAnswered({
      ...base,
      health: { ...healthy, allergies: [{ id: "a", substance: "Penicilina", isActive: true }] } as unknown as PatientHealth,
    }),
  ).toBe(false)
  expect(
    anesthesiaAnswered({
      ...base,
      health: { ...healthy, conditions: [{ id: "c", name: "Hipertensión", status: "activa" }] } as unknown as PatientHealth,
    }),
  ).toBe(false)
  expect(anesthesiaAnswered({ ...base, health: healthy, risks: ["tiene una válvula"] })).toBe(false)
  expect(anesthesiaAnswered({ ...base, health: healthy, warnings: ["Por su ASA III, la epinefrina…"] })).toBe(false)
  // Sin leer su salud todavía, no se da nada por contestado.
  expect(anesthesiaAnswered({ ...base, health: null })).toBe(false)
})

// QA del 18 nov (auditor H7 y novato 10).
it("el anestésico de los materiales va aparte de los procedimientos, en la línea y en la firmada", () => {
  line({ uses: ["Exodoncia simple", "Lidocaína 2% con epinefrina"] })
  expect(screen.getByText("Anestesia local · Exodoncia simple · Lidocaína 2% con epinefrina")).toBeTruthy()
  render(
    <AnesthesiaAtSigningView
      value={{
        uses: ["Exodoncia simple", "Lidocaína 2% con epinefrina"],
        asaClass: null,
        asaSetBy: null,
        asaSetAt: null,
        weightKg: null,
        anesthetic: null,
        dose: null,
        warnings: [],
      }}
    />,
  )
  expect(screen.getByText("Para Exodoncia simple")).toBeTruthy()
  expect(screen.getByText("Anestésico: Lidocaína 2% con epinefrina")).toBeTruthy()
  expect(screen.queryByText(/y Lidocaína/)).toBeNull()
})

it("sin peso, «Anotar su peso» lleva a los signos vitales; con el de otra atención de hoy, lo dice", () => {
  const onAddWeight = vi.fn()
  const { unmount } = line({ vitals: null, ageYears: 45, uses: ["Endodoncia posterior vital"], onAddWeight })
  fireEvent.click(screen.getByRole("button", { name: "Anotar su peso" }))
  expect(onAddWeight).toHaveBeenCalledTimes(1)
  unmount()
  line({ vitals: { peso: 80 }, ageYears: 45, uses: ["Endodoncia posterior vital"], weightFromOther: true })
  expect(screen.getByText(/Con el peso anotado hoy en otra atención\./)).toBeTruthy()
  expect(screen.queryByRole("button", { name: "Anotar su peso" })).toBeNull()
})

it("sin nada de hoy con anestesia, no hay línea", () => {
  const { container } = line({ uses: [] })
  expect(container.textContent).toBe("")
})

it("dice lo que tiene, lo que toma y lo que dijo del corazón", () => {
  const words = anesthesiaHealthWords(
    {
      allergies: [{ id: "a", substance: "Penicilina", isActive: true, severity: "moderada" }],
      conditions: [{ id: "c", name: "Hipertensión", status: "activa" }],
      medications: [{ id: "m", name: "Enalapril", dose: "10 mg" }],
      reviewStatus: { allergies: "recorded", conditions: "recorded", medications: "recorded" },
    } as unknown as PatientHealth,
    [],
    ["tiene una válvula, un problema del corazón de nacimiento o tuvo endocarditis"],
    "2026-11-16",
  )
  expect(words).toBe(
    "Alergia a Penicilina. Tiene Hipertensión. Toma Enalapril 10 mg. Dijo que tiene una válvula, un problema del corazón de nacimiento o tuvo endocarditis.",
  )
})
