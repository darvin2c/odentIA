import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { setOrgLocale } from "../../lib/locale"
import { HealthAtSigningList, healthAtSigningLines } from "./health-at-signing"

// Las fechas en el formato de la clínica, no en el de la máquina que corre la prueba (el CI está en inglés).
beforeAll(() => {
  setOrgLocale("es-PE", "America/Lima")
})
afterAll(() => {
  setOrgLocale(undefined, undefined)
})

// Auditor, 15 nov (A2): firmar con la warfarina sin revisar no dejaba nada en la atención firmada.
describe("«Lo que dijo de su salud al firmar»", () => {
  const yesterday = new Date(Date.now() - 86_400_000)
  yesterday.setUTCHours(17, 0, 0, 0)
  const groups = [
    {
      by: { kind: "patient" as const, name: null, relation: null },
      at: yesterday.toISOString(),
      rows: [
        { label: "Anticoagulante", value: "Warfarina 5 mg" },
        { label: "Alergias", value: "dijo que no" },
      ],
    },
  ]

  it("dice quién lo dijo y cuándo, con las palabras de la franja, y qué dijo, dato por dato", () => {
    const [line] = healthAtSigningLines(groups, "F")
    expect(line?.mark).toMatch(/^Lo dijo ella el \d{1,2} [a-z]+, sin revisar$/)
    expect(line?.items).toEqual(["Anticoagulante: Warfarina 5 mg", "Alergias: dijo que no"])
    // Lo que dijo quien habla por ella la nombra a ella, no a la paciente.
    const mother = healthAtSigningLines([{ ...groups[0]!, by: { kind: "representative", name: "Carla Paz", relation: "madre" } }], "F")
    expect(mother[0]?.mark).toMatch(/^Lo dijo su madre, Carla, el /)
  })

  it("la lista se lee igual en la atención firmada y en la Historia", () => {
    const page = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <HealthAtSigningList patientId="p1" groups={groups} />
      </QueryClientProvider>,
    ).replace(/<[^>]+>/g, " ")
    expect(page).toContain("Anticoagulante: Warfarina 5 mg")
    expect(page).toContain("sin revisar")
  })
})
