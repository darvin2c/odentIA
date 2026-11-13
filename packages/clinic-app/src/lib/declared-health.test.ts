import { describe, expect, it } from "vitest"
import {
  askWhom,
  declaredMarkWords,
  pregnancyChip,
  pregnancyWords,
  saidByWho,
  saidByWords,
  saidNoWords,
  shortDay,
} from "./declared-health"
import type { PatientContactLink } from "./patients"

const mother: PatientContactLink = {
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
const NOW = new Date("2026-11-27T15:00:00Z")

describe("las palabras de lo que dijo el paciente", () => {
  it("una sola marca: quién lo dijo, cuándo y que nadie lo revisó", () => {
    expect(declaredMarkWords({ sex: "F" }, "2026-11-13")).toBe("Lo dijo ella el 13 nov, sin revisar")
    expect(declaredMarkWords({ sex: "M" }, "2026-11-13")).toBe("Lo dijo él el 13 nov, sin revisar")
    // Sin sexo registrado no se supone ninguno.
    expect(declaredMarkWords({ sex: null }, "2026-11-13")).toBe("Lo dijo el 13 nov, sin revisar")
    expect(declaredMarkWords({}, null)).toBe("Lo dijo, sin revisar")
  })

  it("cuando habla quien decide por la persona, se dice con su vínculo y su nombre", () => {
    expect(saidByWho({ sex: "M", contacts: [mother] })).toBe("su madre, Carla")
    expect(declaredMarkWords({ sex: "M", contacts: [mother] }, "2026-11-13")).toBe(
      "Lo dijo su madre, Carla, el 13 nov, sin revisar",
    )
    expect(declaredMarkWords({ contacts: [mother] }, null)).toBe("Lo dijo su madre, Carla, sin revisar")
    expect(saidByWords({ contacts: [mother] })).toBe("lo dijo su madre, Carla")
    // A quién preguntar sigue diciéndose igual que en la ficha.
    expect(askWhom([mother])).toBe("su madre (Carla Paz Soto)")
    expect(askWhom([{ ...mother, isActive: false }])).toBeNull()
  })

  it("el «No» que marcó la persona no es un «niega»", () => {
    expect(saidNoWords({ sex: "F" })).toBe("Dijo que no")
    expect(saidNoWords({ contacts: [mother] })).toBe("Su madre dijo que no")
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
