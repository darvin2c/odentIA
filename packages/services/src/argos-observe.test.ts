import { describe, expect, it } from "vitest"
import type { ArgosNames } from "./argos-figures.js"
import { argosResultForModel } from "./argos-observe.js"

const NAMES: ArgosNames = {
  sedes: ["Sede Surco"],
  equipo: ["Dra. Ana Torres"],
  especialidades: [],
  servicios: [{ name: "Exodoncia simple", specialty: null }],
  productos: [],
}

describe("lo que Argos ve de un resultado (D20)", () => {
  it("ve cifras, fechas y nombres de la clínica; las personas llegan tapadas y siempre con el mismo número", () => {
    const text = argosResultForModel(
      "c1",
      {
        columns: [
          { name: "paciente", kind: "text" },
          { name: "quien", kind: "text" },
          { name: "profesional", kind: "text" },
          { name: "estado", kind: "text" },
          { name: "saldo_dinero", kind: "number" },
          { name: "paciente_id", kind: "text" },
        ],
        rows: [
          {
            paciente: "Lorena Cáceres",
            quien: "Lorena Cáceres",
            profesional: "Dra. Ana Torres",
            estado: "atendida",
            saldo_dinero: 1080,
            paciente_id: "x",
          },
          {
            paciente: "Martín Campos",
            quien: "Exodoncia simple",
            profesional: "Dra. Ana Torres",
            estado: "no_vino",
            saldo_dinero: 900,
            paciente_id: "y",
          },
          {
            paciente: "Lorena Cáceres",
            quien: "Sede Surco",
            profesional: "Dra. Ana Torres",
            estado: "atendida",
            saldo_dinero: 50,
            paciente_id: "x",
          },
        ],
        truncated: false,
      },
      NAMES,
    )
    expect(text).toContain(
      "c1: 3 filas. Columnas: paciente (text), quien (text), profesional (text), estado (text), saldo_dinero (number).",
    )
    expect(text).toContain("Paciente 1 | texto 1 | Dra. Ana Torres | atendida | 1080")
    expect(text).toContain("Paciente 2 | Exodoncia simple | Dra. Ana Torres | no_vino | 900")
    expect(text).toContain("Paciente 1 | Sede Surco | Dra. Ana Torres | atendida | 50")
    expect(text).not.toMatch(/Lorena|Martín|Cáceres/)
    // Los ids no se muestran.
    expect(text).not.toContain("| x")
  })

  it("avisa lo que suele delatar un nombre mal escrito: nada, todo en cero o vacío", () => {
    expect(
      argosResultForModel(
        "c1",
        { columns: [{ name: "cobrado_dinero", kind: "number" }], rows: [], truncated: false },
        NAMES,
      ),
    ).toMatch(/no trajo filas/)
    expect(
      argosResultForModel(
        "c2",
        {
          columns: [{ name: "cobrado_dinero", kind: "number" }],
          rows: [{ cobrado_dinero: 0 }],
          truncated: false,
        },
        NAMES,
      ),
    ).toMatch(/todas las cifras son cero/)
    expect(
      argosResultForModel(
        "c3",
        {
          columns: [
            { name: "surco_dinero", kind: "number" },
            { name: "lima_dinero", kind: "number" },
          ],
          rows: [{ surco_dinero: null, lima_dinero: 5 }],
          truncated: false,
        },
        NAMES,
      ),
    ).toMatch(/en la primera fila vienen vacías surco_dinero/)
  })
})
