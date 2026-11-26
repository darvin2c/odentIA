import { describe, expect, it } from "vitest"
// Por el índice, que carga primero los productos (ver `index.ts`).
import { pulpVariantOf } from "./index.js"
import {
  type DictationFormQuestion,
  dictatedDiagnoses,
  formDropNotices,
  formQuestionsOf,
  prepareFormAnswer,
  withFormDiagnoses,
  withoutRepeatedNotes,
} from "../dictation-forms.js"
import { dictatedService, plannedInSamePhrase } from "../encounter-dictation.js"
import { productHooksFor } from "../products.js"

/**
 * Lo que encontró la quinta prueba con voz del 15 nov (corrida c5, sobre 08027bf1), tal como lo oyó
 * Chrome: la endodoncia no vital lista con la pulpitis dictada (v06), la pulpitis que no llegó a
 * Diagnóstico (v06), la necrosis y el absceso que no llegaron (v07), el IHO-S que se perdió en
 * silencio (v12) y el relato repetido (v07).
 */

const dental = productHooksFor("dental")
const formOf = (key: string): DictationFormQuestion[] => {
  const form = dental.forms.suggestions.find((item) => item.key === key)
  if (!form) throw new Error(key)
  return formQuestionsOf([{ id: key, title: form.title, snapshot: form.schema, answers: {} }])
}
const endo = formOf("evaluacion-de-endodoncia")
const numberOf = (questions: DictationFormQuestion[], fieldId: string) => questions.find((item) => item.fieldId === fieldId)?.number ?? 0
const answer = (questions: DictationFormQuestion[], fieldId: string, value: string, said: string) => ({ kind: "ficha", payload: { question: numberOf(questions, fieldId), answer: value }, sourceText: said })

// El tarifario de la demo de odentIA en lo que toca a la endodoncia.
const DEMO = ["Apertura cameral", "Endodoncia anterior vital", "Endodoncia anterior no vital", "Endodoncia posterior vital", "Endodoncia posterior no vital", "Corona cerámica"]
const adult = { adult: true }
const pulpitis = { adult: true, diagnoses: [{ code: "K04.0", text: "Pulpitis", where: { toothNumber: 36 } }] }
const necrosis = { adult: true, diagnoses: [{ code: "K04.1", text: "Necrosis de la pulpa", where: { toothNumber: 36 } }] }

describe("la endodoncia vital o no vital sigue al diagnóstico de la pulpa (v06)", () => {
  it("con la pulpitis dictada, la vital, aunque Clío escriba la no vital", () => {
    expect(dictatedService("Endodoncia posterior no vital", DEMO, "dental", { toothNumber: 36 }, pulpitis)).toEqual({ match: "Endodoncia posterior vital", candidates: [] })
    expect(dictatedService("endodoncia", DEMO, "dental", { toothNumber: 36 }, pulpitis).match).toBe("Endodoncia posterior vital")
    // Lo que responde la ficha también es diagnóstico: «Pulpitis irreversible sintomática».
    const fromForm = { adult: true, diagnoses: [{ text: "Pulpitis irreversible sintomática", where: { toothNumber: 36 } }] }
    expect(dictatedService("Endodoncia posterior no vital", DEMO, "dental", { toothNumber: 36 }, fromForm).match).toBe("Endodoncia posterior vital")
  })

  it("con la necrosis o el absceso apical, la no vital", () => {
    expect(dictatedService("Endodoncia posterior vital", DEMO, "dental", { toothNumber: 36 }, necrosis).match).toBe("Endodoncia posterior no vital")
    const abscess = { adult: true, diagnoses: [{ code: "K04.6", text: "Absceso periapical con fístula" }] }
    expect(dictatedService("endodoncia", DEMO, "dental", { toothNumber: 36 }, abscess).match).toBe("Endodoncia posterior no vital")
    expect(dictatedService("endodoncia", DEMO, "dental", { toothNumber: 21 }, { adult: true, diagnoses: [{ text: "Absceso apical crónico" }] }).match).toBe("Endodoncia anterior no vital")
  })

  it("sin el diagnóstico, no elige: quedan las dos para elegir, aunque Clío escriba una", () => {
    expect(dictatedService("Endodoncia posterior no vital", DEMO, "dental", { toothNumber: 36 }, adult)).toEqual({
      match: null,
      candidates: ["Endodoncia posterior no vital", "Endodoncia posterior vital"],
    })
    expect(dictatedService("endodoncia", DEMO, "dental", { toothNumber: 36 }, adult).candidates).toEqual(["Endodoncia posterior vital", "Endodoncia posterior no vital"])
    // El diagnóstico de otra pieza no decide esta; la periodontitis apical no dice cómo está la pulpa.
    expect(dictatedService("Endodoncia posterior vital", DEMO, "dental", { toothNumber: 36 }, { adult: true, diagnoses: [{ code: "K04.1", text: "Necrosis de la pulpa", where: { toothNumber: 46 } }] }).match).toBeNull()
    expect(dictatedService("Endodoncia posterior vital", DEMO, "dental", { toothNumber: 36 }, { adult: true, diagnoses: [{ code: "K04.4", text: "Periodontitis apical aguda originada en la pulpa" }] }).match).toBeNull()
  })

  it("lo dicho de la misma indicación decide; si contradice el diagnóstico, se elige entre las dos", () => {
    const said = (text: string) => ({ adult: true, diagnoses: [{ text, where: { toothNumber: 36 } }] })
    expect(dictatedService("Endodoncia posterior no vital", DEMO, "dental", { toothNumber: 36 }, said("endodoncia no vital de la 36")).match).toBe("Endodoncia posterior no vital")
    expect(dictatedService("Endodoncia posterior vital", DEMO, "dental", { toothNumber: 36 }, said("la pulpa no es vital")).match).toBe("Endodoncia posterior no vital")
    const both = { adult: true, diagnoses: [...pulpitis.diagnoses, { text: "endodoncia no vital de la 36", where: { toothNumber: 36 } }] }
    expect(dictatedService("Endodoncia posterior no vital", DEMO, "dental", { toothNumber: 36 }, both).match).toBeNull()
  })

  it("con una sola variante en el tarifario, esa; la que contradice solo se ofrece para elegir", () => {
    const onlyVital = ["Endodoncia posterior vital"]
    expect(dictatedService("endodoncia", onlyVital, "dental", { toothNumber: 36 }, adult).match).toBe("Endodoncia posterior vital")
    expect(dictatedService("endodoncia", onlyVital, "dental", { toothNumber: 36 }, necrosis)).toEqual({ match: null, candidates: ["Endodoncia posterior vital"] })
  })

  it("lo que presupone la necrosis es la no vital, como el aviso de la pieza (decisión B2): la periodontitis apical crónica sí, la aguda no", () => {
    const at = (code: string) => ({ adult: true, diagnoses: [{ code, text: "", where: { toothNumber: 36 } }] })
    expect(dictatedService("endodoncia", DEMO, "dental", { toothNumber: 36 }, at("K04.5")).match).toBe("Endodoncia posterior no vital")
    expect(dictatedService("endodoncia", DEMO, "dental", { toothNumber: 36 }, at("DA09.1")).match).toBe("Endodoncia posterior no vital")
    expect(dictatedService("endodoncia", DEMO, "dental", { toothNumber: 36 }, at("DA09.0")).match).toBe("Endodoncia posterior vital")
    expect(dictatedService("endodoncia", DEMO, "dental", { toothNumber: 36 }, at("K04.4")).match).toBeNull()
  })

  it("solo un tratamiento de la pulpa tiene variante: «hueso no vital» o «vitalidad» no; la familia de la biblioteca manda", () => {
    expect(pulpVariantOf({ name: "Tratamiento de conductos del molar" }, "endodoncia-no-vital")).toBe("necrotic")
    expect(pulpVariantOf({ name: "Endodoncia posterior vital" }, "exodoncia")).toBeNull()
    expect(pulpVariantOf({ name: "Endodoncia posterior no vital" })).toBe("necrotic")
    expect(pulpVariantOf({ name: "Endodoncia unirradicular no vital, sin obturación final" })).toBe("necrotic")
    expect(pulpVariantOf({ name: "Endodoncia bicúspide vital" })).toBe("vital")
    expect(pulpVariantOf({ name: "Biopulpectomía" })).toBe("vital")
    expect(pulpVariantOf({ name: "Necropulpectomía" })).toBe("necrotic")
    expect(pulpVariantOf({ name: "Secuestrectomía de hueso no vital" })).toBeNull()
    expect(pulpVariantOf({ name: "Prueba de vitalidad pulpar" })).toBeNull()
    expect(pulpVariantOf({ name: "Apertura cameral" })).toBeNull()
  })
})

describe("lo diagnosticado en la atención, con la pieza de su ficha (v06)", () => {
  it("lee los diagnósticos, lo listo de la ficha y lo ya escrito; lo que se revisa no", () => {
    const answers = [
      { kind: "ficha", status: "lista", payload: { responseId: "evaluacion-de-endodoncia", fieldId: "pieza", type: "pieza", value: 36 } },
      { kind: "ficha", status: "lista", payload: { responseId: "evaluacion-de-endodoncia", fieldId: "diagnostico_pulpar", type: "opcion_unica", value: "Pulpitis irreversible sintomática" } },
      { kind: "ficha", status: "por_revisar", payload: { responseId: "evaluacion-de-endodoncia", fieldId: "diagnostico_apical", type: "opcion_unica", value: "Absceso apical agudo" } },
      { kind: "diagnostico", payload: { diagnosisCode: "K04.4", description: "Periodontitis apical aguda originada en la pulpa", toothNumber: 36 } },
    ]
    expect(dictatedDiagnoses(answers, endo)).toEqual([
      { code: "K04.4", text: "Periodontitis apical aguda originada en la pulpa", where: answers[3]?.payload },
      { code: null, text: "Pulpitis irreversible sintomática", where: { toothNumber: 36 } },
    ])
    // Con las opciones que son un diagnóstico, la respuesta lleva su código.
    expect(dictatedDiagnoses(answers, endo, { codes: dental.forms.diagnoses })[1]).toMatchObject({ code: "K04.0" })
  })
})

describe("la respuesta de la ficha que es un diagnóstico va también a Diagnóstico (v06 y v07)", () => {
  const site = dental.site
  const codes = dental.forms.diagnoses

  it("v06: con solo K04.4 de Clío, la pulpitis de la ficha propone K04.0 en la 36; la apical ya está", () => {
    const heard =
      "este 10 a 36 intensidad 9 de 10 diagnóstico pulpar pulpitis Irreversible sintomática apical periodontitis apical sintomática plan endodoncia de la 36 y luego Corona"
    const drafts = [
      answer(endo, "pieza", "36", "este 10 a 36"),
      answer(endo, "diagnostico_pulpar", "Pulpitis irreversible sintomática", "diagnóstico pulpar pulpitis Irreversible sintomática"),
      answer(endo, "diagnostico_apical", "Periodontitis apical sintomática", "apical periodontitis apical sintomática"),
      { kind: "diagnostico", payload: { diagnosisCode: "K04.4", toothNumber: 36 }, sourceText: "diagnóstico pulpar pulpitis Irreversible sintomática apical periodontitis apical sintomática" },
    ]
    expect(withFormDiagnoses(drafts, endo, codes, { site, transcript: heard })).toEqual([
      { kind: "diagnostico", payload: { diagnosisCode: "K04.0", diagnosisType: "confirmed", toothNumber: 36 }, sourceText: "diagnóstico pulpar pulpitis Irreversible sintomática" },
    ])
  })

  it("v07: sin ningún diagnóstico de Clío, la necrosis y el absceso de la ficha, con la pieza de la pausa anterior", () => {
    const heard = "sin respuesta también percusión negativa palpación positiva radiográficamente radio lucidez periapical necrosis pulpar con absceso apical crónico"
    const drafts = [answer(endo, "diagnostico_pulpar", "Necrosis pulpar", "necrosis pulpar"), answer(endo, "diagnostico_apical", "Absceso apical crónico", "absceso apical crónico")]
    const pending = new Map<number, unknown>([[numberOf(endo, "pieza"), 21]])
    expect(withFormDiagnoses(drafts, endo, codes, { site, transcript: heard, pending })).toEqual([
      { kind: "diagnostico", payload: { diagnosisCode: "K04.1", diagnosisType: "confirmed", toothNumber: 21 }, sourceText: "necrosis pulpar" },
      { kind: "diagnostico", payload: { diagnosisCode: "K04.6", diagnosisType: "confirmed", toothNumber: 21 }, sourceText: "absceso apical crónico" },
    ])
    // Con uno de esa pregunta ya propuesto en esa pieza o sin pieza (aunque sea otro), no se propone el de la ficha.
    expect(withFormDiagnoses(drafts, endo, codes, { site, transcript: heard, pending, known: [{ diagnosisCode: "K04.7", toothNumber: 21 }, { diagnosisCode: "K04.1" }] })).toEqual([])
    // El de otra pieza no cuenta: la necrosis de la 21 se propone aunque haya una pulpitis en la 46.
    expect(withFormDiagnoses(drafts, endo, codes, { site, transcript: heard, pending, known: [{ diagnosisCode: "K04.0", toothNumber: 46 }] }).map((item) => item.payload["diagnosisCode"])).toEqual([
      "K04.1",
      "K04.6",
    ])
  })

  it("si se corrigió en la misma pausa, vale lo último: el diagnóstico y la pieza", () => {
    const heard = "pieza 36 no perdón 46 pulpitis irreversible sintomática no mejor dicho necrosis pulpar"
    const drafts = [
      answer(endo, "pieza", "36", "pieza 36"),
      answer(endo, "diagnostico_pulpar", "Pulpitis irreversible sintomática", "pulpitis irreversible sintomática"),
      answer(endo, "pieza", "46", "46"),
      answer(endo, "diagnostico_pulpar", "Necrosis pulpar", "necrosis pulpar"),
    ]
    expect(withFormDiagnoses(drafts, endo, codes, { site, transcript: heard })).toEqual([
      { kind: "diagnostico", payload: { diagnosisCode: "K04.1", diagnosisType: "confirmed", toothNumber: 46 }, sourceText: "necrosis pulpar" },
    ])
    // Lo diagnosticado para elegir la endodoncia, también: la necrosis en la 46, no la pulpitis.
    const items = drafts.map((draft) => ({ kind: "ficha", status: "lista", payload: prepareFormAnswer(draft, endo, site, heard)?.payload ?? {} }))
    expect(dictatedDiagnoses(items, endo)).toEqual([{ code: null, text: "Necrosis pulpar", where: { toothNumber: 46 } }])
  })

  it("sin códigos del producto (latidIA) o con la respuesta sin decir, nada", () => {
    const drafts = [answer(endo, "diagnostico_pulpar", "Necrosis pulpar", "percusión negativa")]
    expect(withFormDiagnoses(drafts, endo, undefined, { site, transcript: "necrosis pulpar" })).toEqual([])
    expect(withFormDiagnoses(drafts, endo, codes, { site, transcript: "percusión negativa" })).toEqual([])
  })
})

describe("un número que se pierde no se pierde en silencio (v12)", () => {
  const stomato = formOf("ficha-odontoestomatologica")
  const heard = "muy buenos días p o D cariados 3 perdidos uno obturados a ver 8 no 7 por favor ese Este 0,99"

  it("Clío propuso 0,9 y Chrome oyó «0,99»: no se propone y va a «No pude usar esto» con «revisa los decimales»", () => {
    const draft = answer(stomato, "ihos", "0.9", "Este 0,99")
    expect(prepareFormAnswer(draft, stomato, dental.site, heard)).toBeNull()
    expect(formDropNotices([{ draft, ready: false }], new Set(), stomato, { site: dental.site, transcript: heard }).filter((item) => item.by === "motivo")).toEqual([
      { said: "Este 0,99", why: "Dijiste «Este 0,99»: revisa los decimales.", questions: [numberOf(stomato, "ihos")], by: "motivo" },
    ])
  })

  it("con 0,99 queda por revisar, como dice la regla del número con su pregunta", () => {
    expect(prepareFormAnswer(answer(stomato, "ihos", "0.99", "Este 0,99"), stomato, dental.site, heard)).toMatchObject({ status: "por_revisar", payload: { value: 0.99 } })
  })

  it("un número que el modelo sacó de otra cosa sigue sin avisarse: «hace 2 años» no es la intensidad", () => {
    const said = "paciente refiere un golpe Hace 2 años"
    const draft = answer(endo, "dolor_intensidad", "2", said)
    expect(prepareFormAnswer(draft, endo, dental.site, said)).toBeNull()
    expect(formDropNotices([{ draft, ready: false }], new Set(), endo, { site: dental.site, transcript: said }).filter((item) => item.by === "motivo")).toEqual([])
  })

  it("el número de otra pregunta con un decimal menos no avisa en esta: «intensidad 2,5» no es el sondaje", () => {
    const said = "intensidad 2,5"
    const draft = answer(endo, "sondaje", "2", said)
    expect(formDropNotices([{ draft, ready: false }], new Set(), endo, { site: dental.site, transcript: said }).filter((item) => item.by === "motivo")).toEqual([])
  })
})

describe("el relato no repite lo que ya cuenta una nota pendiente (v07)", () => {
  const before = ["Paciente refiere que el diente se le ha ido poniendo oscuro tras un golpe.", "Golpe en diente"]

  it("la frase que cortó la pausa no vuelve al relato; lo nuevo sí", () => {
    const repeated = { kind: "nota", payload: { presentIllness: "Refiere que el diente se le ha ido poniendo oscuro." }, sourceText: "ha ido poniendo oscuro" }
    expect(withoutRepeatedNotes([repeated], before)).toEqual([])
    const more = { kind: "nota", payload: { presentIllness: "Refiere que el diente se le ha ido poniendo oscuro. Le molesta al morder." } }
    expect(withoutRepeatedNotes([more], before)).toEqual([{ kind: "nota", payload: { presentIllness: "Le molesta al morder." } }])
  })

  it("lo que niega lo dicho antes no lo repite, y lo demás no se toca", () => {
    const denied = { kind: "nota", payload: { presentIllness: "No refiere que el diente se le haya puesto oscuro." } }
    expect(withoutRepeatedNotes([denied], before)).toEqual([denied])
    const finding = answer(endo, "dolor", "Sin dolor", "sin dolor")
    expect(withoutRepeatedNotes([finding], before)).toEqual([finding])
    expect(withoutRepeatedNotes([denied], [])).toEqual([denied])
  })

  it("otra pieza u otro número es otra cosa: no se quita", () => {
    const other = { kind: "nota", payload: { presentIllness: "Dolor espontáneo en la pieza 46." } }
    expect(withoutRepeatedNotes([other], ["Dolor espontáneo en la pieza 36."])).toEqual([other])
    const longer = { kind: "nota", payload: { presentIllness: "Dolor desde hace cinco días." } }
    expect(withoutRepeatedNotes([longer], ["Dolor desde hace 2 días."])).toEqual([longer])
  })
})

describe("el repaso no repite el relato con otras palabras (revisión del 25 nov)", () => {
  const before = ["Le falta la vacuna del sarampión de los doce meses; no se la pusieron porque estaba resfriada."]
  const again = { kind: "nota", payload: { presentIllness: "La mamá refiere que le falta la vacuna del sarampión de los 12 meses, no se la pusieron porque estaba resfriada." } }

  it("en el repaso, lo mismo dicho de otra forma no se suma otra vez", () => {
    expect(withoutRepeatedNotes([again], before, { review: true })).toEqual([])
  })

  it("en la pausa sigue la regla estricta, y lo nuevo del repaso se queda", () => {
    expect(withoutRepeatedNotes([again], before)).toEqual([again])
    const other = { kind: "nota", payload: { presentIllness: "Tiene tos desde hace tres días, sin fiebre." } }
    expect(withoutRepeatedNotes([other], before, { review: true })).toEqual([other])
  })
})

describe("el repaso no tapa lo que contradice lo de antes", () => {
  it("«refiere dolor al morder la pieza» no repite «no refiere dolor al morder la pieza»", () => {
    const now = { kind: "nota", payload: { presentIllness: "Refiere dolor al morder la pieza." } }
    expect(withoutRepeatedNotes([now], ["No refiere dolor al morder la pieza. Viene a control."], { review: true })).toEqual([now])
  })
})

describe("lo dicho para otro día no queda también como hecho hoy (revisión del 25 nov)", () => {
  const phrase = "para la resina de la cuarenta y seis lo vemos la próxima"
  const done = { kind: "procedimiento", payload: { service: "resina", toothNumber: 46 }, sourceText: phrase }
  const plan = { kind: "plan", payload: { service: "Resina", toothNumber: 46 }, sourceText: phrase }

  it("la misma frase en el plan y en lo hecho: gana el plan", () => {
    expect(plannedInSamePhrase(done, [done, plan])).toBe(true)
  })

  it("en frases distintas, otra pieza u otra prestación, las dos se quedan", () => {
    expect(plannedInSamePhrase({ ...done, sourceText: "ya, la hacemos ahora" }, [done, plan])).toBe(false)
    expect(plannedInSamePhrase(done, [{ ...plan, payload: { service: "resina", toothNumber: 36 } }])).toBe(false)
    expect(plannedInSamePhrase(done, [{ ...plan, payload: { service: "corona", toothNumber: 46 } }])).toBe(false)
  })
})

describe("el repaso no tapa un cambio clínico (revisión de código del 26 nov)", () => {
  const before = ["Refiere dolor en el lado derecho al masticar, que aumenta con el frío."]
  it.each(["Refiere dolor en el lado izquierdo al masticar.", "Dolor que aumenta con el calor.", "Refiere dolor punzante al masticar."])("«%s» se queda", (said) => {
    const now = { kind: "nota", payload: { presentIllness: said } }
    expect(withoutRepeatedNotes([now], before, { review: true })).toEqual([now])
  })
})

describe("lo dicho como plan con otras caras o sin pieza no quita lo de hoy", () => {
  const phrase = "hoy le hago la resina oclusal de la 46 y la distal la próxima"
  it("otras caras de la misma pieza: las dos se quedan", () => {
    const done = { kind: "procedimiento", payload: { service: "resina", toothNumber: 46, surfaces: ["O"] }, sourceText: phrase }
    const plan = { kind: "plan", payload: { service: "resina", toothNumber: 46, surfaces: ["D"] }, sourceText: phrase }
    expect(plannedInSamePhrase(done, [done, plan])).toBe(false)
  })
  it("sin pieza: las dos se quedan", () => {
    const said = "hoy la profilaxis y otra profilaxis en seis meses"
    expect(plannedInSamePhrase({ kind: "procedimiento", payload: { service: "profilaxis" }, sourceText: said }, [{ kind: "plan", payload: { service: "profilaxis" }, sourceText: said }])).toBe(false)
  })
})
