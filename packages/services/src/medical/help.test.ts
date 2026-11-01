import { describe, expect, it } from "vitest"
import { HELP_TOPICS, helpTopicForScreen, matchHelpTopics } from "../help-guide.js"
import { MEDICAL_HELP_TOPICS } from "./help.js"

/** La Ayuda de latidIA (issue 229): las mismas pantallas, con lo que tiene un consultorio. */
describe("la guía de latidIA", () => {
  const text = JSON.stringify(MEDICAL_HELP_TOPICS)

  it("no habla de lo que un consultorio no tiene", () => {
    for (const word of [
      /odontograma/i,
      /odontólog/i,
      /odentIA/i,
      /\bpiezas?\b/i,
      /sillones/i,
      /unidad dental/i,
      /odontolog/i,
      /ortodoncia|endodoncia/i,
      /caries/i,
    ]) {
      expect(text).not.toMatch(word)
    }
  })

  it("lleva las mismas pantallas y responde lo suyo", () => {
    expect(MEDICAL_HELP_TOPICS.map((topic) => topic.id)).toEqual(
      HELP_TOPICS.map((topic) => topic.id),
    )
    expect(helpTopicForScreen("/patients/123", MEDICAL_HELP_TOPICS)?.id).toBe("pacientes")
    const [vitals] = matchHelpTopics("¿Dónde registro los signos vitales?", MEDICAL_HELP_TOPICS)
    expect(vitals?.faq?.a).toContain("Examen físico")
    const [leave] = matchHelpTopics("¿Cómo emito un descanso médico?", MEDICAL_HELP_TOPICS)
    expect(leave?.faq?.q).toBe("¿Cómo emito un descanso médico?")
    expect(matchHelpTopics("¿Quién es Ariadna?", MEDICAL_HELP_TOPICS)[0]?.faq?.a).toContain("guía virtual de latidIA")
  })

  it("la de odentIA no cambia", () => {
    expect(JSON.stringify(HELP_TOPICS)).toMatch(/odontograma/)
    expect(helpTopicForScreen("/patients/123")?.id).toBe("pacientes")
  })
})
