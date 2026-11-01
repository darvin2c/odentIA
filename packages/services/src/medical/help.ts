import { HELP_TOPICS, type HelpFaq, type HelpTopic } from "../help-guide.js"

/*
 * ---------- La guía de la Ayuda en latidIA (issue 229, entrega 11) ----------
 *
 * La misma guía de odentIA: las mismas pantallas con las palabras del
 * consultorio y, donde odentIA habla del odontograma o de la pieza, lo que
 * tiene un consultorio (los signos vitales, el examen físico y el descanso
 * médico). Lo que no existe en latidIA no se cuenta.
 */

/** Las palabras que cambian en toda la guía. */
const WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/odentIA/g, "latidIA"],
  [/odentia/g, "latidia"],
  [/odontólogos/g, "médicos"],
  [/odontólogo/g, "médico"],
  [/unidades dentales/g, "salas"],
  [/unidad dental/g, "sala"],
]

const say = (text: string) =>
  WORDS.reduce((out, [word, replacement]) => out.replace(word, replacement), text)

type Faq = HelpFaq

/** Lo que en un consultorio es otra cosa, por tema: sus palabras de búsqueda y sus preguntas. */
const EDITS: Record<string, (topic: HelpTopic) => HelpTopic> = {
  pacientes: (topic) => ({
    ...topic,
    terms: [
      ...topic.terms.filter((term) => term !== "odontograma"),
      "signos vitales",
      "examen físico",
      "descanso médico",
    ],
    faqs: (topic.faqs ?? []).flatMap((faq): Faq[] => {
      if (/hallazgo del odontograma|pieza quedó dibujada|se firma el odontograma/.test(faq.q))
        return []
      if (faq.q === "¿Dónde quedaron los contactos?")
        return [
          {
            ...faq,
            a: faq.a.replace(
              "Caja y odontología solo ven a los pacientes.",
              "Caja y los médicos solo ven a los pacientes.",
            ),
          },
        ]
      if (faq.q === "¿Dónde quedaron Atenciones, Recetas u Órdenes?") {
        return [
          {
            q: faq.q,
            a: "Clínica tiene cuatro secciones: Antecedentes, Signos vitales, Historia y Documentos. Historia es lo que pasó y cuándo, con las atenciones (también las anuladas, con su motivo) y lo que se firmó o se pidió. Documentos es para buscar un papel: una sola lista con «Requieren acción» y un filtro por tipo (recetas, descansos médicos, órdenes, consentimientos, formularios e imágenes); «Nuevo» abre directo el formulario.",
          },
          {
            q: "¿Dónde registro los signos vitales y el examen físico?",
            a: "Dentro de la atención, en su bloque «Examen físico»: los signos vitales (el IMC sale solo del peso y la talla) y cada sistema «Sin alteraciones» o «Con hallazgos», con lo que encontraste y la parte del cuerpo. Lo que no marcas queda «No examinado», nunca normal. En su página, Clínica › Signos vitales los muestra en el tiempo.",
          },
          {
            q: "¿Cómo emito un descanso médico?",
            a: "En la atención, en su bloque «Documentos», con «Nuevo» › «Descanso médico»: desde qué día y cuántos, y el diagnóstico solo si la persona lo autoriza. Queda firmado con tu perfil profesional y numerado; no se corrige, se anula con motivo.",
          },
        ]
      }
      if (faq.q.startsWith("¿Dónde hago la receta, el consentimiento o la orden")) {
        return [
          {
            ...faq,
            a: faq.a
              .replace(
                "receta, consentimiento, orden, formulario o imagen",
                "receta, descanso médico, consentimiento, orden, formulario o imagen",
              )
              .replace(
                "(pieza, diagnóstico, procedimiento y quien atiende)",
                "(diagnóstico, procedimiento y quien atiende)",
              ),
          },
        ]
      }
      return [faq]
    }),
  }),
  servicios: (topic) => ({
    ...topic,
    terms: topic.terms.filter((term) => term !== "deja en la pieza"),
    faqs: (topic.faqs ?? []).filter((faq) => !faq.q.includes("Deja en la pieza")),
  }),
  organizacion: (topic) => ({
    ...topic,
    faqs: (topic.faqs ?? []).map((faq) =>
      faq.q === "¿Cómo elijo el diagnóstico de una atención?"
        ? {
            q: faq.q,
            a: "Con los más usados en tu clínica o con el buscador de toda la lista, que no distingue tildes ni mayúsculas y muestra primero los de la atención primaria. La parte del cuerpo se escribe en la nota del diagnóstico. «Presuntivo» basta para cerrar. Si la persona ya tenía ese diagnóstico, el sistema lo anota solo como «Ya diagnosticado antes».",
          }
        : faq,
    ),
  }),
  disponibilidad: (topic) => ({
    ...topic,
    terms: topic.terms.filter((term) => term !== "sillones"),
  }),
  especialidades: (topic) => ({
    ...topic,
    terms: [
      "medicina general",
      "pediatría",
      ...topic.terms.filter((term) => term !== "ortodoncia" && term !== "endodoncia"),
    ],
  }),
}

function medicalTopic(topic: HelpTopic): HelpTopic {
  const worded: HelpTopic = {
    ...topic,
    purpose: say(topic.purpose),
    terms: topic.terms.map(say),
    ...(topic.faqs ? { faqs: topic.faqs.map((faq) => ({ ...faq, q: say(faq.q), a: say(faq.a) })) } : {}),
  }
  return EDITS[topic.id]?.(worded) ?? worded
}

export const MEDICAL_HELP_TOPICS: readonly HelpTopic[] = HELP_TOPICS.map(medicalTopic)
