/**
 * Lo que lee el modelo en odentIA no cambia al separar lo común de lo dental
 * (ADR 0079, entrega 6): cada prompt armado para una clínica dental se compara,
 * carácter por carácter, con el de antes de separarlos (`__golden__`). Si una
 * diferencia es a propósito, se mide el agente antes de aceptar la nueva.
 */
import type { AgentConfig, OrgLocale } from "@odentia/services"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { agentTextsFor, argosCatalogText, argosFiguresText, compileArgosFigure } from "@odentia/services"
import { dictationFindingsText } from "@odentia/services/dental"
import { argosRouteQuestion, argosRules, argosSchemas, figureWords } from "./argos"
import { knowledgeQuestion } from "./decision/knowledge"
import { triageQuestions } from "./decision/points"
import { extraction, systemPrompt } from "./dental/dictation"
import { receptionPrompt } from "./graph"
import { type AgentToolCtx, makeAgentTools } from "./tools"

const golden = (name: string) => `./__golden__/${name}`
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

const DENTAL = agentTextsFor("dental")
const zone: OrgLocale = { countryCode: "PE", currency: "PEN", timezone: "America/Lima", locale: "es-PE" }
const config = {
  personaName: "Sofi",
  treatment: "tu",
  tone: "cercano",
  emojis: "pocos",
  about: "Clínica de prueba en Miraflores.",
  disabledFunctions: [],
  functionNotes: {},
} as unknown as AgentConfig

describe("prompts de odentIA, iguales a los de antes", () => {
  it("Sofi", async () => {
    const all = new Set(makeAgentTools({ texts: DENTAL } as AgentToolCtx).map((tool) => tool.name))
    await expect(receptionPrompt(zone, config, { tools: all, services: "lista" }, DENTAL)).toMatchFileSnapshot(golden("sofi-lista.txt"))
    await expect(receptionPrompt(zone, config, { tools: all, services: "indice" }, DENTAL)).toMatchFileSnapshot(golden("sofi-indice.txt"))
    const quiet = { ...config, treatment: "usted", tone: "formal", emojis: "no", disabledFunctions: ["agendar", "informar"] } as AgentConfig
    await expect(receptionPrompt(zone, quiet, { tools: new Set(["consultar_conocimiento"]), services: "ninguno" }, DENTAL)).toMatchFileSnapshot(
      golden("sofi-apagada.txt"),
    )
  })

  it("las herramientas de Sofi", async () => {
    const tools = makeAgentTools({ texts: DENTAL } as AgentToolCtx).map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: z.toJSONSchema(tool.schema as z.ZodType),
    }))
    await expect(json(tools)).toMatchFileSnapshot(golden("herramientas.json"))
  })

  it("las preguntas de decisión", async () => {
    await expect(json(triageQuestions(DENTAL))).toMatchFileSnapshot(golden("triage.json"))
    const candidates = [
      { id: "a", title: "¿Atienden urgencias?", askForms: ["¿Atienden de emergencia?"] },
      { id: "b", title: "Formas de pago", askForms: [] },
    ]
    await expect(json(knowledgeQuestion(candidates as never, DENTAL))).toMatchFileSnapshot(golden("conocimiento.json"))
  })

  it("Argos", async () => {
    await expect(argosRules(DENTAL)).toMatchFileSnapshot(golden("argos-reglas.txt"))
    await expect(json(argosRouteQuestion(DENTAL))).toMatchFileSnapshot(golden("argos-ruta.json"))
    const { figureAskSchema, calcularSchema, buscarSchema, planSchema } = argosSchemas(DENTAL)
    const schemas = [figureAskSchema, calcularSchema, buscarSchema, planSchema].map((schema) => z.toJSONSchema(schema))
    await expect(json(schemas)).toMatchFileSnapshot(golden("argos-esquemas.json"))
  })

  it("el catálogo y las cifras de Argos", async () => {
    for (const key of ["gestion", "recepcion", "clinico", "caja"] as const) {
      await expect(argosCatalogText(key, DENTAL)).toMatchFileSnapshot(golden(`argos-catalogo-${key}.txt`))
      await expect(argosFiguresText(key, figureWords(DENTAL))).toMatchFileSnapshot(golden(`argos-cifras-${key}.txt`))
    }
    const compiled = ["sin_venir", "reactivados"].map((cifra) => {
      const out = compileArgosFigure({ cifra }, { key: "gestion", compare: false, names: null, words: figureWords(DENTAL) })
      return "problem" in out ? out : { sql: out.sql, name: out.figure.name, describes: out.figure.describes, how: out.how }
    })
    await expect(json(compiled)).toMatchFileSnapshot(golden("argos-cifras-sin-venir.json"))
  })

  it("Clío", async () => {
    await expect(systemPrompt({ services: ["Resina compuesta", "Endodoncia"], diagnosisList: "CIE-10", catalog: dictationFindingsText() })).toMatchFileSnapshot(
      golden("clio.txt"),
    )
    await expect(json(z.toJSONSchema(extraction))).toMatchFileSnapshot(golden("clio-esquema.json"))
  })
})

describe("latidIA: lo que lee el modelo, sin nada dental ni de odentIA", () => {
  const DENTAL_WORDS = /\b(dental|dientes?|boca|odont\w*|tomograf\w*|ortodon\w*|frenillos?|piezas?|teeth|mouth|exodoncia|endodoncia)\b/i
  const MEDICAL = agentTextsFor("medical")
  const tools = makeAgentTools({ texts: MEDICAL } as AgentToolCtx)
  const latidia = (name: string) => golden(`latidia/${name}`)

  it("Sofi, sus herramientas, las preguntas de decisión y Argos", () => {
    const read = [
      receptionPrompt(zone, config, { tools: new Set(tools.map((tool) => tool.name)), services: "lista" }, MEDICAL),
      ...tools.map((tool) => `${tool.description}\n${JSON.stringify(z.toJSONSchema(tool.schema as z.ZodType))}`),
      JSON.stringify(triageQuestions(MEDICAL)),
      JSON.stringify(knowledgeQuestion([], MEDICAL)),
      argosRules(MEDICAL),
      JSON.stringify(argosRouteQuestion(MEDICAL)),
      JSON.stringify(Object.values(argosSchemas(MEDICAL)).map((schema) => z.toJSONSchema(schema))),
      ...(["gestion", "recepcion", "clinico", "caja"] as const).flatMap((key) => [
        argosCatalogText(key, MEDICAL),
        argosFiguresText(key, figureWords(MEDICAL)),
      ]),
    ]
    for (const text of read) {
      expect(text).not.toMatch(DENTAL_WORDS)
      expect(text).not.toContain("odentIA")
      // «Sin venir» y «reactivados» son de 12 meses en latidIA (decisión 16).
      expect(text).not.toMatch(/\b6 (meses|months)\b/)
    }
  })

  it("lo que lee, como queda (se mide antes de abrir consultorios)", async () => {
    await expect(receptionPrompt(zone, config, { tools: new Set(tools.map((tool) => tool.name)), services: "lista" }, MEDICAL)).toMatchFileSnapshot(
      latidia("sofi-lista.txt"),
    )
    await expect(argosRules(MEDICAL)).toMatchFileSnapshot(latidia("argos-reglas.txt"))
    await expect(argosCatalogText("gestion", MEDICAL)).toMatchFileSnapshot(latidia("argos-catalogo-gestion.txt"))
    await expect(argosFiguresText("gestion", figureWords(MEDICAL))).toMatchFileSnapshot(latidia("argos-cifras-gestion.txt"))
    const sinVenir = compileArgosFigure({ cifra: "sin_venir" }, { key: "gestion", compare: false, names: null, words: figureWords(MEDICAL) })
    expect("problem" in sinVenir ? sinVenir.problem : sinVenir.sql).toContain("interval '12 months'")
  })
})
