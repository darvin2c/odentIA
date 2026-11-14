import { describe, expect, it } from "vitest"
import { HELP_TOPICS, helpTopicForScreen, matchHelpTopics } from "../help-guide.js"
import { describeHelpSearch } from "../help-guide-suite.js"
import { MEDICAL_HELP_TOPICS } from "./help.js"

/** La Ayuda de latidIA (issue 229): las mismas pantallas, con lo que tiene un consultorio. */
describe("la guía de latidIA", () => {
  // El nombre fijo de cada respuesta no lo lee nadie en la app: se hereda igual en todos los productos.
  const text = JSON.stringify(MEDICAL_HELP_TOPICS, (key, value) => (key === "id" ? undefined : value))

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

  const faqOf = (id: string) => MEDICAL_HELP_TOPICS.flatMap((topic) => topic.faqs ?? []).find((faq) => faq.id === id)
  const answerOf = (id: string) => faqOf(id)?.a ?? ""

  // Auditoría del 10 nov: lo que la guía decía y en un consultorio no es así.
  it("el presupuesto es opcional: no se arma solo al firmar", () => {
    expect(text).not.toMatch(/queda armado al firmarla|Enviárselo ahora/)
    expect(answerOf("arma-envia-presupuesto")).toMatch(/^No hace falta: /)
    expect(answerOf("arma-envia-presupuesto")).toContain("«Preparar presupuesto»")
  })

  it("lo indicado queda aceptado: «Qué sigue» dice «lo indicado»", () => {
    expect(text).not.toMatch(/Reservar lo aceptado|algo aceptado sin una cita|la cita de lo aceptado/)
    expect(answerOf("alergias-toca-ultima-atencion")).toContain("«Reservar lo indicado»")
    expect(answerOf("son-agendar-deben-demas-atajos")).toContain("quien tiene algo indicado sin una cita")
    expect(faqOf("pacientes-falta-cita-de-lo-indicado")?.area).toBe("plan")
  })

  it("el embudo de Reportes no tiene pasos de presupuesto", () => {
    expect(answerOf("caen-pacientes")).not.toMatch(/recibieron presupuesto|lo aceptaron/)
    expect(answerOf("caen-pacientes")).toContain("vinieron (una cita atendida o una atención firmada) y, además, pagaron algo")
  })

  it("no habla de fases, caminos, coronas ni del sillón", () => {
    for (const word of [
      /por fases|otra fase/,
      /eligió camino|los caminos|con caminos|elegir el camino|dos caminos/,
      /\bcoronas?\b/i,
      /sillón|sillon/i,
      /sala o unidad/,
      /periodoncia/i,
      /de mantenimiento|la limpieza o el control/,
      /control radiográfico/,
    ]) {
      expect(text).not.toMatch(word)
    }
  })

  it("la ASA solo se muestra si alguien la clasificó", () => {
    expect(answerOf("alergias-toca-ultima-atencion")).not.toMatch(/medicación y ASA/)
    expect(answerOf("alergias-toca-ultima-atencion")).toContain("solo si alguien la clasificó")
  })

  it("los filtros de Documentos son los de la pantalla, con los descansos médicos", () => {
    const answer = answerOf("quedaron-atenciones-recetas-u-ordenes")
    expect(answer).toContain("Antecedentes, Signos vitales, Historia y Documentos")
    expect(answer).toContain("(presupuestos, recetas, descansos médicos, órdenes, consentimientos, fichas, imágenes y otros archivos)")
  })

  it("el descanso está donde latidIA lo emite y la base no lo nombra", () => {
    // odentIA no emite descansos médicos (`medicalLeave: false`).
    expect(JSON.stringify(HELP_TOPICS)).not.toMatch(/descanso/i)
    expect(answerOf("puede-cambiar-receta-emitida-comprueba-qr")).toMatch(/^Receta, orden y descanso quedan guardados/)
    expect(answerOf("ve-paciente-portal")).toContain("y descansos desde que se emiten")
    expect(answerOf("poner-color-clinica")).toContain("las recetas, órdenes, descansos y consentimientos")
    expect(answerOf("emito-descanso-medico")).toContain("«Indicaciones (opcional)»")
  })

  it("tiene las preguntas que solo se hacen en un consultorio", () => {
    for (const id of [
      "registro-signos-vitales-examen-fisico",
      "emito-descanso-medico",
      "pacientes-falta-cita-de-lo-indicado",
      "pacientes-embarazo-habitos-vacunas",
      "pacientes-lista-de-problemas",
      "pacientes-examen-marcar-resto",
      "pacientes-signos-vitales-cuales",
      "pacientes-signos-vitales-en-el-tiempo",
      "pacientes-receta-avisos",
      "pacientes-dictado-que-decir",
      "pacientes-tomografia-subir-descargar",
      "pacientes-recepcion-sube-tomografia",
      "especialidades-trae-latidia",
      "formularios-consentimientos-latidia",
    ]) {
      expect(faqOf(id), id).toBeDefined()
    }
    expect(answerOf("pacientes-control-indicar-completar-cancelar")).toContain("cada 1, 3, 6 o 12 meses")
    expect(answerOf("pacientes-receta-avisos")).toContain("receta oficial")
    // Cada nombre fijo, una sola vez en la guía, y ninguna marcada solo de odentIA.
    const faqs = MEDICAL_HELP_TOPICS.flatMap((topic) => topic.faqs ?? [])
    const ids = faqs.map((faq) => faq.id)
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([])
    expect(faqs.filter((faq) => faq.own)).toEqual([])
  })
})

describeHelpSearch("latidIA", MEDICAL_HELP_TOPICS)
