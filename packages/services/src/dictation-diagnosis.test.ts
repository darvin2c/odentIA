import { describe, expect, it } from "vitest"
import { diagnosisClash, diagnosisSibling, reviewDiagnosis } from "./dictation-diagnosis.js"

/**
 * Lo que encontró la cuarta prueba con voz del 15 nov (c4b, v07), tal como lo
 * oyó Chrome: «presenta fístula a nivel apical» y Clío propuso K04.7, «Absceso
 * periapical sin fístula», listo. Los nombres, como vienen en la CIE-10 del
 * MINSA y en la CIE-11 de la OMS.
 */
const K04 = [
  { code: "K04", title: "Enfermedades de la pulpa y de los tejidos periapicales", isCategory: true },
  { code: "K04.4", title: "Periodontitis apical aguda originada en la pulpa" },
  { code: "K04.5", title: "Periodontitis apical crónica" },
  { code: "K04.6", title: "Absceso periapical con fístula" },
  { code: "K04.7", title: "Absceso periapical sin fístula" },
]
const DA09 = [
  { code: "DA09.60", title: "Absceso periapical con afectación facial" },
  { code: "DA09.61", title: "Absceso periapical con fístula" },
  { code: "DA09.62", title: "Absceso periapical sin fístula" },
  { code: "DA09.6Z", title: "Absceso periapical, sin especificación" },
]

describe("un diagnóstico cuyo nombre contradice lo dictado", () => {
  const before = "sin dolor presenta fístula a nivel apical por vestibular tumefacción intraoral leve frío sin respuesta calor"
  const now = "sin respuesta también percusión negativa palpación positiva sondaje no lo pude medir bien después lo vemos radiográficamente radio lucidez periapical necrosis pulpar con absceso apical crónico"

  it("«sin fístula» con la fístula dicha en la pausa anterior: se propone «con fístula» (v07)", () => {
    const clash = diagnosisClash("Absceso periapical sin fístula", "necrosis pulpar con absceso apical crónico", [now, before])
    expect(clash).toEqual({ named: "sin fístula", said: "presenta fístula", from: "sin", to: "con", about: "fistula", unsure: false })
    expect(diagnosisSibling({ code: "K04.7", title: "Absceso periapical sin fístula" }, clash!, K04)?.code).toBe("K04.6")
    // En la CIE-11, el hermano de su misma categoría; nunca «sin especificación» ni «con afectación facial».
    expect(diagnosisSibling({ code: "DA09.62", title: "Absceso periapical sin fístula" }, clash!, DA09)?.code).toBe("DA09.61")
  })

  it("lo que no se dijo, o se negó, no contradice «sin fístula»", () => {
    expect(diagnosisClash("Absceso periapical sin fístula", "absceso apical crónico", [now])).toBeNull()
    expect(diagnosisClash("Absceso periapical sin fístula", "absceso apical crónico", ["no hay fístula ni tumefacción"])).toBeNull()
    expect(diagnosisClash("Absceso periapical sin fístula", "absceso apical crónico", ["tumefacción no tiene fístula tampoco"])).toBeNull()
    expect(diagnosisClash("Absceso periapical sin fístula", "absceso apical crónico", ["No se observa fístula."])).toBeNull()
  })

  it("al revés: «con fístula» cuando se negó la fístula", () => {
    const clash = diagnosisClash("Absceso periapical con fístula", "absceso apical crónico", ["percusión positiva, no se observa fístula"])
    expect(clash).toMatchObject({ named: "con fístula", said: "no se observa fístula", to: "sin", unsure: false })
    expect(diagnosisSibling({ code: "K04.6", title: "Absceso periapical con fístula" }, clash!, K04)?.code).toBe("K04.7")
  })

  it("lo más cerca decide; si lo dicho dice las dos cosas, se revisa sin proponer otro", () => {
    // La pausa nombra la fístula: lo anterior no cuenta.
    expect(diagnosisClash("Absceso periapical sin fístula", "absceso", ["sin fístula", "presenta fístula"])).toBeNull()
    const both = diagnosisClash("Absceso periapical sin fístula", "absceso", ["no había fístula y ahora presenta fístula"])
    expect(both).toMatchObject({ unsure: true })
    expect(diagnosisSibling({ code: "K04.7", title: "Absceso periapical sin fístula" }, both!, K04)).toBeNull()
  })

  it("agudo o crónico, con la frase del diagnóstico", () => {
    const clash = diagnosisClash("Periodontitis apical aguda originada en la pulpa", "periodontitis apical crónica")
    expect(clash).toEqual({ named: "aguda", said: "crónica", from: "aguda", to: "cronica", about: "cronic", unsure: false })
    expect(diagnosisSibling({ code: "K04.4", title: "Periodontitis apical aguda originada en la pulpa" }, clash!, K04)?.code).toBe("K04.5")
    expect(diagnosisClash("Periodontitis apical crónica", "periodontitis apical aguda")?.to).toBe("aguda")
    // Lo dicho de otra cosa en la pausa no cambia el curso: solo la frase del diagnóstico.
    expect(diagnosisClash("Periodontitis apical aguda originada en la pulpa", "periodontitis apical aguda", ["gingivitis crónica"])).toBeNull()
    expect(diagnosisClash("Gingivitis aguda", "gingivitis")).toBeNull()
  })

  it("sin hermano que calce, se revisa con el mismo código; de otra categoría, solo si es uno", () => {
    const clash = diagnosisClash("Faringitis aguda, no especificada", "faringitis crónica")!
    expect(diagnosisSibling({ code: "J02.9", title: "Faringitis aguda, no especificada" }, clash, [{ code: "J31.2", title: "Faringitis crónica" }, { code: "J31.0", title: "Rinitis crónica" }])?.code).toBe("J31.2")
    expect(diagnosisSibling({ code: "J02.9", title: "Faringitis aguda, no especificada" }, clash, [])).toBeNull()
  })

  it("«sin especificación» o «sin mención de…» no son un hallazgo dicho", () => {
    expect(diagnosisClash("Absceso periapical, sin especificación", "absceso con especificación")).toBeNull()
    expect(diagnosisClash("Diabetes mellitus no insulinodependiente, sin mención de complicación", "diabetes con mención")).toBeNull()
  })

  it("el servidor y la medición buscan los hermanos por lo que es y lo que deben nombrar", async () => {
    const asked: string[][] = []
    const find = (words: string[]) => {
      asked.push(words)
      return K04
    }
    const fistula = await reviewDiagnosis({ code: "K04.7", title: "Absceso periapical sin fístula" }, "absceso apical crónico", ["presenta fístula"], find)
    expect(fistula?.sibling?.code).toBe("K04.6")
    const course = await reviewDiagnosis({ code: "K04.4", title: "Periodontitis apical aguda originada en la pulpa" }, "periodontitis apical crónica", [], find)
    expect(course?.sibling?.code).toBe("K04.5")
    expect(asked).toEqual([
      ["absceso", "fistula"],
      ["periodontitis", "cronic"],
    ])
    expect(await reviewDiagnosis({ code: "K04.7", title: "Absceso periapical sin fístula" }, "absceso apical crónico", [], find)).toBeNull()
  })
})
