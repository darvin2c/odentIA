import type { HealthDeclarant } from "@odentia/clinical"
import { describe, expect, it } from "vitest"
import {
  askWhom,
  declaredGroupOf,
  declaredMarkWords,
  pregnancyChip,
  pregnancyGroupOf,
  pregnancyWords,
  saidByWords,
  saidNoGroupOf,
  saidNoWords,
  shortDay,
  unreviewedWords,
  whoWords,
} from "./declared-health"
import type { DeclaredHealthGroup, PatientContactLink } from "./patients"

const herself: HealthDeclarant = { kind: "patient", name: null, relation: null }
const mother: HealthDeclarant = { kind: "representative", name: "Carla Paz Soto", relation: "madre" }
const staff: HealthDeclarant = { kind: "staff", name: null, relation: null }
const unknown: HealthDeclarant = { kind: "unknown", name: null, relation: null }
const NOW = new Date("2026-11-27T15:00:00Z")

const guardian: PatientContactLink = {
  contactId: "c1",
  displayName: "Carla Paz Soto",
  phone: null,
  email: null,
  isActive: true,
  relationship: "guardian",
  relationshipDetail: null,
  kinship: "MTH",
  isPreferred: true,
  isEmergency: false,
}

describe("las palabras de lo que dijo el paciente", () => {
  it("la marca dice quién lo dijo, cuándo y que nadie lo revisó", () => {
    expect(declaredMarkWords(herself, "2026-11-13", "F")).toBe("Lo dijo ella el 13 nov, sin revisar")
    expect(declaredMarkWords(herself, "2026-11-13", "M")).toBe("Lo dijo él el 13 nov, sin revisar")
    // Sin sexo registrado no se supone ninguno.
    expect(declaredMarkWords(herself, "2026-11-13", null)).toBe("Lo dijo el 13 nov, sin revisar")
    expect(declaredMarkWords(herself, null, undefined)).toBe("Lo dijo, sin revisar")
  })

  it("nombra a quien lo dijo según su declaración, no según quién figura como su representante", () => {
    // Con quien habla por ella: su vínculo y su nombre, entre comas.
    expect(whoWords(mother, "M")).toBe("su madre, Carla")
    expect(declaredMarkWords(mother, "2026-11-13", "M")).toBe("Lo dijo su madre, Carla, el 13 nov, sin revisar")
    expect(saidByWords(mother, "M")).toBe("lo dijo su madre, Carla")
    // Si solo se sabe el nombre o solo el vínculo, se dice lo que se sabe.
    expect(whoWords({ kind: "representative", name: "Rosa Vera", relation: null }, "F")).toBe("Rosa")
    expect(whoWords({ kind: "representative", name: null, relation: "hermana" }, "F")).toBe("su hermana")
    expect(whoWords({ kind: "representative", name: null, relation: null }, "F")).toBe("quien habla por ella")
    expect(whoWords({ kind: "representative", name: null, relation: null }, null)).toBe("quien habla en su nombre")
    // Lo que anotó el equipo porque se lo dijeron, y lo que no dice quién fue: no se le atribuye a la persona.
    expect(declaredMarkWords(staff, "2026-11-13", "F")).toBe("Lo anotó el equipo el 13 nov, sin revisar")
    expect(declaredMarkWords(unknown, "2026-11-13", "F")).toBe("Declarado el 13 nov, sin revisar")
    expect(saidByWords(staff, "F")).toBe("lo anotó el equipo")
    expect(saidByWords(unknown, "F")).toBe("declarado")
    // A quién preguntar hoy sigue diciéndose como en la ficha: es otra cosa que quién lo dijo.
    expect(askWhom([guardian])).toBe("su madre (Carla Paz Soto)")
    expect(askWhom([{ ...guardian, isActive: false }])).toBeNull()
  })

  it("el «No» que marcó quien declaró no es un «niega»", () => {
    expect(saidNoWords(herself, "F")).toBe("Dijo que no")
    expect(saidNoWords(mother, "M")).toBe("Su madre dijo que no")
    expect(saidNoWords({ kind: "representative", name: "Rosa Vera", relation: null }, "F")).toBe("Rosa dijo que no")
    expect(saidNoWords(staff, "F")).toBe("El equipo anotó que no")
  })

  it("cada fila se busca en su declaración: con dos fechas o dos personas, cada cosa con la suya", () => {
    const group = (by: HealthDeclarant, at: string, patch: Partial<DeclaredHealthGroup>): DeclaredHealthGroup => ({
      by,
      at,
      allergies: [],
      conditions: [],
      medications: [],
      pregnancy: false,
      saidNo: { allergies: false, conditions: false, medications: false },
      ...patch,
    })
    const groups = [
      group(herself, "2026-11-01T15:00:00Z", { medications: ["m1"], saidNo: { allergies: false, conditions: true, medications: false } }),
      group(mother, "2026-11-13T15:00:00Z", { allergies: ["a1"], pregnancy: true }),
    ]
    expect(declaredGroupOf(groups, "medications", "m1")?.by).toBe(herself)
    expect(declaredGroupOf(groups, "allergies", "a1")?.by).toBe(mother)
    expect(declaredGroupOf(groups, "allergies", "a2")).toBeUndefined()
    expect(declaredGroupOf(undefined, "allergies", "a1")).toBeUndefined()
    expect(saidNoGroupOf(groups, "conditions")?.at).toBe("2026-11-01T15:00:00Z")
    expect(saidNoGroupOf(groups, "allergies")).toBeUndefined()
    expect(pregnancyGroupOf(groups)?.by).toBe(mother)
  })

  it("el día se dice corto, y un día de calendario no se corre con la zona", () => {
    expect(shortDay("2026-11-13", NOW)).toBe("13 nov")
    expect(shortDay("2025-11-13", NOW)).toBe("13 nov 2025")
    expect(shortDay("no es fecha", NOW)).toBe("")
  })

  it("el embarazo dice la semana de hoy y lo que se dijo; vencido o sin fecha pide confirmar", () => {
    const current = { state: "vigente", saidOn: "2026-11-13", weeksSaid: 30, weeksToday: 32 } as const
    expect(pregnancyWords(current)).toEqual({ title: "Embarazo · 32 semanas hoy", detail: "30 el 13 nov", confirm: false })
    expect(pregnancyChip(current)).toBe("Embarazo · 32 semanas hoy (30 el 13 nov)")
    expect(pregnancyChip({ state: "vigente", saidOn: "2026-11-13", weeksSaid: 0, weeksToday: 1 })).toBe(
      "Embarazo · 1 semana hoy (0 el 13 nov)",
    )
    expect(pregnancyChip({ state: "vigente", saidOn: "2026-11-13", weeksSaid: null, weeksToday: null })).toBe(
      "Embarazo · lo dijo el 13 nov, sin las semanas",
    )
    const past = pregnancyWords({ state: "por_confirmar", saidOn: "2026-11-13", weeksSaid: 30, weeksToday: null })
    expect(past).toEqual({ title: "Embarazo por confirmar", detail: "lo dijo el 13 nov, con 30 semanas", confirm: true })
    expect(pregnancyChip({ state: "por_confirmar", saidOn: null, weeksSaid: 12, weeksToday: null })).toBe(
      "Embarazo por confirmar · anotado sin fecha",
    )
  })
})

// QA del 14 nov (H6 de clínica): al firmar con lo declarado sin revisar, el cierre no lo decía.
describe("lo que quedó sin revisar, al firmar", () => {
  const base = {
    at: "2026-11-13T19:27:00.000Z",
    allergies: ["a1"],
    conditions: [],
    medications: [],
    pregnancy: false,
    saidNo: { allergies: false, conditions: false, medications: false },
  }
  it("dice quién lo dijo y su día; nada si no queda nada", () => {
    expect(unreviewedWords([{ ...base, by: { kind: "patient", name: null, relation: null } }], "F")).toBe(
      "lo que dijo ella de su salud el 13 nov",
    )
    expect(
      unreviewedWords(
        [
          { ...base, at: "2026-11-01T15:00:00.000Z", by: { kind: "representative", name: "Carla Paz", relation: "madre" } },
          { ...base, by: { kind: "patient", name: null, relation: null } },
        ],
        "M",
      ),
    ).toBe("lo que dijo de su salud su madre, Carla, el 1 nov y lo que dijo él de su salud el 13 nov")
    expect(unreviewedWords([], "F")).toBeNull()
    expect(unreviewedWords(undefined, "F")).toBeNull()
  })
})
