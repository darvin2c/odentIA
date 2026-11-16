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

describe("un número queda listo solo si lo dicho nombra su pregunta (c4)", () => {
  it("«hace 2 años» es un tiempo: no es la intensidad del dolor (v07)", () => {
    const heard = "pieza 21 incisivo central superior izquierdo paciente refiere un golpe Hace 2 años y que el diente se le ha ido poniendo oscuro"
    expect(ask(endo, "dolor_intensidad", "2", "Hace 2 años", heard)).toBeNull()
    // Citado sin la unidad, la oración dice que es un tiempo.
    expect(ask(endo, "dolor_intensidad", "2", "Hace 2", heard)).toBeNull()
    // Tampoco un conteo, una medida en mm ni un peso.
    expect(ask(kid, "ceod_c", "3", "cariados desde hace 3 semanas")).toBeNull()
    expect(ask(endo, "sondaje", "3", "sondaje de hace 3 meses")).toBeNull()
    expect(ask(kid, "peso", "2", "peso hace 2 días")).toBeNull()
    // El número de la pregunta, dicho junto a un tiempo, sigue valiendo.
    expect(ask(endo, "dolor_intensidad", "6", "intensidad 6 desde hace 3 días")).toMatchObject({ status: "lista", payload: { value: 6 } })
  })

  it("lo que nombra su pregunta sigue listo: «overjet de 4», «intensidad 8», «ocho de diez» tras «dolor»", () => {
    expect(ask(ortho, "overjet", "4", "overjet de 4 mm")).toMatchObject({ status: "lista", payload: { value: 4 } })
    expect(ask(endo, "dolor_intensidad", "8", "intensidad 8")).toMatchObject({ status: "lista", payload: { value: 8 } })
    expect(ask(endo, "dolor_intensidad", "8", "8 de 10", "pieza 3 6 dolor espontáneo 8 de 10 prueba de frío aumentada que persiste")).toMatchObject({ status: "lista", payload: { value: 8 } })
    expect(ask(endo, "dolor_intensidad", "8", "ocho de diez", "Dolor a la percusión en la cuatro seis, ocho de diez.")).toMatchObject({ status: "lista", payload: { value: 8 } })
    // «Le duele como un nueve»: entre las que llevan un número, el dolor es solo de la intensidad.
    expect(ask(endo, "dolor_intensidad", "9", "le duele como un nueve")).toMatchObject({ status: "lista", payload: { value: 9 } })
    // La unidad que solo tiene una pregunta de la ficha la nombra: «18 kg» es el peso.
    expect(ask(kid, "peso", "18", "18 kg", "beso 18 kg me duele")).toMatchObject({ status: "lista", payload: { value: 18 } })
    // La oración la nombra y la frase está en lo que dice de ella: el medio milímetro es de la inferior.
    const voice = "caninos el derecho clase 2 El izquierdo clase 1 línea Media Superior centrada la inferior desviada a la derecha eh medio milímetro"
    expect(ask(ortho, "linea_media_inferior_mm", "0.5", "eh medio milímetro", voice)).toMatchObject({ status: "lista", payload: { value: 0.5 } })
    expect(ask(ortho, "linea_media_superior_mm", "0.5", "eh medio milímetro", voice)).toMatchObject({ status: "por_revisar" })
    const cpod = "muy buenos días p o D cariados 3 perdidos uno obturados a ver 8 no 7 por favor"
    expect(ask(adult, "cpod_c", "3", "cariados 3", cpod)).toMatchObject({ status: "lista", payload: { value: 3 } })
  })

  it("si no la nombra, Clío la propone y se revisa", () => {
    const voice = "Sí señora a ver déjame medir 7 mm over byte de 4 succión por favor"
    expect(ask(ortho, "overjet", "7", "7 mm", voice)).toMatchObject({ status: "por_revisar", payload: { value: 7 }, note: "Dijiste «7 mm» sin nombrar «Overjet»: revísala." })
    expect(ask(ortho, "overbite", "4", "over byte de 4", voice)).toMatchObject({ status: "lista", payload: { value: 4 } })
    // Un número suelto sin nada de la ficha no nombra la escala.
    expect(ask(endo, "dolor_intensidad", "5", "cinco")).toMatchObject({ status: "por_revisar", payload: { value: 5 } })
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

  it("lo examinado que tomó la ficha en la pausa no se repite en el relato; lo demás de la oración se queda (c4)", () => {
    const voice =
      "mordida Cruzada no tiene hábitos respiración bucal o sea duerme con la boca abierta y se come las uñas diagnóstico mala oclusión clase 2 división 1"
    const habits = [
      { kind: "nota", payload: { presentIllness: "Se le soltó un bracket de abajo hace como una semana y está maltratando el carrillo. Duerme con la boca abierta y se come las uñas." } },
      { kind: "ficha", payload: { question: at(ortho, "habitos"), answers: ["Respiración bucal", "Onicofagia"] }, sourceText: "hábitos respiración bucal o sea duerme con la boca abierta y se come las uñas" },
    ]
    expect(withoutFormNotes(habits, ortho, FDI, voice)[0]?.payload).toEqual({ presentIllness: "Se le soltó un bracket de abajo hace como una semana y está maltratando el carrillo." })
    const heard = "beso 18 kg me duele descarriados uno con extracción indicada dos obturados higiene oral regular tiene placa en los molares"
    const hygiene = [
      { kind: "nota", payload: { evolution: "Higiene oral regular, con placa en los molares." } },
      { kind: "ficha", payload: { question: at(kid, "higiene"), answer: "Regular" }, sourceText: "higiene oral regular" },
    ]
    expect(withoutFormNotes(hygiene, kid, FDI, heard)[0]?.payload).toEqual({ evolution: "Placa en los molares." })
    // El dolor que cuenta el paciente es del relato aunque la ficha también lo tenga, y lo que se apoya en lo quitado tampoco se parte.
    const pain = [
      { kind: "nota", payload: { presentIllness: "Dolor espontáneo, no la deja dormir." } },
      { kind: "ficha", payload: { question: at(endo, "dolor"), answer: "Espontáneo" }, sourceText: "dolor espontáneo" },
    ]
    expect(withoutFormNotes(pain, endo, FDI, "dolor espontáneo no la deja dormir")[0]?.payload).toEqual({ presentIllness: "Dolor espontáneo, no la deja dormir." })
    const leans = [
      { kind: "nota", payload: { evolution: "Higiene oral regular, que mejoró desde el último control." } },
      { kind: "ficha", payload: { question: at(kid, "higiene"), answer: "Regular" }, sourceText: "higiene oral regular" },
    ]
    expect(withoutFormNotes(leans, kid, FDI, "higiene oral regular que mejoró desde el último control")[0]?.payload).toEqual({ evolution: "Higiene oral regular, que mejoró desde el último control." })
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

describe("cuando Clío duda entre dos opciones, las deja para elegir", () => {
  it("«prueba de frío aumentada» queda por revisar, sin valor, con las dos opciones posibles", () => {
    expect(ask(endo, "frio", "Aumentada, persiste", "prueba de frío aumentada")).toMatchObject({
      status: "por_revisar",
      payload: { value: null, choices: ["Aumentada, cede al retirar el estímulo", "Aumentada, persiste"] },
      note: expect.stringContaining("no alcanza para elegir entre"),
    })
    // Sin duda, no lleva opciones.
    expect(ask(endo, "frio", "Aumentada, persiste", "prueba de frío aumentada que persiste")?.payload).not.toHaveProperty("choices")
  })
})
