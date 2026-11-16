import type { HealthDeclarant } from "@odentia/clinical"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { setOrgLocale } from "./locale"
import {
  askWhom,
  changedHistoryOf,
  declaredInterviewRows,
  declaredGroupOf,
  declaredMarkWords,
  noAllergiesWords,
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

// Las fechas en el formato de la clínica, no en el de la máquina que corre la prueba (el CI está en inglés).
beforeAll(() => {
  setOrgLocale("es-PE", "America/Lima")
})
afterAll(() => {
  setOrgLocale(undefined, undefined)
})

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

  // QA del 14 nov: el registro guarda la opción «Madre, padre o tutor» y la ficha decía «Lo dijo su
  // madre, padre o tutor, Carla». No se inventa cuál de los tres fue.
  it("«Madre, padre o tutor» se dice «quien la cuida», sin inventar el parentesco", () => {
    const chip = { kind: "representative" as const, name: "Carla Ríos", relation: "madre, padre o tutor" }
    expect(declaredMarkWords(chip, "2026-11-13", "F")).toBe("Lo dijo quien la cuida, Carla, el 13 nov, sin revisar")
    expect(whoWords(chip, "M")).toBe("quien lo cuida, Carla")
    expect(whoWords(chip, null)).toBe("su representante, Carla")
    expect(saidNoWords(chip, "M")).toBe("Quien lo cuida dijo que no")
    expect(askWhom([{ ...guardian, kinship: null, relationshipDetail: "Madre, padre o tutor" }])).toBe(
      "su representante (Carla Paz Soto)",
    )
  })

  // QA del 15 nov (K15): el registro ya separa «Madre», «Padre» y «Tutor legal», y lo dice con su nombre.
  it("lo que guarda el registro de hoy se dice con su parentesco", () => {
    const said = (relation: string, name: string) => whoWords({ kind: "representative", name, relation }, "M")
    expect(said("Madre", "Rosa Lozano")).toBe("su madre, Rosa")
    expect(said("Padre", "Luis Ríos")).toBe("su padre, Luis")
    expect(said("Tutor legal", "Ana Vera")).toBe("su tutor legal, Ana")
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
    // Dicho esta misma semana: el dato una sola vez.
    expect(pregnancyChip({ state: "vigente", saidOn: "2026-11-14", weeksSaid: 20, weeksToday: 20 })).toBe(
      "Embarazo · 20 semanas (lo dijo el 14 nov)",
    )
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

  // Revisión final del 15 nov (dev H6): con tres declaraciones del mismo día decía «lo que dijo ella de
  // su salud el 14 nov, lo que dijo ella… y lo que dijo ella…».
  it("lo del mismo día y de la misma persona se dice una vez", () => {
    const herselfOn = (at: string) => ({ ...base, at, by: { kind: "patient" as const, name: null, relation: null } })
    expect(
      unreviewedWords([herselfOn("2026-11-14T22:20:00.000Z"), herselfOn("2026-11-14T22:21:00.000Z"), herselfOn("2026-11-14T22:22:00.000Z")], "F"),
    ).toBe("lo que dijo ella de su salud el 14 nov")
  })
})

// Revisión final del 15 nov (dev H2, ux D5): con dos correcciones del anticoagulante, Antecedentes, el
// Resumen, «Revisa con…» y la copia daban tres anticoagulantes vigentes. Cada dato, con lo de hoy y su
// historia: «Anticoagulante: apixabán 5 mg · antes warfarina 7.5 mg y warfarina 5 mg, cambió el 14 nov».
describe("lo que dijo que cambió, por dato", () => {
  const meds = [
    { id: "apix", name: "apixabán", dose: "5 mg", atcCode: "B01AF02" },
    { id: "w75", name: "warfarina", dose: "7.5 mg", atcCode: "B01AA03" },
    { id: "w5", name: "warfarina", dose: "5 mg", atcCode: "B01AA03" },
    { id: "los", name: "losartán", dose: null, atcCode: "C09CA01" },
    { id: "ome", name: "omeprazol", dose: null, atcCode: null },
  ]
  const health = {
    allergies: [{ id: "pen", substance: "Penicilina" }],
    conditions: [{ id: "hta", name: "Hipertensión" }],
    medications: meds,
    changed: { by: herself, at: "2026-11-14T22:21:00.000Z", allergies: ["pen"], conditions: [], medications: ["w75", "w5", "los"] },
  }

  it("lo de antes no se lee como vigente: va junto a lo de hoy de su misma clase", () => {
    const history = changedHistoryOf(health)
    expect(history.current("medications", meds).map((row) => row.id)).toEqual(["apix", "ome"])
    expect(history.beforeFor("medications", meds[0]!)).toBe("antes warfarina 7.5 mg y warfarina 5 mg, cambió el 14 nov")
    // Una medicina sin clase no se empareja con otra: «omeprazol · antes losartán» diría lo que no dijo.
    expect(history.beforeFor("medications", meds[4]!)).toBeNull()
    expect(history.alone("medications", meds).map((piece) => piece.line)).toEqual(["Medicación: antes losartán · dijo que cambió el 14 nov"])
  })

  it("una alergia que no volvió a nombrar sigue siendo una alergia: queda, con su marca", () => {
    const history = changedHistoryOf(health)
    expect(history.current("allergies", health.allergies)).toHaveLength(1)
    expect(history.alone("allergies", health.allergies)).toEqual([])
    expect(history.allergyMark("pen")).toBe("dijo que cambió el 14 nov")
  })

  it("si ya no toma ninguna de esa clase, lo de antes va solo, con su marca", () => {
    const history = changedHistoryOf({ ...health, changed: { ...health.changed, medications: ["apix", "w75", "w5"] } })
    expect(history.current("medications", meds).map((row) => row.id)).toEqual(["los", "ome"])
    expect(history.alone("medications", meds)).toEqual([
      {
        group: "anticoagulants",
        label: "Anticoagulante",
        text: "antes apixabán 5 mg, warfarina 7.5 mg y warfarina 5 mg · dijo que cambió el 14 nov",
        line: "Anticoagulante: antes apixabán 5 mg, warfarina 7.5 mg y warfarina 5 mg · dijo que cambió el 14 nov",
      },
    ])
  })

  it("con quien habla por ella, lo dice ella", () => {
    const history = changedHistoryOf({ ...health, changed: { ...health.changed, by: mother, conditions: ["hta"] } })
    expect(history.alone("conditions", health.conditions)[0]?.line).toBe(
      "Enfermedades: antes Hipertensión · su madre, Carla, dijo que cambió el 14 nov",
    )
  })

  it("sin nada que cambió, todo es de hoy", () => {
    const history = changedHistoryOf({ ...health, changed: null })
    expect(history.current("medications", meds)).toHaveLength(5)
    expect(history.alone("medications", meds)).toEqual([])
  })
})

// Revisión final de formularios (H9): la anestesia y el sangrado se preguntan por separado.
describe("«Ver declaración original»: la anestesia y el sangrado", () => {
  it("trae la anestesia con qué pasó y el sangrado por separado; lo de antes, con su pregunta doble", () => {
    expect(declaredInterviewRows({ dental: { problemaAnestesia: { anestesia: "si", quePaso: "alergia", sangrado: "no" } } })).toEqual([
      { label: "Problema con la anestesia", value: "Sí, alergia o ronchas" },
      { label: "Sangrado largo tras una extracción", value: "No" },
    ])
    expect(declaredInterviewRows({ dental: { problemaAnestesia: "no_sabe" } })).toEqual([
      { label: "Problema con la anestesia o sangrado tras una extracción", value: "No sabe" },
    ])
  })
})

// Estudio de la atención del 16 nov (B1b, E10a): recepción leía «Niega alergias» arriba y «Sin alergias
// registradas» en la tarjeta; sin preguntar, la misma página lo decía con tres frases.
describe("sin alergias vigentes, una sola frase por estado", () => {
  it("se le preguntó y no tiene: «Niega alergias»", () => {
    expect(noAllergiesWords({ review: "none" }, "F")).toBe("Niega alergias")
  })
  it("nadie le preguntó", () => {
    expect(noAllergiesWords({ review: "unknown" }, "F")).toBe("Alergias: no se le preguntó")
    expect(noAllergiesWords({ review: null }, "F")).toBe("Alergias: no se le preguntó")
  })
  it("su «No sé» no es «no se le preguntó», y dice quién y cuándo", () => {
    expect(noAllergiesWords({ review: "unknown", saidUnknown: { by: mother, at: "2026-11-13T15:00:00.000Z" } }, "M")).toBe(
      "Alergias: su madre dijo que no sabe (13 nov)",
    )
  })
  it("su «No» sin revisar no es «niega», aunque la clínica lo hubiera negado antes", () => {
    expect(noAllergiesWords({ review: "none", saidNo: { by: herself, at: null } }, "F")).toBe("Alergias: dijo que no · sin revisar")
  })
  it("registradas y ninguna vigente", () => {
    expect(noAllergiesWords({ review: "recorded" }, "F")).toBe("Sin alergias vigentes")
  })
})
