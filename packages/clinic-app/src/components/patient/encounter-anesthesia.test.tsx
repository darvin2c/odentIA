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

const { anesthesiaHealthWords, EncounterAnesthesiaLine } = await import("./encounter-anesthesia")

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
