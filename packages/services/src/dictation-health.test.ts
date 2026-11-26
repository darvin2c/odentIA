import { describe, expect, it } from "vitest"
import { declaredMedications } from "./clinical.js"
import {
  companionFamily,
  companionKinOf,
  companionOwnMedicinesWhy,
  familyKinshipOf,
  familyRelationWords,
  groundHealthNames,
  hasDeclaredHealth,
  healthByDeclarant,
  healthOfPayload,
  healthNamed,
  healthNegated,
  healthSupersedingKeysOf,
  healthRows,
  healthSaidBy,
  healthSaidOf,
  mergeHealth,
  prepareHealth,
  saidFamilyOf,
  saidInDoubt,
  saidStoppedOf,
  sameDrug,
  selfConditionsOf,
  selfCorrectedHealth,
  speaksOfSelf,
  splitHealthDenials,
  withoutSettledHealth,
  withoutHealthKeys,
  withoutMisspokenStopped,
  withoutStopped,
  withConditionsToFamily,
  withSaidPhrases,
} from "./dictation-health.js"
import { doubtfulAllergy } from "./encounter-dictation.js"
import { productHooksFor } from "./products.js"

const DENTAL = productHooksFor("dental").dictation!.health

/*
 * Lo de salud dicho en la conversación, sin base (revisión del 21 nov 2026 de «Clío en una consulta
 * conversada»): las reglas puras que deciden qué se propone, de quién y qué se guarda.
 */

describe("A1 · «no sé» y «quizá» con tilde son duda", () => {
  it("se reconocen con la tilde al final, como los escribe la voz de Chrome", () => {
    // Con `\b`, JavaScript no veía la «é» ni la «á» como letras: estas daban `false`.
    expect(saidInDoubt("no sé")).toBe(true)
    expect(saidInDoubt("No sé, doctora")).toBe(true)
    expect(saidInDoubt("¿alergias? no sé.")).toBe(true)
    expect(saidInDoubt("quizá")).toBe(true)
    expect(saidInDoubt("quizás sí")).toBe(true)
    expect(saidInDoubt("no se")).toBe(true)
    // Lo que no es duda sigue sin serlo: la frase dentro de otra palabra no cuenta.
    expect(saidInDoubt("no sería mala idea")).toBe(false)
    expect(saidInDoubt("tomo losartán")).toBe(false)
  })

  it("«¿Alérgica a algo? — No sé» no queda «No tiene alergias»", () => {
    const draft = doubtfulAllergy({ kind: "alergia", payload: { none: true }, sourceText: "No sé" })
    expect(draft).toEqual({ kind: "salud", payload: { declarante: "no_se_sabe", allergies: { state: "unknown" } }, sourceText: "No sé" })
  })

  it("un «no» a las enfermedades dicho con «no sé» queda como que no sabe", () => {
    const ready = prepareHealth({ declarante: "paciente", conditions: { state: "none", items: [] } }, "No sé, creo que nada", {})
    expect(ready?.payload["conditions"]).toEqual({ state: "unknown", items: [] })
  })
})

describe("A2 · «Lo revisé con…» no guarda un «No» de paso", () => {
  it("lo que nombró y lo que no sabe se guardan; el «No» queda esperando su fila", () => {
    const { kept, denied } = splitHealthDenials({
      declarante: "paciente",
      medications: { state: "recorded", items: [{ name: "losartán" }] },
      conditions: { state: "none", items: [] },
      allergies: { state: "unknown", items: [] },
      dental: { ansiedadDental: "alta", bruxismo: false },
    })
    expect(Object.keys(kept).filter((key) => key !== "quien").sort()).toEqual(["allergies", "declarante", "dental", "medications"])
    expect(kept["dental"]).toEqual({ ansiedadDental: "alta" })
    expect(denied["conditions"]).toEqual({ state: "none", items: [] })
    expect(denied["dental"]).toEqual({ bruxismo: false })
    expect(denied["medications"]).toBeUndefined()
  })

  it("las filas dicen cuál es un «No»", () => {
    const rows = healthRows({ declarante: "paciente", conditions: { state: "none", items: [] }, anticoagulants: { state: "recorded", detail: "apixabán" } })
    expect(rows.map((row) => [row.key, row.denied])).toEqual([
      ["anticoagulants", false],
      ["conditions", true],
    ])
  })
})

describe("A4 · cada dato con quien lo dijo", () => {
  const patient = prepareHealth({ declarante: "paciente", medications: { state: "recorded", items: [{ name: "losartán" }] } }, "tomo losartán", {})!.payload
  const daughter = prepareHealth({ declarante: "acompanante", vinculo: "hija", medications: { state: "recorded", items: [{ name: "metformina" }] } }, "también toma metformina", {})!.payload

  it("la metformina que dijo su hija no queda a nombre del paciente", () => {
    // Antes, la propuesta tenía un solo declarante: el primero que habló.
    const merged = prepareHealth(mergeHealth(patient, daughter).payload, undefined, {})!.payload
    expect(healthSaidBy(merged)).toEqual({ "medications:losartan": { declarante: "paciente" }, "medications:metformina": { declarante: "acompanante", vinculo: "hija" } })
    expect(healthRows(merged)[0]?.value).toBe("losartán · metformina (lo dijo su hija)")
    // Al confirmarla, una declaración por persona.
    expect(healthByDeclarant(merged).map((person) => [person.by, person.payload["medications"]])).toEqual([
      [{ declarante: "paciente" }, { state: "recorded", items: [{ name: "losartán" }] }],
      [{ declarante: "acompanante", vinculo: "hija" }, { state: "recorded", items: [{ name: "metformina" }] }],
    ])
  })

  it("«señora» es cómo le habló la doctora, no su parentesco: no se guarda como vínculo (QA del 21 nov)", () => {
    const said = prepareHealth({ declarante: "acompanante", vinculo: "Señora", conditions: { state: "recorded", items: [{ name: "asma" }] } }, "tiene asma", {})!.payload
    expect(said["vinculo"]).toBeUndefined()
    expect(healthRows(said)[0]?.value).not.toContain("señora")
  })

  it("lo de la entrevista también, campo por campo", () => {
    const fear = prepareHealth({ declarante: "paciente", dental: { ansiedadDental: "alta" } }, "me da miedo", DENTAL)!.payload
    const grind = prepareHealth({ declarante: "acompanante", vinculo: "esposo", dental: { bruxismo: true } }, "rechina de noche", DENTAL)!.payload
    const merged = mergeHealth(fear, grind).payload
    expect(healthRows(merged).map((row) => [row.key, row.by.declarante])).toEqual([
      ["dental.ansiedadDental", "paciente"],
      ["dental.bruxismo", "acompanante"],
    ])
    expect(healthByDeclarant(merged)).toHaveLength(2)
  })
})

describe("A5 · lo que nombra sale de su frase", () => {
  it("un anticoagulante o una medicina que no se dijo no se propone", () => {
    const heard = groundHealthNames(
      { declarante: "paciente", anticoagulants: { state: "recorded", detail: "apixabán" }, medications: { state: "recorded", items: [{ name: "losartán 50 mg" }, { name: "metformina" }] } },
      "Tomo warfarina y losartan de cincuenta",
    )
    expect(heard.notHeard).toEqual(["metformina", "apixabán"])
    expect(heard.payload?.["anticoagulants"]).toEqual({ state: "recorded" })
    expect(heard.payload?.["medications"]).toEqual({ state: "recorded", items: [{ name: "losartán", dose: "50 mg" }] })
  })

  it("se reconoce por una palabra que lo distingue o por cómo suena", () => {
    expect(groundHealthNames({ medications: { state: "recorded", items: [{ name: "inhalador de salbutamol" }] } }, "usa salbutamol").notHeard).toEqual([])
    expect(groundHealthNames({ conditions: { state: "recorded", items: [{ name: "diabetes" }] } }, "es diabética").notHeard).toEqual([])
    expect(groundHealthNames({ anticoagulants: { state: "recorded", detail: "Eliquis" } }, "toma el eliquis").notHeard).toEqual([])
    // Una lista que se queda sin nada de lo que nombró no se propone.
    expect(groundHealthNames({ conditions: { state: "recorded", items: [{ name: "asma" }] } }, "tiene presión alta").payload).toBeNull()
  })
})

describe("A6 · lo resuelto no se vuelve a proponer", () => {
  it("lo que quedó en Antecedentes se quita de una propuesta nueva", () => {
    const resolved = [{ medications: { state: "recorded", items: [{ name: "losartán" }] } }]
    expect(withoutSettledHealth({ declarante: "paciente", medications: { state: "recorded", items: [{ name: "Losartan" }] } }, resolved)).toBeNull()
  })
})

// QA del 22 nov (UX-3): el aviso de su salud no decía qué se oyó en cada fila; la propuesta juntaba
// las frases de varias pausas en una sola, sin saber de qué dato era cada una.
describe("cada dato de su salud con la frase en que se oyó", () => {
  it("cada fila lleva la frase de la pausa que la dijo; dicha otra vez, la última", () => {
    const first = { declarante: "paciente", medications: { state: "recorded", items: [{ name: "losartán" }] } }
    const second = { declarante: "paciente", allergies: { state: "unknown" }, medications: { state: "recorded", items: [{ name: "losartán" }, { name: "metformina" }] } }
    const said = healthSaidOf(second, "y metformina en el almuerzo, y alergias no que yo sepa", healthSaidOf(first, "si tomo losartan para la presion"))
    const rows = withSaidPhrases(healthRows({ ...second, medications: second.medications }), said)
    expect(Object.fromEntries(rows.map((row) => [row.key, row.said]))).toEqual({
      medications: "y metformina en el almuerzo, y alergias no que yo sepa",
      allergies: "y metformina en el almuerzo, y alergias no que yo sepa",
    })
    // Sin frase no se inventa una.
    expect(healthSaidOf(first, "  ", { medications: "antes" })).toEqual({ medications: "antes" })
    expect(withSaidPhrases(healthRows(first))[0]?.said).toBeUndefined()
  })
})

// QA del 23 nov (verificador 2): en el niño, «tiene asma usa salbutamol» y en otra pausa «toma algo para
// la tiroides» dejaron «salbutamol (antes dijo salbutamol)»: la segunda pisaba a la primera.
describe("una medicina más se suma; solo la que se corrige cambia", () => {
  const salbutamol = { declarante: "acompanante", vinculo: "madre", medications: { state: "recorded", items: [{ name: "salbutamol" }] } }

  it("lo que solo dice para qué la toma no es una medicina: no se propone y se dice por qué", () => {
    const heard = groundHealthNames({ medications: { state: "recorded", items: [{ name: "algo para la tiroides" }] } }, "toma algo para la tiroides pero no me acuerdo el nombre")
    expect(heard.payload).toBeNull()
    expect(heard.unnamed).toEqual(["algo para la tiroides"])
    expect(groundHealthNames({ medications: { state: "recorded", items: [{ name: "Unas pastillas para la presión" }] } }, "unas pastillas para la presion").unnamed).toHaveLength(1)
    // Un nombre de verdad sí, aunque diga cómo viene.
    expect(groundHealthNames({ medications: { state: "recorded", items: [{ name: "tabletas de losartán" }] } }, "tabletas de losartan").unnamed).toEqual([])
  })

  it("una enfermedad que no dice cuál es no se propone (QA del 23 nov, verificador 3)", () => {
    const said = "tiene asma algo en los huesos le hicieron unos examenes y salio algo a veces se le hinchan las piernas"
    const names = ["Asma", "algo en los huesos", "le hicieron unos examenes y salio algo", "a veces se le hinchan las piernas"]
    const heard = groundHealthNames({ conditions: { state: "recorded", items: names.map((name) => ({ name })) } }, said)
    expect(heard.vague).toEqual(["algo en los huesos", "le hicieron unos examenes y salio algo"])
    expect((heard.payload?.["conditions"] as { items: Array<{ name: string }> }).items.map((item) => item.name)).toEqual(["Asma", "a veces se le hinchan las piernas"])
  })

  it("una corrección cuya frase no nombra la medicina de antes la suma, sin «antes dijo»", () => {
    const merged = mergeHealth(salbutamol, { medications: { state: "recorded", items: [{ name: "levotiroxina" }] } }, "y toma levotiroxina para la tiroides")
    expect(merged.payload["medications"]).toEqual({ state: "recorded", items: [{ name: "salbutamol" }, { name: "levotiroxina" }] })
    expect(merged.earlier).toEqual({})
  })

  it("«warfarina no perdón apixabán» cambia esa y deja las demás; «antes dijo» nombra solo la que salió", () => {
    const two = { declarante: "paciente", medications: { state: "recorded", items: [{ name: "losartán" }, { name: "warfarina" }] } }
    const merged = mergeHealth(two, { medications: { state: "recorded", items: [{ name: "apixabán" }] } }, "warfarina no perdon apixaban")
    expect(merged.payload["medications"]).toEqual({ state: "recorded", items: [{ name: "losartán" }, { name: "apixabán" }] })
    expect(merged.earlier).toEqual({ medications: "warfarina" })
  })

  it("«antes dijo» nunca nombra lo que sigue en la fila", () => {
    const rows = healthRows({ ...salbutamol, medications: { state: "recorded", items: [{ name: "levotiroxina" }, { name: "salbutamol" }] } }, { medications: "salbutamol" })
    expect(rows[0]?.before).toBeNull()
    expect(healthRows(salbutamol, { medications: "warfarina · salbutamol" })[0]?.before).toBe("warfarina")
  })
})

// QA del 23 nov (verificador 2): tras recargar, Alergias y Medicación citaban la misma frase unida.
describe("cada dato con su frase al sumar pausas", () => {
  it("lo que no cambió guarda su frase; la frase unida no repite la de otro dato", () => {
    const first = { declarante: "paciente", medications: { state: "recorded", items: [{ name: "losartán" }] } }
    const saidFirst = healthSaidOf(first, "tomo losartan para la presion")
    const second = { declarante: "paciente", medications: { state: "recorded", items: [{ name: "losartán" }] }, allergies: { state: "unknown", items: [] } }
    const merged = mergeHealth(first, second).payload
    const said = healthSaidOf(second, "tomo losartan para la presion no que yo sepa", saidFirst, { was: first, now: merged })
    expect(said).toEqual({ medications: "tomo losartan para la presion", allergies: "no que yo sepa" })
  })
})

describe("el repaso no vuelve a proponer lo de salud ya resuelto (mesa del 25 nov, H3)", () => {
  it("el mismo anticoagulante con otra dosis ya está decidido; otro, no", () => {
    const decided = [{ anticoagulants: { state: "recorded", detail: "apixaban cinco miligramos dos veces al dia" } }]
    expect(withoutSettledHealth({ anticoagulants: { state: "recorded", detail: "apixabán" } }, decided)).toBeNull()
    expect(withoutSettledHealth({ anticoagulants: { state: "recorded", detail: "aspirina" } }, decided)).toEqual({ anticoagulants: { state: "recorded", detail: "aspirina" } })
  })

  it("con la alergia ya nombrada, su «no que ella sepa» no vuelve; otra alergia nombrada, sí", () => {
    const fresh = { allergies: { state: "unknown", items: [] }, anticoagulants: { state: "recorded", detail: "apixabán" } }
    expect(withoutSettledHealth(fresh, [], true)).toEqual({ anticoagulants: { state: "recorded", detail: "apixabán" } })
    expect(withoutSettledHealth({ allergies: { state: "unknown", items: [] } }, [], true)).toBeNull()
    expect(withoutSettledHealth({ allergies: { state: "unknown", items: [] } }, [], false)).toEqual({ allergies: { state: "unknown", items: [] } })
  })
})

describe("revisión del 25 nov · la misma medicina, no la misma primera palabra", () => {
  it("«ácido fólico» registrado no quita «ácido alendrónico»; «Losartán 50 mg» sí quita «losartán de cincuenta»", () => {
    const onFile = [{ medications: { state: "recorded", items: [{ name: "Ácido fólico 5 mg" }, { name: "Losartán 50 mg" }] } }]
    const said = { medications: { state: "recorded", items: [{ name: "ácido fólico" }, { name: "ácido alendrónico" }, { name: "losartán de cincuenta" }] } }
    expect(withoutSettledHealth(said, onFile)).toEqual({ medications: { state: "recorded", items: [{ name: "ácido alendrónico" }] } })
  })

  it("«ya no toma el apixabán» no se quita por tener el apixabán registrado", () => {
    const onFile = [{ anticoagulants: { state: "recorded", detail: "apixabán" } }]
    const stopped = { anticoagulants: { state: "recorded", detail: "apixabán", now: false } }
    expect(withoutSettledHealth(stopped, onFile)).toEqual(stopped)
    expect(withoutSettledHealth({ anticoagulants: { state: "recorded", detail: "Eliquis" } }, onFile)).toBeNull()
  })
})

/*
 * Mesa del 25 nov («salud y familia», entrega 2): lo de su familia y lo que ya no toma tienen su
 * lugar, con su propia forma, separada de la del formulario público.
 */
describe("entrega 2 · su familia y lo que ya no toma", () => {
  const MEDICAL = productHooksFor("medical").dictation!.health

  it("C6 · «su hermana tuvo cáncer de boca» es de su familia, con el parentesco, nunca suyo", () => {
    const ready = prepareHealth(
      { declarante: "acompanante", vinculo: "hija", family: [{ relation: "hermana", name: "cáncer de boca" }] },
      "y su hermana tuvo cáncer de boca",
      DENTAL,
    )
    expect(ready?.payload["family"]).toEqual({ state: "recorded", items: [{ relation: "hermana", name: "cáncer de boca" }] })
    expect(ready?.payload["conditions"]).toBeUndefined()
    const rows = healthRows(ready!.payload)
    expect(rows).toEqual([expect.objectContaining({ group: "family", label: "Hermana", value: "cáncer de boca" })])
    // Se revisa con «Lo revisé con…», no espera en su fila; y no es una declaración de su salud.
    const { kept } = splitHealthDenials(ready!.payload)
    expect(kept["family"]).toBeDefined()
    expect(saidFamilyOf(kept)).toEqual([{ relationship: "SIB", relation: "hermana", condition: "cáncer de boca" }])
    expect(hasDeclaredHealth(kept)).toBe(false)
    expect(healthOfPayload(kept)).toEqual({})
  })

  it("el parentesco va con su código; «abuela», sin decir de qué lado, es otro familiar", () => {
    expect(familyKinshipOf("abuelo materno")).toBe("MGRPRN")
    expect(familyKinshipOf("su papá")).toBe("FTH")
    expect(familyKinshipOf("Madre")).toBe("MTH")
    expect(familyKinshipOf("abuela")).toBe("FAMMEMB")
    expect(familyKinshipOf("SIB")).toBe("SIB")
  })

  it("dos familiares con la misma enfermedad son dos filas, y la misma dicha otra vez no se repite", () => {
    const first = prepareHealth({ declarante: "paciente", family: [{ relation: "padre", name: "diabetes" }] }, "mi papá es diabético", DENTAL)!.payload
    const second = prepareHealth({ declarante: "paciente", family: [{ relation: "madre", name: "diabetes" }, { relation: "papá", name: "diabetes" }] }, "mi mamá también es diabética, como mi papá", DENTAL)!.payload
    const { payload } = mergeHealth(first, second)
    expect((payload["family"] as { items: unknown[] }).items).toHaveLength(2)
    // Lo ya anotado en Antecedentes no vuelve en el repaso.
    expect(withoutSettledHealth(payload, [{ family: { state: "recorded", items: [{ relation: "FTH", name: "Diabetes" }] } }])?.["family"]).toEqual({
      state: "recorded",
      items: [{ relation: "madre", name: "diabetes" }],
    })
  })

  it("C7 · «ya no toma apixabán, ahora aspirina»: lo que toma se revisa; lo que dejó espera su «Sí, lo dejó»", () => {
    const ready = prepareHealth(
      { declarante: "acompanante", vinculo: "hija", anticoagulants: { state: "recorded", detail: "aspirina 100 mg" }, stopped: [{ name: "apixabán" }] },
      "el cardiólogo le cambió el apixabán por aspirina cien",
      DENTAL,
    )!.payload
    const rows = healthRows(ready)
    const stopped = rows.find((row) => row.group === "stopped")
    expect(stopped).toEqual(expect.objectContaining({ label: "Ya no toma", value: "apixabán", stopped: true, denied: false }))
    const { kept, denied } = splitHealthDenials(ready)
    expect(kept["stopped"]).toBeUndefined()
    expect(denied["stopped"]).toBeDefined()
    expect(saidStoppedOf(denied)).toEqual([{ key: stopped!.key, name: "apixabán" }])
    // Confirmado lo que dejó, no queda nada de él.
    expect(withoutStopped(denied, stopped!.key)).toBeNull()
    expect(sameDrug("Apixabán 5 mg", "apixaban")).toBe(true)
  })

  it("una medicina que dejó y nadie nombró en la frase no se propone", () => {
    const { payload, notHeard } = groundHealthNames({ declarante: "paciente", stopped: { state: "recorded", items: [{ name: "warfarina" }] } }, "ya no tomo la pastilla de la presión")
    expect(payload).toBeNull()
    expect(notHeard).toEqual(["warfarina"])
  })

  it("C8 · latidIA: con el embarazo y la FUR, sus semanas salen de la FUR al día en que se dijo", () => {
    const ready = prepareHealth({ declarante: "paciente", personal: { embarazo: true }, gyneco: { fur: "2026-06-10" } }, "mi última regla fue el 10 de junio, es mi segundo embarazo", MEDICAL)!.payload
    expect(ready["gyneco"]).toEqual({ fur: "2026-06-10" })
    expect(healthRows(ready).find((row) => row.key === "gyneco.fur")?.value).toBe("10 jun 2026")
    expect(healthOfPayload(ready, "2026-11-25").personal).toEqual({ embarazo: true, semanasEmbarazo: 24 })
    // Sin el embarazo, la FUR sola no lo afirma.
    expect(healthOfPayload({ gyneco: { fur: "2026-06-10" } }, "2026-11-25")).toEqual({})
  })

  it("«tomo warfarina, perdón, apixabán»: la warfarina la nombró mal, no la dejó", () => {
    const payload = { declarante: "paciente", anticoagulants: { state: "recorded", detail: "apixabán" }, stopped: { state: "recorded", items: [{ name: "warfarina" }] } }
    expect(selfCorrectedHealth(payload, "tomo warfarina no perdón apixabán")).toEqual({ anticoagulants: "warfarina" })
    expect(withoutMisspokenStopped(payload, ["warfarina"])).toEqual({ declarante: "paciente", anticoagulants: { state: "recorded", detail: "apixabán" } })
    expect(withoutMisspokenStopped({ declarante: "paciente", stopped: payload.stopped }, ["warfarina"])).toBeNull()
  })

  it("lo último que dijo de una medicina vale: «ya no toma» después de «toma» la saca de lo que toma, y al revés", () => {
    const taking = prepareHealth({ declarante: "paciente", anticoagulants: { state: "recorded", detail: "apixabán" } }, "tomo apixabán", DENTAL)!.payload
    const stopped = prepareHealth({ declarante: "paciente", stopped: [{ name: "apixabán" }] }, "ya no tomo el apixabán", DENTAL)!.payload
    const after = mergeHealth(taking, stopped).payload
    expect(after["anticoagulants"]).toBeUndefined()
    expect(after["stopped"]).toEqual({ state: "recorded", items: [{ name: "apixabán" }] })
    const again = mergeHealth(after, taking).payload
    expect(again["stopped"]).toBeUndefined()
    expect(again["anticoagulants"]).toEqual({ state: "recorded", detail: "apixabán" })
    // En la misma pausa, lo que dijo que dejó no queda también como que lo toma.
    const both = prepareHealth({ declarante: "paciente", anticoagulants: { state: "recorded", detail: "apixabán" }, stopped: [{ name: "apixabán" }] }, "ya no tomo el apixabán", DENTAL)!.payload
    expect(both["anticoagulants"]).toBeUndefined()
    // Lo dicho otro día: «ya no toma apixabán» deja atrás el «toma apixabán» de antes.
    expect(withoutHealthKeys(taking, healthSupersedingKeysOf(stopped))).toBeNull()
  })

  it("un familiar sin su código es el de sus palabras; «sus padres» no es solo el padre", () => {
    const first = prepareHealth({ declarante: "paciente", family: [{ relation: "su abuela", name: "diabetes" }] }, "su abuela es diabética", DENTAL)!.payload
    const second = prepareHealth({ declarante: "paciente", family: [{ relation: "abuelo", name: "diabetes" }] }, "y su abuelo también es diabético", DENTAL)!.payload
    expect((mergeHealth(first, second).payload["family"] as { items: unknown[] }).items).toHaveLength(2)
    expect(familyKinshipOf("sus padres")).toBe("FAMMEMB")
    expect(familyKinshipOf("papás")).toBe("FAMMEMB")
    expect(familyRelationWords("Su abuela")).toBe("abuela")
  })

  it("el parentesco lo cuenta el sistema desde el paciente: «su papá» es su padre; «mi papá», dicho por la madre, su abuelo materno", () => {
    const mom = (family: unknown[], said: string) => prepareHealth({ declarante: "acompanante", vinculo: "madre", family }, said, DENTAL)!.payload["family"]
    expect(mom([{ relation: "papá", of: "paciente", name: "alergia a la penicilina" }], "su papá es alérgico a la penicilina")).toEqual({
      state: "recorded",
      items: [{ relation: "papá", name: "alergia a la penicilina" }],
    })
    expect(mom([{ relation: "papá", of: "quien_habla", name: "diabetes" }], "mi papá es diabético")).toEqual({ state: "recorded", items: [{ relation: "abuelo materno", name: "diabetes" }] })
    expect(mom([{ relation: "hermana", of: "quien_habla", name: "asma" }], "mi hermana tiene asma")).toEqual({ state: "recorded", items: [{ relation: "tía materna", name: "asma" }] })
    // «Mi hermana», dicho por la hija de Elena, es la hija de Elena.
    const daughter = prepareHealth({ declarante: "acompanante", vinculo: "hija", family: [{ relation: "hermana", of: "quien_habla", name: "lupus" }] }, "mi hermana tiene lupus", DENTAL)!.payload
    expect(daughter["family"]).toEqual({ state: "recorded", items: [{ relation: "hija", name: "lupus" }] })
    expect(familyKinshipOf("tía materna")).toBe("AUNT")
    expect(familyKinshipOf("hija")).toBe("CHILD")
  })

  it("si habla el propio paciente, «quien habla» es el paciente: «mi mamá» es su mamá (revisión de código del 26 nov)", () => {
    const own = prepareHealth({ declarante: "paciente", family: [{ relation: "mamá", of: "quien_habla", name: "diabetes" }] }, "mi mamá es diabética", DENTAL)!.payload
    expect(own["family"]).toEqual({ state: "recorded", items: [{ relation: "mamá", name: "diabetes" }] })
    // Sin saber quién habla, no se supone: queda con sus palabras.
    const unknown = prepareHealth({ declarante: "no_se_sabe", family: [{ relation: "mamá", of: "quien_habla", name: "diabetes" }] }, "mi mamá es diabética", DENTAL)!.payload
    expect(unknown["family"]).toEqual({ state: "recorded", items: [{ relation: "mamá de quien lo acompaña", name: "diabetes" }] })
  })

  it("lo que quien acompaña dice de sí misma no es del paciente, ni en el repaso; su familia sí", () => {
    const ready = prepareHealth(
      { declarante: "acompanante", vinculo: "madre", conditions: { state: "recorded", items: [{ name: "diabetes" }] } },
      "yo soy diabética, eso es mío",
      DENTAL,
    )
    // No es del paciente: es lo de su familia, con el vínculo de quien habla (QA del 26 nov).
    expect(ready?.payload["conditions"]).toBeUndefined()
    expect(ready?.payload["family"]).toEqual({ state: "recorded", items: [{ relation: "madre", name: "diabetes" }] })
    // Lo que cuenta del niño sí lo es.
    expect(prepareHealth({ declarante: "acompanante", vinculo: "madre", conditions: { state: "recorded", items: [{ name: "asma" }] } }, "él tiene asma", DENTAL)).not.toBeNull()
  })

  it("la aspirina dicha se lee «Antiagregante», como la franja", () => {
    const rows = healthRows({ declarante: "paciente", anticoagulants: { state: "recorded", detail: "aspirina 100 mg" } })
    expect(rows[0]?.label).toBe("Antiagregante")
  })
})

describe("la dosis dicha en palabras va a su lugar (revisión del 25 nov, H10)", () => {
  it("el anticoagulante y la medicina de Julio", () => {
    const said = "tomo apixaban de cinco miligramos cada doce horas y losartan cincuenta"
    const { payload } = groundHealthNames(
      {
        anticoagulants: { state: "recorded", detail: "apixabán de cinco miligramos cada doce horas" },
        medications: { state: "recorded", items: [{ name: "losartán cincuenta" }] },
      },
      said,
    )
    expect(payload?.["anticoagulants"]).toEqual({ state: "recorded", detail: "apixabán 5 mg cada 12 h" })
    // Sin unidad dicha no se parte: la unidad no se inventa.
    expect(payload?.["medications"]).toEqual({ state: "recorded", items: [{ name: "losartán cincuenta" }] })
  })

  it("al guardarlo, el nombre queda solo y la dosis y cuándo en sus campos", () => {
    const rows = declaredMedications({ anticoagulants: { state: "recorded", detail: "apixabán 5 mg cada 12 h" } } as never)
    // Cada cuánto, como se dijo, con su código de la lista al lado (QA del 26 nov).
    expect(rows[0]).toMatchObject({ name: "apixabán", dose: "5 mg", frequency: "cada 12 h", frequencyCode: "cada_12_h", declaredClass: "anticoagulants" })
  })
})

describe("quitar por voz lo de su salud, dato por dato (revisión de código del 26 nov)", () => {
  const payload = { declarante: "paciente", conditions: { state: "recorded", items: [{ name: "diabetes" }, { name: "asma" }] } }
  it("«no, la diabetes no» quita la diabetes y deja el asma", () => {
    const named = healthNamed(payload, "no, la diabetes no")
    expect(named.names).toEqual(["diabetes"])
    expect(withoutHealthKeys(payload, named.keys)?.["conditions"]).toEqual({ state: "recorded", items: [{ name: "asma" }] })
  })
  it("un nombre sin palabras que lo distingan no se da por nombrado", () => {
    expect(healthNamed({ declarante: "paciente", medications: { state: "recorded", items: [{ name: "T4" }] } }, "quita eso").keys.size).toBe(0)
  })
})

describe("lo que quien habla dice de sí misma no es quitar (revisión de código del 26 nov)", () => {
  it.each(["lo del azúcar no, eso es mío", "eso lo tengo yo, no la niña", "no, la que tiene eso soy yo"])("«%s»", (said) => {
    expect(speaksOfSelf(said)).toBe(true)
  })
  it.each(["quita eso", "eso no va", "no, eso no"])("«%s» sí es quitar", (said) => {
    expect(speaksOfSelf(said)).toBe(false)
  })
})

describe("la dosis de su clase, leída de la frase (QA del 26 nov)", () => {
  it("Clío pone «apixabán» solo: la dosis y cuándo salen de lo dicho", () => {
    const { payload } = groundHealthNames(
      { anticoagulants: { state: "recorded", detail: "Apixabán" } },
      "doctora tomo apixabán de cinco miligramos cada doce horas y losartán cincuenta",
    )
    expect(payload?.["anticoagulants"]).toEqual({ state: "recorded", detail: "Apixabán 5 mg cada 12 h" })
  })
})

describe("lo que falta de la dosis se lee de la frase, cada cosa por su lado (QA del 26 nov)", () => {
  it("Clío trae «apixabán 5 mg» sin cuándo: «cada doce horas» sale de lo dicho", () => {
    const { payload } = groundHealthNames({ anticoagulants: { state: "recorded", detail: "apixabán 5 mg" } }, "tomo apixabán de cinco miligramos cada doce horas")
    expect(payload?.["anticoagulants"]).toEqual({ state: "recorded", detail: "apixabán 5 mg cada 12 h" })
  })
})

/*
 * QA clínica del 26 nov («lo que quedó fuera»): lo de su salud que el sistema decidía o perdía, ahora
 * como propuesta que el profesional confirma.
 */
describe("«su papá es asmático»: la enfermedad dicha de quien la tiene (QA del 26 nov, O2)", () => {
  it("se propone «Papá: asma» y no queda en «No encontré «asma»»", () => {
    const { payload, notHeard } = groundHealthNames({ family: [{ relation: "papá", of: "paciente", name: "asma" }] }, "su papá es asmático y tiene diabetes desde joven")
    expect(notHeard).toEqual([])
    expect(payload?.["family"]).toEqual({ state: "recorded", items: [{ relation: "papá", of: "paciente", name: "asma" }] })
  })
  it.each([
    ["es hipertensa", "hipertensión"],
    ["es epiléptico", "epilepsia"],
    ["es diabética", "diabetes"],
  ])("«%s» se oyó como %s", (said, name) => {
    expect(groundHealthNames({ conditions: { state: "recorded", items: [{ name }] } }, said).notHeard).toEqual([])
  })
  it("lo que no se dijo sigue sin proponerse", () => {
    expect(groundHealthNames({ conditions: { state: "recorded", items: [{ name: "asma" }] } }, "tiene diabetes").notHeard).toEqual(["asma"])
  })
})

describe("lo que quien acompaña dice de sí, como lo de la familia del paciente (QA del 26 nov, O2)", () => {
  it("«yo también soy diabética», dicho por la madre: «Madre: diabetes»", () => {
    expect(selfConditionsOf("yo también soy diabética, eso es mío, no de él")).toEqual(["diabetes"])
    expect(selfConditionsOf("yo tengo asma")).toEqual(["asma"])
    expect(selfConditionsOf("él es asmático")).toEqual([])
    // Lo que niega de sí no propone nada (revisión de código del 26 nov).
    expect(selfConditionsOf("yo no soy diabética")).toEqual([])
    expect(selfConditionsOf("yo no tengo asma")).toEqual([])
    expect(selfConditionsOf("yo tampoco soy diabética")).toEqual([])
    expect(selfConditionsOf("yo nunca he tenido asma, pero sí tengo diabetes")).toEqual(["diabetes"])
    const ready = prepareHealth(
      { declarante: "acompanante", vinculo: "madre", conditions: { state: "recorded", items: [{ name: "diabetes" }] } },
      "yo también soy diabética, eso es mío",
      {},
    )
    expect(ready?.payload["conditions"]).toBeUndefined()
    expect(saidFamilyOf(ready?.payload ?? {})).toEqual([{ relationship: "MTH", relation: "madre", condition: "diabetes" }])
  })
  it("sin saber quién habla, o si es su pareja, no se propone: el parentesco no se inventa", () => {
    const said = "yo soy diabética, eso es mío"
    expect(prepareHealth({ declarante: "acompanante", conditions: { state: "recorded", items: [{ name: "diabetes" }] } }, said, {})).toBeNull()
    expect(prepareHealth({ declarante: "acompanante", vinculo: "esposa", conditions: { state: "recorded", items: [{ name: "diabetes" }] } }, said, {})).toBeNull()
    expect(companionFamily(["diabetes"], "")).toEqual([])
    expect(companionFamily(["diabetes"], "abuela")).toEqual([{ relation: "abuela", name: "diabetes" }])
  })
  it("sus propias medicinas no se proponen al paciente: su motivo va a «No lo usé» (revisión del 26 nov)", () => {
    const payload = { declarante: "acompanante", vinculo: "madre", medications: { state: "recorded", items: [{ name: "metformina" }] } }
    expect(prepareHealth(payload, "yo tomo metformina, eso es mío", {})).toBeNull()
    expect(companionOwnMedicinesWhy(payload, "yo tomo metformina, eso es mío")).toBe(
      "«metformina» lo dijo su madre de sí: no es del paciente y no lo propuse. Si es suyo, anótalo a mano.",
    )
    // Sin vínculo, quien lo acompaña; dicho del paciente, o por el paciente, nada.
    expect(companionOwnMedicinesWhy({ ...payload, vinculo: undefined }, "yo tomo metformina")).toContain("lo dijo quien lo acompaña de sí")
    expect(companionOwnMedicinesWhy(payload, "él toma metformina")).toBeNull()
    expect(companionOwnMedicinesWhy({ ...payload, declarante: "paciente" }, "yo tomo metformina")).toBeNull()
  })
  it("«la diabetes no, eso es mío» pasa la diabetes propuesta a lo de su familia", () => {
    const payload = { declarante: "acompanante", vinculo: "madre", conditions: { state: "recorded", items: [{ name: "diabetes" }, { name: "asma" }] } }
    const named = healthNamed(payload, "la diabetes no, eso es mío")
    const moved = withConditionsToFamily(payload, named.keys, companionKinOf(payload))
    expect(moved?.["conditions"]).toEqual({ state: "recorded", items: [{ name: "asma" }] })
    expect(saidFamilyOf(moved ?? {})).toEqual([{ relationship: "MTH", relation: "madre", condition: "diabetes" }])
    expect(withConditionsToFamily({ ...payload, declarante: "no_se_sabe", vinculo: undefined }, named.keys, companionKinOf({ declarante: "no_se_sabe" }))).toBeNull()
  })
})

describe("«para la presión»: queda lo dicho y se sugiere la del catálogo (QA del 26 nov, O1)", () => {
  const payload = { declarante: "paciente", conditions: { state: "recorded", items: [{ name: "presión" }, { name: "diabetes" }] } }
  it("la fila dice «presión» y sugiere hipertensión arterial, sin cambiarla", () => {
    const [row] = healthRows(payload)
    expect(row?.value).toBe("presión · diabetes")
    expect(row?.suggested).toEqual([{ said: "presión", name: "Hipertensión arterial" }])
    expect(payload.conditions.items[0]?.name).toBe("presión")
  })
  it("«quita la presión» la quita (en el PR 715 un renombre por texto lo rompía)", () => {
    const named = healthNamed(payload, "quita la presión")
    expect(named.names).toEqual(["presión"])
    expect(withoutHealthKeys(payload, named.keys)?.["conditions"]).toEqual({ state: "recorded", items: [{ name: "diabetes" }] })
  })
  it("lo ya guardado como «presión» o como «Hipertensión arterial» no se propone otra vez", () => {
    const said = { conditions: { state: "recorded", items: [{ name: "presión" }] } }
    expect(withoutSettledHealth(said, [{ conditions: { state: "recorded", items: [{ name: "Presión" }] } }])).toBeNull()
    expect(withoutSettledHealth(said, [{ conditions: { state: "recorded", items: [{ name: "Hipertensión arterial" }] } }])).toBeNull()
    expect(withoutSettledHealth(said, [{ conditions: { state: "recorded", items: [{ name: "asma" }] } }])).toEqual(said)
  })
})

describe("«no, la diabetes no» lo lee el servidor, sin esperar a Clío (QA del 26 nov, C3)", () => {
  const payload = { declarante: "paciente", conditions: { state: "recorded", items: [{ name: "diabetes" }, { name: "asma" }] } }
  it.each(["no, la diabetes no", "la diabetes no, me equivoqué", "No es diabetes, doctora.", "no tiene diabetes", "Lo de la diabetes no."])("«%s» niega la diabetes", (said) => {
    const negated = healthNegated(payload, said)
    expect(negated.names).toEqual(["diabetes"])
    expect(withoutHealthKeys(payload, negated.keys)?.["conditions"]).toEqual({ state: "recorded", items: [{ name: "asma" }] })
  })
  it.each(["¿Es diabético? No.", "es diabético no", "tiene diabetes, no toma nada", "no sé si es diabetes", "no toma nada para la diabetes", "tiene diabetes y asma"])(
    "«%s» no niega nada de lo propuesto",
    (said) => {
      expect(healthNegated(payload, said).keys.size).toBe(0)
    },
  )

  // Revisión de código del 26 nov: la lectura es estricta; en la duda, no se propone quitar.
  const wide = {
    declarante: "acompanante",
    vinculo: "madre",
    conditions: { state: "recorded", items: [{ name: "Hipertensión arterial" }, { name: "Insuficiencia renal" }, { name: "diabetes" }] },
    family: { state: "recorded", items: [{ relation: "Padre", name: "diabetes" }] },
  }
  it.each([
    "No tiene hipertiroidismo.",
    "No tiene insuficiencia cardiaca.",
    "No, tiene diabetes.",
    "No, es diabético.",
    "La diabetes no la tiene controlada.",
    "La hipertensión no es grave.",
    "No tiene hipertensión pulmonar.",
  ])("«%s» no propone quitar nada", (said) => {
    expect(healthNegated(wide, said).names).toEqual([])
  })
  it("«El niño no tiene diabetes, su papá sí.» no quita la diabetes del niño ni la de su papá", () => {
    expect(healthNegated(wide, "El niño no tiene diabetes, su papá sí.").names).toEqual([])
  })
  it("cada «no» quita solo lo de quien se habla: el paciente o el familiar que nombra", () => {
    expect(healthNegated(wide, "El niño no tiene diabetes.").names).toEqual(["diabetes"])
    expect(healthNegated(wide, "Su papá no tiene diabetes.").names).toEqual(["Padre: diabetes"])
    expect(healthNegated(wide, "Su mamá no tiene diabetes.").names).toEqual([])
  })
  it("el nombre entero o su palabra distintiva sí lo niegan", () => {
    expect(healthNegated(wide, "No tiene hipertensión.").names).toEqual(["Hipertensión arterial"])
    expect(healthNegated(wide, "No tiene insuficiencia renal.").names).toEqual(["Insuficiencia renal"])
    expect(healthNegated(wide, "No, la insuficiencia renal no.").names).toEqual(["Insuficiencia renal"])
  })
})
