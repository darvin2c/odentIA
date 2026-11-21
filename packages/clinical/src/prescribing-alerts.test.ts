import { describe, expect, it } from "vitest"
import { DENTAL_MEDICATIONS, type MedicationEntry } from "./medications.js"
import { prescribingAlerts } from "./prescribing-alerts.js"

const TODAY = "2026-10-24"
/** Lo de la lista dental y un IECA, que receta latidIA, para lo contraindicado en el embarazo. */
const MEDICATIONS: readonly MedicationEntry[] = [...DENTAL_MEDICATIONS, { dci: "enalapril", atc: "C09AA02", group: "otros" }]
const alerts = (interview: unknown, items: string[], taking: Array<{ name: string; atcCode: string | null }> = []) =>
  prescribingAlerts({ interview, today: TODAY, taking }, items.map((genericName) => ({ genericName })), MEDICATIONS)
const pregnant = (fecha: string, semanas?: number) => ({
  embarazoLactancia: { embarazo: { estado: "si", fecha, ...(semanas === undefined ? {} : { semanas }) } },
})

describe("lo que avisa toda receta (nació en latidIA; QA final de formularios, Y1)", () => {
  it("con embarazo lo recuerda y lo contraindicado se avisa, como una alergia", () => {
    const check = alerts(pregnant("2026-10-10", 10), ["enalapril", "paracetamol"])
    expect(check.reminders).toEqual([
      "Está embarazada, 12 semanas (registrado el 10/10/2026): revisa que cada medicamento sea seguro en el embarazo.",
    ])
    expect(check.warnings).toEqual([
      "Enalapril: está embarazada (12 semanas) y los IECA están contraindicados en el embarazo (ATC C09AA02).",
    ])
    // Un embarazo que por sus semanas ya pasó su término queda «por confirmar», como en la franja de
    // la ficha, y la receta no deja de avisar en silencio: lo contraindicado se avisa con esas palabras.
    const stale = alerts(pregnant("2025-09-01", 20), ["enalapril"])
    expect(stale.reminders[0]).toMatch(/^Embarazo por confirmar \(registrado el 01\/09\/2025\)/)
    expect(stale.warnings).toEqual([
      "Enalapril: tiene un embarazo por confirmar y los IECA están contraindicados en el embarazo (ATC C09AA02).",
    ])
    // Sin las semanas, la misma regla: en pie hasta 42 semanas después de haberlo dicho, no para siempre.
    expect(alerts(pregnant("2026-09-01"), ["enalapril"]).warnings).toEqual([
      "Enalapril: está embarazada y los IECA están contraindicados en el embarazo (ATC C09AA02).",
    ])
    expect(alerts(pregnant("2025-09-01"), ["enalapril"]).reminders[0]).toMatch(/^Embarazo por confirmar/)
    // Un «no» no avisa nada.
    expect(alerts({ embarazoLactancia: { embarazo: { estado: "no", fecha: "2026-09-01" } } }, ["enalapril"])).toEqual({
      warnings: [],
      reminders: [],
    })
  })

  it("la lactancia se recuerda con su fecha", () => {
    expect(alerts({ embarazoLactancia: { lactancia: { estado: "si", fecha: "2026-09-01" } } }, ["paracetamol"]).reminders).toEqual([
      "Da de lactar (registrado el 01/09/2026): revisa que cada medicamento sea compatible con la lactancia.",
    ])
  })

  // Clínica Y1: a Rosa, con warfarina, se le emitió ibuprofeno sin ningún aviso (SDCEP: evitar AINE
  // con warfarina y preferir paracetamol).
  it("un AINE con un anticoagulante o un antiagregante se avisa; el paracetamol no", () => {
    const warfarin = [{ name: "warfarina 5 mg", atcCode: "B01AA03" }]
    expect(alerts({}, ["ibuprofeno", "paracetamol"], warfarin).warnings).toEqual([
      "Ibuprofeno: toma warfarina 5 mg (anticoagulante o antiagregante) y los AINE aumentan el riesgo de sangrado; el paracetamol es la alternativa habitual.",
    ])
    // La aspirina diaria (antiagregante) cuenta igual; la que se dijo sin nombre lleva el código del grupo.
    expect(alerts({}, ["ketorolaco"], [{ name: "Anticoagulante (no dijo cuál)", atcCode: "B01A" }]).warnings).toHaveLength(1)
    expect(alerts({}, ["naproxeno"], [{ name: "ácido acetilsalicílico 100 mg", atcCode: "B01AC06" }]).warnings).toHaveLength(1)
    // Lo escrito a mano sin código no lleva marca: no se reconoce por el nombre (pendiente, la marca Sintrom).
    expect(alerts({}, ["ibuprofeno"], [{ name: "Sintrom", atcCode: null }]).warnings).toEqual([])
    expect(alerts({}, ["ibuprofeno"], [{ name: "losartán", atcCode: "C09CA01" }]).warnings).toEqual([])
  })

  // QA del 21 nov (H2): con «dijo apixabán, sin confirmar» en la franja, el ibuprofeno salía sin aviso.
  it("lo que dijo que toma y nadie confirmó también avisa, con esas palabras", () => {
    const said = (name: string | null, open: boolean) => ({ name, anticoagulant: true, open })
    const check = (list: ReturnType<typeof said>[], taking: Array<{ name: string; atcCode: string | null }> = []) =>
      prescribingAlerts({ interview: {}, today: TODAY, taking, said: list }, [{ genericName: "ibuprofeno" }], MEDICATIONS).warnings
    expect(check([said("apixabán", true)])).toEqual([
      "Ibuprofeno: dijo que toma apixabán, sin confirmar (anticoagulante o antiagregante), y los AINE aumentan el riesgo de sangrado; el paracetamol es la alternativa habitual.",
    ])
    expect(check([said(null, false)])[0]).toContain("dijo que toma un anticoagulante (no dijo cuál), en otra consulta, sin revisar")
    // Lo dicho que ya está registrado no se avisa dos veces.
    expect(check([said("apixabán", true)], [{ name: "apixabán", atcCode: "B01AF02" }])).toHaveLength(1)
    expect(prescribingAlerts({ interview: {}, today: TODAY, taking: [], said: [said("apixabán", true)] }, [{ genericName: "paracetamol" }], MEDICATIONS).warnings).toEqual([])
  })

  // FDA, 15 oct 2020: evitar AINE desde la semana 20. Clínica Y1: a Sofía, de 30 semanas, no se le avisaba.
  it("un AINE desde la semana 20 del embarazo se avisa; antes, solo se recuerda el embarazo", () => {
    expect(alerts(pregnant("2026-10-24", 30), ["ibuprofeno"]).warnings).toEqual([
      "Ibuprofeno: está embarazada (30 semanas) y los AINE se evitan desde la semana 20 del embarazo (ATC M01AE01).",
    ])
    const early = alerts(pregnant("2026-10-24", 12), ["ibuprofeno"])
    expect(early.warnings).toEqual([])
    expect(early.reminders).toHaveLength(1)
    // Sin semanas no se sabe: se avisa igual.
    expect(alerts(pregnant("2026-10-01"), ["ibuprofeno"]).warnings[0]).toMatch(/los AINE se evitan desde la semana 20/)
  })
})
