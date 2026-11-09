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
  // Lo que un consultorio encarga al laboratorio y sus insumos (`expenseHints` de sus palabras).
  finanzas: (topic) => ({
    ...topic,
    faqs: (topic.faqs ?? []).map((faq) =>
      faq.q === "¿En qué tipo va cada gasto?"
        ? {
            ...faq,
            a: faq.a.replace(
              "«Laboratorio», coronas, prótesis y trabajos de laboratorio; «Materiales», insumos como algodón, guantes o resinas;",
              "«Laboratorio», análisis y estudios que se encargan a un laboratorio; «Materiales», insumos como algodón, guantes o jeringas;",
            ),
          }
        : faq,
    ),
  }),
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
      // Las sesiones de un consultorio son de una terapia, sin pieza.
      if (faq.q === "¿Cómo llevo un tratamiento de varias sesiones?")
        return [
          {
            ...faq,
            a: "Con sus sesiones previstas en el Plan, por ejemplo una terapia de diez: al indicarlo nace con las sesiones habituales de su servicio (el control prenatal de 7 o más, con ocho), y las cambias ahí mismo o después con «Planificar…». Cada cita que lo lleva dice en qué sesión va («sesión 1 de 2») en la Agenda, en la cita y en «Qué sigue», y al reservar la siguiente, «Para esta cita» lo ofrece mientras le falten sesiones. Si vuelve sin cita, arriba de la atención «Hoy viene a…» lo dice con su sesión (por ejemplo, la sesión 2 de 10) y «Continuar hoy» lo trae, con el motivo y el diagnóstico que sigue si faltan; nada se da por hecho hasta registrar su procedimiento. En «Realizado hoy» dice en qué sesión va y «Registrar la sesión» hasta que registras su procedimiento; con la sesión de hoy, «Completar» lo cierra. Al firmar, lo que llega a sus sesiones previstas pregunta «¿Terminaste?» con «Sí, terminar» ya elegido: si firmas sin cambiarlo, queda realizado. Si no terminaste, elige «Falta otra sesión»: le suma una y sigue en curso. Lo que sigue en curso sale al firmar, en «Atención finalizada», con «Reservar la sesión» y su número: abre «Nueva cita» con el tratamiento, su servicio y quien atendió ya elegido, sin salir de la atención; si no tiene horario en la sede o no está en la especialidad del servicio, lo dice ahí y se le reserva igual o eliges a otra persona. Al reservar dice cuándo vuelve y con quién. Mientras siga en curso, «¿Cuándo vuelve?» dice su próxima sesión (con su cita, si ya la tiene) y no pide un control. En «Qué sigue», la cita de la sesión que falta va antes que lo aceptado sin empezar. Si ya quedó realizado y le falta otra, en el Plan toca «Falta otra sesión»: vuelve a en curso con una sesión más y sale en «Por agendar»; lo firmado y lo cobrado no cambian. Si terminaste antes de lo previsto, «Completar» en «Realizado hoy». Si registras como servicio algo que sigue en curso, te avisa antes de guardar que queda como su sesión siguiente, no como un tratamiento nuevo.",
            ...(faq.forms
              ? { forms: faq.forms.filter((form) => form !== "endodoncia en dos sesiones") }
              : {}),
          },
        ]
      // Las preguntas de los caminos hablan de la pieza: en un consultorio, de la opción.
      if (faq.q === "¿Cómo anoto que aceptó una parte y lo otro lo está pensando?")
        return [
          {
            ...faq,
            a: "En su Plan, «¿Qué respondió?»: no hace falta que elija una opción. Lo que va en todas se marca Acepta, Para después o No; para lo demás eliges la opción, «Lo piensa» o «No acepta». Si lo piensa, sigue esperando respuesta y su oportunidad sigue abierta hasta que decida; después se completa ahí mismo. Lo que ya respondió no se vuelve a preguntar.",
            ...(faq.forms ? { forms: faq.forms.filter((form) => form !== "lo piensa con la muela") } : {}),
          },
        ]
      // En un consultorio son opciones, no caminos de una pieza.
      if (faq.q === "¿Cómo anoto que dijo que sí en la consulta, sin imprimir ni enviar?")
        return [
          {
            ...faq,
            a: faq.a
              .replace("con caminos, eliges el camino,", "con opciones, eliges la opción,")
              .replace("sin caminos,", "sin opciones,"),
          },
        ]
      // Lo indicado nace aceptado: los caminos no se marcan en la atención, solo en el presupuesto.
      if (faq.q.startsWith("¿Puedo ofrecer dos opciones"))
        return [
          {
            q: "¿Puedo ofrecer dos opciones en un presupuesto?",
            a: "Sí, en su Plan, con «Duplicar como otra opción»: copias la opción y cambias lo que haga falta. Cada opción tiene su total (nunca se suman) y una es la recomendada. Al anotar la respuesta no hace falta que elija: lo que va en todas se acepta y lo de cada opción puede quedar para después.",
            ...(faq.forms ? { forms: faq.forms.filter((form) => form !== "otro camino para la pieza" && form !== "conservar o extraer") } : {}),
          },
        ]
      // La tomografía médica se ve en cortes, con sus series y sus ventanas (ADR 0154): sin panorámica,
      // pieza ni arco, y sin «Guardar en tu atención de hoy», que sale de la panorámica.
      if (faq.q === "¿Cómo veo una tomografía?")
        return [
          {
            ...faq,
            a: "En su página › Clínica › Documentos, «Ver» la abre a toda la ventana, en «Cortes»: desde arriba, de frente y de lado. Si el estudio trae varias series (sin contraste, fases, el topograma), «Serie» arriba elige cuál ver; abre en la de más cortes. «Ventana» cambia lo que se ve: «Del archivo», Pulmón, Partes blandas, Hueso y Cerebro, o «Ajuste fino». «3D» sirve para explicarla, no para medir. «Medir» marca dos puntos y «Ángulo», tres: quedan con tu nombre en esa serie y son orientativas; el diagnóstico es el informe del radiólogo. «Informe y datos» muestra el informe y la toma sin salir de la imagen.",
            forms: ["como veo una tomografia", "tomografia en 3d", "como mido en la tomografia", "series de la tomografia", "ventana de pulmon", "ventana de la tomografia"],
          },
        ]
      if (/Guardar en tu atención de hoy/.test(faq.q)) return []
      // latidIA tiene una sola fase en su plan: nada «va después» de otro tratamiento de la misma pieza.
      if (faq.q.includes("va después de terminar")) return []
      // Las piezas son de odentIA: el aviso del tratamiento para otras piezas no existe en latidIA.
      if (faq.q.includes("para otras piezas")) return []
      if (faq.q === "¿Qué le doy al paciente para su seguro?")
        return [{ ...faq, a: faq.a.replace("; el odontograma, a color", "") }]
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
            a: "Clínica tiene cuatro secciones: Antecedentes, Signos vitales, Historia y Documentos. Historia es lo que pasó y cuándo, día por día: cada atención es una tarjeta con quién atendió, el diagnóstico con su nombre y su código, lo que se hizo, lo que se indicó (tratamientos, presupuesto, controles, recetas y pedidos) y lo que se firmó; lo anulado va plegado al final de su día, con su motivo, quién y cuándo. Documentos es para buscar un papel: una sola lista con «Requieren acción» y un filtro por tipo (recetas, descansos médicos, órdenes, consentimientos, formularios e imágenes); «Nuevo» abre directo el formulario.",
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
      if (faq.q === "¿A quién se le envía una receta o una orden?")
        return [{ ...faq, q: "¿A quién se le envía una receta, una orden o un descanso médico?" }]
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
      // «¿Cuándo vuelve?» y «Por invitar a volver» van con el año del consultorio, no con los 6 meses de odentIA.
      if (faq.q === "¿Cómo dejo dicho cuándo vuelve?")
        return [
          {
            ...faq,
            a: faq.a
              .replace("«En 6 meses»", "«En 1 año»")
              .replace("(la corona tras la endodoncia)", "(una terapia indicada que aún no empieza)"),
          },
        ]
      // En el consultorio la ASA no se pide al anestesiar: solo se ve si alguien la clasificó.
      if (faq.q === "¿Por qué la atención me pide sus enfermedades y su medicación?")
        return [
          {
            ...faq,
            a: faq.a
              .replace(" o su riesgo anestésico (ASA)", "")
              .replace(
                "La ASA se ve en «Antecedentes y última atención» y se elige en Antecedentes, en «Riesgo anestésico (ASA)».",
                "Si alguien clasificó su riesgo anestésico (ASA), se ve en «Antecedentes y última atención»; se elige en Antecedentes.",
              ),
          },
        ]
      if (faq.a.includes("«Por invitar a volver» es quien no vino en 6 meses"))
        return [{ ...faq, a: faq.a.replace("no vino en 6 meses", "no vino en 12 meses").replace("hace más de 6 meses", "hace más de 12 meses") }]
      return [faq]
    }),
  }),
  servicios: (topic) => ({
    ...topic,
    terms: topic.terms.filter((term) => term !== "deja en la pieza"),
    faqs: (topic.faqs ?? [])
      .filter((faq) => !faq.q.includes("Deja en la pieza"))
      // Las sesiones habituales de un consultorio: el paquete prenatal, no una corona.
      .map((faq) =>
        faq.q === "¿Qué son las sesiones habituales de un servicio?"
          ? { ...faq, a: faq.a.replaceAll("una corona en dos", "el control prenatal de 7 o más en ocho") }
          : faq,
      ),
  }),
  organizacion: (topic) => ({
    ...topic,
    faqs: (topic.faqs ?? []).map((faq) =>
      faq.q === "¿Cómo elijo el diagnóstico de una atención?"
        ? {
            q: faq.q,
            a: "Con lo que propone la atención, con los más usados en tu clínica o con el buscador de toda la lista, que no distingue tildes ni mayúsculas y muestra primero los de la atención primaria. En una sesión o un control, propone el diagnóstico del tratamiento que continúa; nada entra solo: «Usar» lo registra con el tipo de la última vez o, si nunca se registró, te pide el tipo. La parte del cuerpo se escribe en la nota del diagnóstico. «Presuntivo» basta para cerrar. Si la persona ya tenía ese diagnóstico, el sistema lo anota solo como «Ya diagnosticado antes».",
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
