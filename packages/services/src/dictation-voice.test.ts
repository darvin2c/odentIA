import { describe, expect, it } from "vitest"
import { type DictationFormQuestion, formNetMisses, formQuestionsOf, prepareFormAnswer, withoutFormNotes } from "./dictation-forms.js"
import { pauseBridge, withPauseBridge } from "./dictation-heard.js"
import { dictatedService } from "./encounter-dictation.js"
import type { ProductSite } from "./product-hooks.js"
import { productHooksFor } from "./products.js"

/**
 * Lo que encontró la prueba con voz real del 15 nov (corrida c2, sobre
 * b90780a7), tal como lo oyó Chrome: procedimientos de otro servicio con su
 * precio, la frase que corta una pausa, números mal oídos que quedaban listos,
 * lo que no es del paciente en el relato y la frase que no era la del número.
 */

const FDI: ProductSite = {
  code: (value: unknown) => (typeof value === "number" && /^[1-4][1-8]$|^[5-8][1-5]$/.test(String(value)) ? String(value) : null),
  invalid: (value: unknown) => `${String(value)} no es una pieza`,
} as unknown as ProductSite

const formsOf = (key: string): DictationFormQuestion[] => {
  const form = productHooksFor("dental").forms.suggestions.find((item) => item.key === key)
  if (!form) throw new Error(key)
  return formQuestionsOf([{ id: key, title: form.title, snapshot: form.schema, answers: {} }])
}
const endo = formsOf("evaluacion-de-endodoncia")
const kid = formsOf("ficha-de-odontopediatria")
const adult = formsOf("ficha-odontoestomatologica")
const ortho = formsOf("ficha-de-ortodoncia")
const at = (forms: DictationFormQuestion[], fieldId: string) => forms.find((item) => item.fieldId === fieldId)?.number ?? 0
const ask = (forms: DictationFormQuestion[], fieldId: string, answer: string, said: string, transcript = said) =>
  prepareFormAnswer({ payload: { question: at(forms, fieldId), answer }, sourceText: said }, forms, FDI, transcript)

describe("un procedimiento del tarifario solo se propone si calza con lo dicho", () => {
  // El tarifario de la demo de odentIA, con lo que trae de la biblioteca.
  const DEMO = [
    "Apexificación, cambio de medicación",
    "Aparatología fija de ortodoncia",
    "Aparatología removible de ortodoncia",
    "Control de ortodoncia",
    "Obturación con resina",
    "Endodoncia anterior vital",
    "Endodoncia posterior vital",
    "Limpieza dental (profilaxis)",
    "Exodoncia simple",
    "Restauración con resina compuesta, una superficie",
  ]

  it("«cambiamos el arco» no es la apexificación: es el control de ortodoncia (v03)", () => {
    expect(dictatedService("cambiamos el arco", DEMO, "dental")).toEqual({ match: null, candidates: ["Control de ortodoncia"] })
    // Sin la palabra de todos los días del catálogo («arco»), no calzaría con ninguno: sin servicio ni precio.
    expect(dictatedService("cambiamos el arco", DEMO, "medical")).toEqual({ match: null, candidates: [] })
  })

  it("«cera de ortodoncia» no calza con la aparatología: no propone ninguna (v03)", () => {
    expect(dictatedService("cera de ortodoncia", DEMO, "dental")).toEqual({ match: null, candidates: [] })
  })

  it("lo que sí se dijo se sigue encontrando, también con otra palabra del mismo sentido", () => {
    expect(dictatedService("Control de ortodoncia", DEMO, "dental").match).toBe("Control de ortodoncia")
    expect(dictatedService("profilaxis", DEMO, "dental").match).toBe("Limpieza dental (profilaxis)")
    expect(dictatedService("la limpieza", DEMO, "dental").match).toBe("Limpieza dental (profilaxis)")
    expect(dictatedService("endodoncia", DEMO, "dental").candidates).toEqual(["Endodoncia anterior vital", "Endodoncia posterior vital"])
    expect(dictatedService("extracción", DEMO, "dental").candidates).toEqual(["Exodoncia simple"])
    expect(dictatedService("resina oclusal", DEMO, "dental").candidates).toEqual(["Obturación con resina", "Restauración con resina compuesta, una superficie"])
    expect(dictatedService("restauración con resina", DEMO, "dental").match).toBe("Restauración con resina compuesta, una superficie")
    expect(dictatedService("hicimos la exodoncia simple", DEMO, "dental").match).toBe("Exodoncia simple")
    expect(dictatedService("obturación de la 36", DEMO, "dental").match).toBe("Obturación con resina")
    expect(dictatedService("obturación de la 36", DEMO.filter((name) => !name.startsWith("Obturación")), "dental").candidates).toEqual(["Restauración con resina compuesta, una superficie"])
  })

  it("lo que se dice de más (la pieza, un fármaco, «completa») no deja fuera al que sí es", () => {
    expect(dictatedService("obturación con resina compuesta", DEMO, "dental").match).toBe("Obturación con resina")
    expect(dictatedService("control de ortodoncia mensual", DEMO, "dental").match).toBe("Control de ortodoncia")
    expect(dictatedService("endodoncia posterior vital de la molar", DEMO, "dental").match).toBe("Endodoncia posterior vital")
    expect(dictatedService("endodoncia de molar", DEMO, "dental").candidates).toEqual(["Endodoncia anterior vital", "Endodoncia posterior vital"])
    expect(dictatedService("exodoncia simple de la cuatro ocho", DEMO, "dental").match).toBe("Exodoncia simple")
    expect(dictatedService("resina de dos caras", DEMO, "dental").candidates).toEqual(["Obturación con resina", "Restauración con resina compuesta, una superficie"])
    expect(dictatedService("cambio de arco", DEMO, "dental").candidates).toEqual(["Control de ortodoncia"])
    // Un nombre que solo empieza igual no es lo dicho: «cera» no es la corona cerámica.
    expect(dictatedService("cera", [...DEMO, "Corona cerámica"], "dental")).toEqual({ match: null, candidates: [] })
    // Dos que contienen lo dicho: elige el profesional.
    expect(dictatedService("consulta de control", ["Consulta", "Consulta de control postoperatorio"], "dental")).toEqual({ match: null, candidates: ["Consulta de control postoperatorio", "Consulta"] })
    // Un material dicho en singular sigue siendo el de Inventario.
    expect(dictatedService("guante", ["Guantes de nitrilo", "Mascarilla quirúrgica"], "dental").match).toBe("Guantes de nitrilo")
  })

  it("en latidIA, igual: lo que no calza no propone otro servicio", () => {
    const LATIDIA = ["Consulta de medicina general", "Nebulización", "Inyectable intramuscular", "Electrocardiograma", "Ecografía abdominal"]
    expect(dictatedService("le pusimos una inyección intramuscular", LATIDIA, "medical").candidates).toEqual(["Inyectable intramuscular"])
    expect(dictatedService("cambiamos el vendaje", LATIDIA, "medical")).toEqual({ match: null, candidates: [] })
    expect(dictatedService("ecografía de partes blandas", LATIDIA, "medical")).toEqual({ match: null, candidates: [] })
    expect(dictatedService("nebulización con salbutamol", LATIDIA, "medical").match).toBe("Nebulización")
    expect(dictatedService("ecografía abdominal completa", LATIDIA, "medical").match).toBe("Ecografía abdominal")
    expect(dictatedService("electrocardiograma de reposo", LATIDIA, "medical").match).toBe("Electrocardiograma")
  })
})

describe("una frase partida por la pausa se lee junta (v07)", () => {
  const before = "sin dolor presenta fístula a nivel apical por vestibular tumefacción intraoral leve frío sin respuesta calor"
  const now = "sin respuesta también percusión negativa palpación positiva sondaje no lo pude medir bien después lo vemos radiográficamente radio lucidez periapical necrosis pulpar con absceso apical crónico"

  it("el tramo que sigue la frase lleva delante el final del anterior", () => {
    expect(pauseBridge(before, now)).toBe("frío sin respuesta calor")
    expect(withPauseBridge(before, now)).toBe(`frío sin respuesta calor ${now}`)
    // El que empieza otra frase, o sigue a uno que la cerró, se lee solo.
    expect(pauseBridge(before, "percusión negativa palpación positiva")).toBe("")
    // «en la 46…» o «y…» empiezan otra cosa: no se unen a lo anterior.
    expect(pauseBridge("hoy hicimos una profilaxis completa", "en la 46 caries oclusal")).toBe("")
    expect(pauseBridge("sondaje", "de 3 mm")).toBe("sondaje")
    expect(pauseBridge("Frío sin respuesta, calor sin respuesta.", "sin dolor a la percusión")).toBe("")
    expect(pauseBridge("", now)).toBe("")
    expect(withPauseBridge(undefined, now)).toBe(now)
  })

  it("el calor se propone con la frase unida, y la red mira el texto unido", () => {
    const joined = withPauseBridge(before, now)
    expect(ask(endo, "calor", "Sin respuesta", "calor sin respuesta también", joined)).toMatchObject({ status: "lista", payload: { value: "Sin respuesta" } })
    // Sin respuesta para el calor, la red avisa la oración unida; el tramo solo no nombra el calor.
    const calor = at(endo, "calor")
    expect(formNetMisses([], endo, FDI, joined).some((miss) => miss.questions.includes(calor))).toBe(true)
    expect(formNetMisses([], endo, FDI, now).some((miss) => miss.questions.includes(calor))).toBe(false)
  })
})

describe("un número mal oído no queda listo", () => {
  it("«para confirmarse 6 perdidos 2 obturados 4 simplificado 1,8»: perdidos no es 6 (v11)", () => {
    const heard = "para confirmarse 6 perdidos 2 obturados 4 simplificado 1,8"
    // Término y número: el 1,8 del final es del simplificado, y el orden da perdidos 2; como Clío dijo 6, se revisa.
    expect(ask(adult, "cpod_p", "6", "6 perdidos", heard)).toMatchObject({ status: "por_revisar", payload: { value: 2 }, said: "perdidos 2" })
    expect(ask(adult, "ihos", "1.8", "simplificado 1,8", heard)).toMatchObject({ status: "lista", payload: { value: 1.8 } })
  })

  it("un número con más decimales de los que se dictan queda por revisar (v12)", () => {
    const heard = "muy buenos días p o D cariados 3 perdidos uno obturados a ver 8 no 7 por favor ese Este 0,99"
    expect(ask(adult, "ihos", "0.99", "0,99", heard)).toMatchObject({ status: "por_revisar", payload: { value: 0.99 } })
    // Lo dicho en orden sigue listo.
    expect(ask(adult, "cpod_p", "1", "perdidos uno", heard)).toMatchObject({ status: "lista", payload: { value: 1 } })
    expect(ask(adult, "ihos", "1.8", "IHO-S 1,8")).toMatchObject({ status: "lista", payload: { value: 1.8 } })
  })

  it("si ningún número va al lado de un término, vale lo que leyó Clío", () => {
    const heard = "Línea media superior centrada, la inferior desviada a la izquierda dos milímetros."
    expect(ask(ortho, "linea_media_inferior_mm", "2", "la inferior desviada a la izquierda dos milímetros", heard)).toMatchObject({ status: "lista", payload: { value: 2 } })
    const voice = "caninos el derecho clase 2 El izquierdo clase 1 línea Media Superior centrada la inferior desviada a la derecha eh medio milímetro"
    expect(ask(ortho, "linea_media_inferior_mm", "0.5", "la inferior desviada a la derecha eh medio milímetro", voice)).toMatchObject({ status: "lista", payload: { value: 0.5 } })
  })

  it("sin un orden que lo diga, el número con otro a cada lado de su término queda por revisar", () => {
    const heard = "dice que 6 perdidos 2 obturados 4 simplificado 1,8 por favor"
    expect(ask(adult, "cpod_p", "6", "6 perdidos", heard)).toMatchObject({ status: "por_revisar", payload: { value: 6 } })
  })
})

describe("la frase que se muestra es la del número que se usó (v08)", () => {
  const heard = "buah ya mi amor Tranquila ya casi terminamos beso 18 kg me duele descarriados uno con extracción indicada dos obturados no quiero mamá mamá como un león eso bua higiene oral regular tiene placa en los molares"
  it("e = 1 dice «uno con extracción indicada», no «con extracción indicada dos»", () => {
    expect(ask(kid, "ceod_e", "2", "con extracción indicada dos", heard)).toEqual(
      expect.objectContaining({ status: "lista", payload: expect.objectContaining({ value: 1 }), said: "uno con extracción indicada" }),
    )
    // Si la frase ya tiene el número usado, se muestra la de Clío.
    expect(ask(kid, "ceod_o", "2", "dos obturados", heard)?.said).toBeUndefined()
  })
})

describe("el relato no recoge lo que no es del paciente", () => {
  it("lo que ya fue para la ficha no se repite en el relato (v08)", () => {
    const heard = "riesgo de caries alto y tres colabora pero con miedo mamá bua bua bua no quiero mamá mamá"
    const drafts = [
      { kind: "nota", payload: { presentIllness: "Presenta riesgo de caries alto y colabora pero con miedo." }, sourceText: "riesgo de caries alto y tres colabora pero con miedo" },
      { kind: "ficha", payload: { question: at(kid, "riesgo_caries"), answer: "Alto" }, sourceText: "riesgo de caries alto" },
      { kind: "ficha", payload: { question: at(kid, "conducta"), answer: "3 · Positiva" }, sourceText: "tres colabora pero con miedo" },
    ]
    expect(withoutFormNotes(drafts, kid, FDI, heard).filter((draft) => draft.kind === "nota")).toEqual([])
  })

  it("lo que se le preguntó al paciente se quita en toda pausa, también sin ficha", () => {
    const drafts = [{ kind: "nota", payload: { presentIllness: "¿Te duele cuando comes? Refiere dolor al masticar desde hace una semana." } }]
    expect(withoutFormNotes(drafts, [], FDI)).toEqual([{ kind: "nota", payload: { presentIllness: "Refiere dolor al masticar desde hace una semana." } }])
    expect(withoutFormNotes([{ kind: "nota", payload: { presentIllness: "¿Te duele aquí?" } }], [], FDI)).toEqual([])
    // Una pregunta al final de lo que cuenta no es una pregunta al paciente, y sin nada que quitar el texto queda tal cual.
    const told = { kind: "nota", payload: { presentIllness: "Refiere dolor al masticar, ¿verdad? Desde hace una semana.", indications: "Enjuague dos veces al día.\nDieta blanda." } }
    expect(withoutFormNotes([told], [], FDI)).toEqual([told])
  })
})
