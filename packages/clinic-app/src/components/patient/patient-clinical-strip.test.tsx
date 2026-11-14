import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { setOrgLocale } from "../../lib/locale"
import type { DeclaredHealthGroup, PatientFull, PatientHealth } from "../../lib/patients"
import { bareProduct, declareProduct } from "../../product/product-ui"
import { PatientClinicalStrip } from "./patient-header"

// Las fechas en el formato de la clínica, no en el de la máquina que corre la prueba (el CI está en inglés).
beforeAll(() => {
  setOrgLocale("es-PE", "America/Lima")
})
afterAll(() => {
  setOrgLocale(undefined, undefined)
})

declareProduct(bareProduct("dental"))

type Detail = Parameters<typeof PatientClinicalStrip>[0]["detail"]

const allergy = (id: string, substance: string) =>
  ({ id, substance, kind: "alergia", severity: "desconocida", verification: "no_confirmada", isActive: true, source: "paciente" }) as unknown as PatientFull["activeAllergies"][number]
const medication = (id: string, name: string) => ({ id, name, dose: null }) as unknown as PatientFull["currentMedications"][number]

const group = (patch: Partial<DeclaredHealthGroup>): DeclaredHealthGroup => ({
  by: { kind: "patient", name: null, relation: null },
  at: "2026-11-13T19:27:00.000Z",
  allergies: [],
  conditions: [],
  medications: [],
  pregnancy: false,
  saidNo: { allergies: false, conditions: false, medications: false },
  ...patch,
})

const health = (declared: DeclaredHealthGroup[], more: Partial<PatientHealth> = {}) =>
  ({ declared, pregnancy: null, ...more }) as unknown as PatientHealth

const text = (node: React.ReactNode) => renderToStaticMarkup(node).replace(/<[^>]+>/g, "|")

describe("la franja de arriba de la ficha y de la atención", () => {
  const detail: Detail = {
    activeAllergies: [allergy("a1", "Látex")],
    activeConditions: [],
    currentMedications: [medication("m1", "Sulfato ferroso")],
    allergyReview: "recorded",
  }

  it("una sola marca para lo que dijo y nadie revisó, alergias incluidas, con el embarazo y su semana de hoy", () => {
    const page = text(
      <PatientClinicalStrip
        detail={detail}
        sex="F"
        health={health([group({ allergies: ["a1"], medications: ["m1"], pregnancy: true })], {
          pregnancy: { state: "vigente", saidOn: "2026-11-13", weeksSaid: 30, weeksToday: 32 },
        })}
      />,
    )
    expect(page.match(/Lo dijo ella el 13 nov, sin revisar/g)).toHaveLength(1)
    expect(page).toContain("Embarazo · 32 semanas hoy (30 el 13 nov)")
    expect(page).toContain("Alergia: Látex")
    expect(page).toContain("Toma Sulfato ferroso")
  })

  it("nombra a quien lo dijo: la madre que lo llenó, aunque el preferido sea otro, y a la persona si lo envió ella", () => {
    const byMother = text(
      <PatientClinicalStrip
        detail={detail}
        sex="M"
        health={health([
          group({ by: { kind: "representative", name: "Carla Paz Soto", relation: "madre" }, allergies: ["a1"], medications: ["m1"] }),
        ])}
      />,
    )
    expect(byMother).toContain("Lo dijo su madre, Carla, el 13 nov, sin revisar")
    // La franja ya no mira quién figura como representante: solo lo que dice la declaración.
    const byHerself = text(<PatientClinicalStrip detail={detail} sex="F" health={health([group({ allergies: ["a1"] })])} />)
    expect(byHerself).toContain("Lo dijo ella el 13 nov, sin revisar")
    expect(byHerself).not.toContain("madre")
  })

  it("dos fechas, dos marcas: lo del 1 nov no sale como dicho el 13", () => {
    const page = text(
      <PatientClinicalStrip
        detail={detail}
        sex="F"
        health={health([
          group({ at: "2026-11-01T15:00:00.000Z", medications: ["m1"] }),
          group({ at: "2026-11-13T19:27:00.000Z", allergies: ["a1"] }),
        ])}
      />,
    )
    const first = page.indexOf("Lo dijo ella el 1 nov, sin revisar")
    const second = page.indexOf("Lo dijo ella el 13 nov, sin revisar")
    expect(first).toBeGreaterThan(-1)
    expect(second).toBeGreaterThan(first)
    // Cada cosa bajo su fecha.
    expect(page.indexOf("Toma Sulfato ferroso")).toBeGreaterThan(first)
    expect(page.indexOf("Toma Sulfato ferroso")).toBeLessThan(second)
    expect(page.indexOf("Alergia: Látex")).toBeGreaterThan(second)
  })

  it("lo ya revisado va sin marca, y un embarazo pasado su término pide confirmar sin tono de alerta", () => {
    const page = text(
      <PatientClinicalStrip
        detail={detail}
        sex="F"
        health={health([], { pregnancy: { state: "por_confirmar", saidOn: "2026-01-10", weeksSaid: 30, weeksToday: null } })}
      />,
    )
    expect(page).not.toContain("sin revisar")
    expect(page).toContain("Embarazo por confirmar · lo dijo el 10 ene, con 30 semanas")
  })

  it("el «No» de quien declaró no es «Niega alergias»; recepción lo ve igual, con quién lo dijo", () => {
    const none: Detail = { activeAllergies: [], activeConditions: [], currentMedications: [], allergyReview: "none" }
    const clinical = text(
      <PatientClinicalStrip
        detail={none}
        sex="M"
        health={health([
          group({
            by: { kind: "representative", name: "Carla Paz Soto", relation: "madre" },
            saidNo: { allergies: true, conditions: false, medications: false },
          }),
        ])}
      />,
    )
    expect(clinical).toContain("Lo dijo su madre, Carla, el 13 nov, sin revisar")
    expect(clinical).toContain("Alergias: dijo que no")
    expect(clinical).not.toContain("Niega alergias")
    // Recepción no recibe la salud: solo si el «No» es de quien declaró, y de quién.
    const reception = text(
      <PatientClinicalStrip
        detail={{ ...none, allergySaidNo: { by: { kind: "patient", name: null, relation: null }, at: "2026-11-13T19:27:00.000Z" } }}
        sex="F"
      />,
    )
    expect(reception).toContain("Lo dijo ella el 13 nov, sin revisar")
    expect(reception).toContain("Alergias: dijo que no")
    // El «niega» que anotó la clínica sigue diciéndose así.
    expect(text(<PatientClinicalStrip detail={none} sex="F" health={health([])} />)).toContain("Niega alergias")
  })

  // QA del 14 nov (H1 de clínica, propuesta de UX): la marca encabezaba toda la fila.
  const html = (node: React.ReactNode) => renderToStaticMarkup(node)
  /** Lo que queda dentro de cada caja de declaración, para el lector de pantalla y para la vista. */
  const boxes = (markup: string) =>
    [...markup.matchAll(/<ul aria-labelledby="([^"]+)"[^>]*>(.*?)<\/ul>/g)].map((match) => ({
      label: new RegExp(`id="${match[1]}"[^>]*>([^<]*)<`).exec(markup)?.[1] ?? "",
      inside: match[2]!.replace(/<[^>]+>/g, "|"),
    }))
  const severeAllergy = (id: string, substance: string) =>
    ({ ...allergy(id, substance), severity: "severa", source: "equipo" }) as unknown as PatientFull["activeAllergies"][number]

  it("caso mixto: la alergia severa que anotó el equipo va primero y fuera de la caja de lo que dijo ella", () => {
    const mixed: Detail = {
      activeAllergies: [allergy("a1", "Látex"), severeAllergy("a2", "Penicilinas")],
      activeConditions: [{ id: "c1", name: "Presión alta" } as unknown as PatientFull["activeConditions"][number]],
      currentMedications: [medication("m1", "Losartán 50 mg")],
      allergyReview: "recorded",
    }
    const markup = html(
      <PatientClinicalStrip
        detail={mixed}
        sex="F"
        health={health([group({ allergies: ["a1"], conditions: ["c1"], medications: ["m1"] })])}
      />,
    )
    const page = markup.replace(/<[^>]+>/g, "|")
    expect(page.indexOf("Alergia severa: Penicilinas")).toBeLessThan(page.indexOf("Lo dijo ella el 13 nov, sin revisar"))
    const [box, ...others] = boxes(markup)
    expect(others).toHaveLength(0)
    expect(box?.label).toBe("Lo dijo ella el 13 nov, sin revisar")
    expect(box?.inside).toContain("Alergia: Látex")
    expect(box?.inside).toContain("Presión alta")
    expect(box?.inside).toContain("Toma Losartán 50 mg")
    expect(box?.inside).not.toContain("Penicilinas")
    // Es una lista: la caja se nombra con su marca y lo de afuera es otro elemento.
    expect(markup).toMatch(/^<section aria-label="Alertas clínicas"[^>]*><ul/)
  })

  it("lo ya revisado sale de la caja: Lucero revisada en su embarazo y sus medicinas, con el látex aún sin revisar", () => {
    const markup = html(
      <PatientClinicalStrip
        detail={detail}
        sex="F"
        health={health([group({ allergies: ["a1"] })], {
          pregnancy: { state: "vigente", saidOn: "2026-11-13", weeksSaid: 30, weeksToday: 30 },
        })}
      />,
    )
    const [box] = boxes(markup)
    expect(box?.inside).toContain("Alergia: Látex")
    expect(box?.inside).not.toContain("Embarazo")
    expect(box?.inside).not.toContain("Sulfato ferroso")
    const page = markup.replace(/<[^>]+>/g, "|")
    expect(page).toContain("Embarazo · 30 semanas (lo dijo el 13 nov)")
    expect(page).toContain("Toma Sulfato ferroso")
  })

  it("dos declaraciones, dos cajas; y una severa nunca se va a «+N», aunque haya muchas cosas antes", () => {
    const many: Detail = {
      activeAllergies: [allergy("a1", "Látex"), { ...severeAllergy("a9", "Penicilinas"), source: "paciente" } as unknown as PatientFull["activeAllergies"][number]],
      activeConditions: ["Asma", "Diabetes", "Presión alta", "Gastritis", "Migraña", "Hipotiroidismo"].map(
        (name, index) => ({ id: `c${index}`, name }) as unknown as PatientFull["activeConditions"][number],
      ),
      currentMedications: [],
      allergyReview: "recorded",
    }
    const markup = html(
      <PatientClinicalStrip
        detail={many}
        sex="F"
        health={health([
          group({ at: "2026-11-01T15:00:00.000Z", conditions: ["c0", "c1", "c2", "c3", "c4", "c5"] }),
          group({ allergies: ["a1", "a9"] }),
        ])}
      />,
    )
    const [first, second] = boxes(markup)
    expect(first?.label).toBe("Lo dijo ella el 1 nov, sin revisar")
    expect(second?.label).toBe("Lo dijo ella el 13 nov, sin revisar")
    // La severa que dijo ella va primera en su caja y no se esconde.
    expect(second?.inside.replace(/^\|+/, "")).toMatch(/^Alergia severa: Penicilinas/)
    expect(markup.replace(/<[^>]+>/g, "|")).toContain("+1 alerta")
  })

  it("recepción ve la alergia que dijo la paciente con su marca, y nada más de su salud", () => {
    const reception: Detail = {
      activeAllergies: [allergy("a1", "Látex"), severeAllergy("a2", "Penicilinas")],
      activeConditions: [],
      currentMedications: [],
      allergyReview: "recorded",
      allergySaidNo: null,
      declaredAllergies: [
        { by: { kind: "patient", name: null, relation: null }, at: "2026-11-13T19:27:00.000Z", allergies: ["a1"], saidNo: false },
      ],
    }
    const markup = html(<PatientClinicalStrip detail={reception} sex="F" />)
    const [box, ...others] = boxes(markup)
    expect(others).toHaveLength(0)
    expect(box?.label).toBe("Lo dijo ella el 13 nov, sin revisar")
    expect(box?.inside).toContain("Alergia: Látex")
    expect(box?.inside).not.toContain("Penicilinas")
  })

  it("Marta: «Anticoagulante» y «Huesos» arriba, dichos por ella, antes que lo demás que toma", () => {
    const marta: Detail = {
      activeAllergies: [],
      activeConditions: [],
      currentMedications: [
        medication("m0", "Losartán"),
        { id: "m1", name: "warfarina", dose: "5 mg", atcCode: "B01A" } as unknown as PatientFull["currentMedications"][number],
        { id: "m2", name: "alendronato", dose: null, atcCode: "M05B" } as unknown as PatientFull["currentMedications"][number],
      ],
      allergyReview: "none",
    }
    const markup = html(
      <PatientClinicalStrip detail={marta} sex="F" health={health([group({ medications: ["m1", "m2"] })])} />,
    )
    const [box] = boxes(markup)
    expect(box?.label).toBe("Lo dijo ella el 13 nov, sin revisar")
    expect(box?.inside).toContain("Anticoagulante: warfarina 5 mg")
    expect(box?.inside).toContain("Huesos: alendronato")
    expect(box?.inside).not.toContain("Losartán")
    const page = markup.replace(/<[^>]+>/g, "|")
    expect(page.indexOf("Anticoagulante: warfarina 5 mg")).toBeGreaterThan(-1)
    expect(page.indexOf("Huesos: alendronato")).toBeGreaterThan(page.indexOf("Anticoagulante: warfarina 5 mg"))
    expect(page.indexOf("Toma Losartán")).toBeGreaterThan(page.indexOf("Huesos: alendronato"))
  })

  it("en la atención, «No se le preguntó» no es «dijo que no»; la ficha no lo repite", () => {
    const classes = {
      medicineClasses: {
        anticoagulants: { answer: "unasked", said: false },
        boneMedicines: { answer: "no", said: true },
      },
    } as Partial<PatientHealth>
    const encounter = text(
      <PatientClinicalStrip detail={detail} sex="F" health={health([], classes)} medicineClasses />,
    )
    expect(encounter).toContain("Anticoagulante: no se le preguntó")
    expect(encounter).toContain("Huesos: dijo que no")
    const chart = text(<PatientClinicalStrip detail={detail} sex="F" health={health([], classes)} />)
    expect(chart).not.toContain("no se le preguntó")
  })
})
