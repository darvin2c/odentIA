import { CHILDHOOD_DENTAL_SENTENCE, HELP_TOPICS, SHARED_HELP_TOPICS, type HelpFaq, type HelpTopic } from "../help-guide.js"

/*
 * ---------- La guía de la Ayuda en latidIA (issue 229, entrega 11) ----------
 *
 * La misma guía de odentIA: las mismas pantallas con las palabras del
 * consultorio y, donde odentIA habla del odontograma o de la pieza, lo que
 * tiene un consultorio (los signos vitales, el examen físico y el descanso
 * médico). Lo que no existe en latidIA no se cuenta. Lo indicado queda aceptado
 * al indicarlo: el presupuesto es opcional y el plan tiene una sola fase
 * (`medical/hooks.ts`).
 *
 * Tres capas, en este orden: las palabras (`WORDS`), lo de cada tema (`EDITS`) y
 * lo de cada respuesta por su nombre fijo (`BY_ID`); al final, las preguntas que
 * solo tiene un consultorio (`OWN_FAQS`).
 */

/** Las palabras que cambian en toda la guía. */
const WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/odentIA/g, "latidIA"],
  [/odentia/g, "latidia"],
  [/odontólogos/g, "médicos"],
  [/odontólogo/g, "médico"],
  // Antes que «unidad dental»: el presupuesto se arma en la consulta, no «en la sala».
  [/en la unidad dental/g, "en la consulta"],
  [/en su sala o unidad/g, "en su sala"],
  [/unidades dentales/g, "salas"],
  [/unidad dental/g, "sala"],
]

const say = (text: string) =>
  WORDS.reduce((out, [word, replacement]) => out.replace(word, replacement), text)

type Faq = HelpFaq

/**
 * Cambia un trozo de una respuesta heredada. Si la base ya no lo dice, falla al
 * cargar: el texto de odentIA no vuelve a la guía de latidIA sin que nadie lo vea.
 */
function swap(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`La guía de latidIA cambia «${from}», que la guía base ya no dice`)
  return text.replace(from, to)
}

const swaps = (text: string, ...pairs: Array<readonly [from: string, to: string]>) =>
  pairs.reduce((out, [from, to]) => swap(out, from, to), text)

const withoutForms = (faq: Faq, ...drop: string[]): Faq =>
  faq.forms ? { ...faq, forms: faq.forms.filter((form) => !drop.includes(form)) } : faq

/** Lo que en un consultorio es otra cosa, por tema: sus palabras de búsqueda y sus preguntas. */
const EDITS: Record<string, (topic: HelpTopic) => HelpTopic> = {
  // Lo que un consultorio encarga al laboratorio y sus insumos (`expenseHints` de sus palabras).
  finanzas: (topic) => ({
    ...topic,
    faqs: (topic.faqs ?? []).map((faq) =>
      faq.q === "¿Cómo cobro un adelanto para un tratamiento?" && faq.forms
        ? { ...faq, forms: faq.forms.map((form) => (form === "adelanto para la corona" ? "adelanto para la terapia" : form)) }
        : faq.q === "¿En qué tipo va cada gasto?"
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
            a: "Con sus sesiones previstas en el Plan, por ejemplo una terapia de diez: al indicarlo nace con las sesiones habituales de su servicio (el control prenatal de 7 o más, con ocho), y las cambias ahí mismo o después con «Planificar…». Cada cita que lo lleva dice en qué sesión va («sesión 1 de 2») en la Agenda, en la cita y en «Qué sigue», y al reservar la siguiente, «Para esta cita» lo ofrece mientras le falten sesiones. Si vuelve sin cita, arriba de la atención «Hoy viene a…» lo dice con su sesión (por ejemplo, la sesión 2 de 10) y «Continuar hoy» lo trae, con el motivo y el diagnóstico que sigue si faltan; nada se da por hecho hasta registrar su procedimiento. En «Realizado hoy» dice en qué sesión va y «Registrar la sesión» hasta que registras su procedimiento; con la sesión de hoy, «Completar» lo cierra. Al firmar, lo que llega a sus sesiones previstas pregunta «¿Terminaste?» con «Sí, terminar» ya elegido: si firmas sin cambiarlo, queda realizado. Si no terminaste, elige «Falta otra sesión»: le suma una y sigue en curso. Lo que sigue en curso sale al firmar, en «Atención finalizada», con «Reservar la sesión» y su número: abre «Nueva cita» con el tratamiento, su servicio y quien atendió ya elegido, sin salir de la atención; si no tiene horario en la sede o no está en la especialidad del servicio, lo dice ahí y se le reserva igual o eliges a otra persona. Al reservar dice cuándo vuelve y con quién. Mientras siga en curso, «¿Cuándo vuelve?» dice su próxima sesión (con su cita, si ya la tiene) y no pide un control. En «Qué sigue», la cita de la sesión que falta va antes que lo indicado sin empezar. Si ya quedó realizado y le falta otra, en el Plan toca «Falta otra sesión»: vuelve a en curso con una sesión más y sale en «Por agendar»; lo firmado y lo cobrado no cambian. Si terminaste antes de lo previsto, «Completar» en «Realizado hoy». Si registras como servicio algo que sigue en curso, te avisa antes de guardar que queda como su sesión siguiente, no como un tratamiento nuevo. Si la sesión de una cita por venir se hizo antes, la cita lo sigue diciendo en «Qué sigue», en la cabecera, en la cita y en Inicio hasta que la uses para otra cosa o la liberes; liberarla no le avisa, salvo que marques «Avisarle».",
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
            ...(faq.forms ? { forms: faq.forms.filter((form) => form !== "acepto en el sillon") } : {}),
          },
        ]
      // Lo indicado nace aceptado: los caminos no se marcan en la atención, solo en el presupuesto.
      if (faq.q.startsWith("¿Puedo ofrecer dos opciones"))
        return [
          {
            id: faq.id,
            ...(faq.area ? { area: faq.area } : {}),
            q: "¿Puedo ofrecer dos opciones en un presupuesto?",
            a: "Sí, en su Plan, con «Duplicar como otra opción»: copias la opción y cambias lo que haga falta. Cada opción tiene su total (nunca se suman) y una es la recomendada. Al anotar la respuesta no hace falta que elija: lo que va en todas se acepta y lo de cada opción puede quedar para después.",
            ...(faq.forms ? { forms: faq.forms.filter((form) => form !== "otro camino para la pieza" && form !== "conservar o extraer" && form !== "dos caminos") } : {}),
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
      // Sus cuatro secciones y sus filtros (`documentFilters`, con «Descansos médicos» tras las recetas).
      if (faq.q === "¿Dónde quedaron Atenciones, Recetas u Órdenes?")
        return [
          {
            ...faq,
            a: swaps(
              faq.a,
              ["Antecedentes, Odontograma (con el Periodontograma debajo), Historia y Documentos", "Antecedentes, Signos vitales, Historia y Documentos"],
              [" En el celular, la lista de hallazgos va justo debajo del odontograma.", ""],
              [
                "(presupuestos, recetas, órdenes, consentimientos, formularios, imágenes, otros archivos y, en clínicas de Perú, odontogramas)",
                "(presupuestos, recetas, descansos médicos, órdenes, consentimientos, formularios, imágenes y otros archivos)",
              ],
            ),
          },
        ]
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
  inventario: (topic) => ({
    ...topic,
    terms: [...topic.terms.filter((term) => term !== "resina"), "jeringas"],
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
            id: faq.id,
            q: faq.q,
            a: "Con lo que propone la atención, con los más usados en tu clínica o con el buscador de toda la lista, que no distingue tildes ni mayúsculas y muestra primero los de la atención primaria. En una sesión o un control, propone el diagnóstico del tratamiento que continúa; nada entra solo: «Usar» lo registra con el tipo de la última vez o, si nunca se registró, te pide el tipo. La parte del cuerpo se escribe en la nota del diagnóstico. «Presuntivo» basta para cerrar. Si la persona ya tenía ese diagnóstico, el sistema lo anota solo como «Ya diagnosticado antes».",
          }
        : faq,
    ),
  }),
  disponibilidad: (topic) => ({
    ...topic,
    terms: topic.terms.filter((term) => term !== "sillones" && term !== "sillón"),
  }),
  especialidades: (topic) => ({
    ...topic,
    terms: [
      "medicina general",
      "medicina familiar",
      "medicina interna",
      "pediatría",
      "ginecología",
      "obstetricia",
      ...topic.terms.filter((term) => !["ortodoncia", "endodoncia", "periodoncia", "pediatría"].includes(term)),
    ],
  }),
}

/**
 * Lo que una respuesta heredada dice distinto en un consultorio, por su nombre fijo. Lo
 * indicado queda aceptado al indicarlo (`budgetRequired: false`): «Qué sigue» y los atajos
 * dicen «lo indicado» (`plan-next.ts`), el presupuesto no se arma al firmar y el embudo de
 * Reportes no tiene sus pasos (`funnelStepsOf`); el plan tiene una sola fase.
 */
const BY_ID: Record<string, (faq: Faq) => Faq[]> = {
  // «De pequeño» es de odentIA (pediatría dental); en un consultorio, solo lo común de quien cuida a un niño.
  "que-le-preguntan-a-la-mama-de-un-nino": (faq) => [
    {
      ...faq,
      a: swap(faq.a, CHILDHOOD_DENTAL_SENTENCE, ""),
      forms: (faq.forms ?? []).filter((form) => form !== "biberón y chupón"),
    },
  ],
  "alergias-toca-ultima-atencion": (faq) => [
    {
      ...faq,
      a: swaps(
        faq.a,
        ["la cita de lo aceptado (con sus nombres)", "la cita de lo indicado (con sus nombres)"],
        ["Lo aceptado va primero", "Lo indicado va primero"],
        [
          "la limpieza o el control que también falta reservar va en la misma fila que lo aceptado, con «Reservar lo aceptado y el control»,",
          "el control que también falta reservar va en la misma fila que lo indicado, con «Reservar lo indicado» (el botón nombra también el control),",
        ],
        [
          "si una cita que llevaba lo aceptado se atendió sin registrar lo que se hizo, la fila de lo aceptado lo dice",
          "si una cita que llevaba lo indicado se atendió sin registrar lo que se hizo, la fila de lo indicado lo dice",
        ],
        // La ASA solo se ve si alguien la clasificó (`showsAsa: false`).
        [
          "medicación y ASA («niega» si lo negó, «no preguntado» si nadie lo preguntó)",
          "medicación («niega» si lo negó, «no preguntado» si nadie lo preguntó) y, solo si alguien la clasificó, su ASA",
        ],
      ),
    },
  ],
  "son-agendar-deben-demas-atajos": (faq) => [
    { ...faq, a: swap(faq.a, "quien tiene algo aceptado sin una cita", "quien tiene algo indicado sin una cita") },
  ],
  "elijo-tratamientos-trae-cita": (faq) => [
    {
      ...faq,
      a: swaps(
        faq.a,
        ["muestra lo que la persona aceptó y aún no tiene cita", "muestra lo indicado que aún no tiene cita"],
        ["la cita trae lo aceptado de su servicio", "la cita trae lo indicado de su servicio"],
      ),
    },
  ],
  "esta-plan-tratamiento": (faq) => [
    {
      ...faq,
      a: swaps(
        faq.a,
        ["lo aceptado y los controles se reservan ahí", "lo indicado y los controles se reservan ahí"],
        ["los tratamientos por fases (con", "los tratamientos (con"],
        ["al lado), el presupuesto, los controles", "al lado), el presupuesto si alguien lo preparó, los controles"],
      ),
    },
  ],
  // El presupuesto es opcional: no se arma solo al firmar ni el cierre pregunta si enviarlo (`assembleEncounterBudget`).
  "arma-envia-presupuesto": (faq) => [
    {
      ...faq,
      a: "No hace falta: lo que indicas en la atención queda aceptado al indicarlo y se agenda sin presupuesto; no se arma solo al firmar. Si la persona quiere saber cuánto costará, en su Plan › «Presupuesto», «Preparar presupuesto» lo arma con lo indicado que tiene precio. «Revisar y enviar» muestra lo que se propone, hasta cuándo vale y cómo se explica cada tratamiento, con «Ver el PDF» antes de enviar; «Enviar por WhatsApp» (o por correo, si no tiene WhatsApp) dice antes a quién le llega. Recepción lo envía y anota la respuesta, pero no cambia precios.",
      forms: ["hace falta un presupuesto para agendar", "no me sale el presupuesto al firmar", "el presupuesto es obligatorio"],
    },
  ],
  "pasa-cambio-precio-despues-enviarlo": (faq) => [
    {
      ...faq,
      a: swaps(
        faq.a,
        ["que la corona sube", "que la terapia sube"],
        ["Si todavía no eligió camino, la revisión lleva todos los caminos", "Si todavía no eligió opción, la revisión lleva todas las opciones"],
      ),
    },
  ],
  // Los caminos de la atención son de odentIA: aquí las opciones solo están en el presupuesto.
  "quiere-decir-cada-estado-presupuesto": (faq) => [
    {
      ...faq,
      a: swap(
        faq.a,
        "«Aceptó todo» o «Aceptó 2 de 3»; con caminos sin elegir, dice que falta elegir el camino. En la atención, con dos opciones, dice cada una con su total y «falta que elija», y después que eligió la opción A, con lo que cuesta esa opción.",
        "«Aceptó todo» o «Aceptó 2 de 3»; con dos opciones, dice cuál eligió.",
      ),
    },
  ],
  // El control de «En 1 año» se llama «Control anual» (`recallControlTitle`).
  "dejo-dicho-vuelve": (faq) => [
    {
      ...faq,
      a: swaps(
        faq.a,
        ["con el nombre de lo que hiciste hoy o de mantenimiento,", "con el nombre de lo que hiciste hoy (con «En 1 año», «Control anual»),"],
        ["(lo aceptado, o lo que indicaste hoy)", "(lo que indicaste hoy o antes)"],
        ["tiene algo aceptado sin empezar", "tiene algo indicado sin empezar"],
        ["Lo aceptado se reserva sin esperar al control", "Lo indicado se reserva sin esperar al control"],
      ),
    },
  ],
  "atencion-pide-enfermedades-medicacion": (faq) => [
    withoutForms(
      { ...faq, a: swap(faq.a, "cambian la anestesia y lo que se receta", "cambian lo que se indica y lo que se receta") },
      "asa antes de la anestesia",
    ),
  ],
  // latidIA sí emite descansos médicos (`medicalLeave: true`): se guardan, se ven en el portal y llevan el color.
  "puede-cambiar-receta-emitida-comprueba-qr": (faq) => [
    { ...faq, a: swap(faq.a, "Receta y orden quedan guardadas", "Receta, orden y descanso quedan guardados") },
  ],
  "ve-paciente-portal": (faq) => [
    {
      ...faq,
      a: swap(
        faq.a,
        "Recetas y órdenes (con su resultado) desde que se emiten",
        "Recetas, órdenes (con su resultado) y descansos desde que se emiten",
      ),
    },
  ],
  "poner-color-clinica": (faq) => [
    {
      ...faq,
      a: swap(faq.a, "las recetas, órdenes y consentimientos ya emitidos", "las recetas, órdenes, descansos y consentimientos ya emitidos"),
    },
  ],
  // Sus tipos de imagen (`MEDICAL_IMAGING_TYPES`).
  "subo-radiografia": (faq) => [
    {
      ...faq,
      a: swap(
        faq.a,
        "imagen o archivo, con su tipo y la fecha de toma",
        "imagen o archivo, con su tipo (radiografía, ecografía, tomografía computarizada, resonancia magnética, mamografía o foto clínica) y la fecha de toma",
      ),
      forms: [...(faq.forms ?? []), "donde subo una ecografia", "subir una resonancia", "subir una mamografia"],
    },
  ],
  "pacientes-tratamiento-suspender-cancelar-fase": (faq) => [
    withoutForms(
      {
        ...faq,
        a: swap(
          faq.a,
          "La fase y las sesiones previstas se cambian en la lista con «Planificar…», y el orden dentro de la fase, con las flechas de subir y bajar.",
          "Las sesiones previstas se cambian en la lista con «Planificar…», y el orden, con las flechas de subir y bajar.",
        ),
      },
      "pasar un tratamiento a otra fase",
    ),
  ],
  "pacientes-procedimiento-registrar-anular": (faq) => [
    { ...faq, a: swap(faq.a, "eliges un tratamiento aceptado de su plan", "eliges un tratamiento indicado de su plan") },
  ],
  // El embarazo no va en «Personales» (`asksPregnancy: false`): tiene su sección, con la lactancia.
  "pacientes-antecedentes-enfermedades-medicacion": (faq) => [
    withoutForms(
      {
        ...faq,
        a: swap(
          faq.a,
          "y «Entrevista de salud» para el «Embarazo» y los antecedentes familiares, con «Agregar antecedente familiar».",
          "y «Entrevista de salud» para los antecedentes familiares, con «Agregar antecedente familiar», y para el embarazo, los hábitos y las vacunas.",
        ),
      },
      "donde pongo que esta embarazada",
    ),
  ],
  // Cada cuánto puede repetirse un control (`FOLLOW_UP_REPEAT_MONTHS`).
  // Aquí un control se puede repetir (`repeatingControls`); en odentIA, no.
  "pacientes-control-indicar-completar-cancelar": (faq) => [
    {
      ...faq,
      q: "¿Cómo indico un control que se repite, lo completo o lo cancelo?",
      a: swap(
        faq.a,
        "eliges el tipo y le pones título y fecha.",
        "eliges el tipo, le pones título y fecha y, en «Se repite», «Una sola vez» o cada 1, 3, 6 o 12 meses; al completarlo queda indicado el siguiente hasta que toques «Dejar de repetir».",
      ),
      forms: [...(faq.forms ?? []), "como indico un control cada 6 meses", "control que se repite"],
    },
  ],
  "pacientes-dictado-corregir-pausar": (faq) => [
    {
      ...faq,
      a: swap(
        faq.a,
        " y un presupuesto dictado se deja en borrador con «Armar».",
        ", un descanso dictado con «Emitir descanso», que abre su formulario ya lleno, y un presupuesto dictado se deja en borrador con «Armar».",
      ),
    },
  ],
  // Sin presupuesto que aceptar, el embudo va de venir a pagar (`funnelStepsOf`).
  "caen-pacientes": (faq) => [
    {
      ...faq,
      a: swaps(
        faq.a,
        [
          "vinieron (una cita atendida o una atención firmada), recibieron presupuesto, lo aceptaron (del todo o en parte) y, además, pagaron algo",
          "vinieron (una cita atendida o una atención firmada) y, además, pagaron algo",
        ],
        ["agendar, recibir el presupuesto y aceptarlo son los mismos momentos de Oportunidades", "agendar es el mismo momento de Oportunidades"],
      ),
      forms: [...(faq.forms ?? []), "por que mi embudo no tiene presupuesto", "que pasos tiene donde se caen los pacientes"],
    },
  ],
  "son-espera-entre-sesiones-controles-terminar": (faq) => [
    {
      ...faq,
      a: swaps(
        faq.a,
        ["(por ejemplo, una semana para que actúe una medicación)", "(por ejemplo, una semana entre las sesiones de una terapia)"],
        ["como un control radiográfico al año", "como un control al mes de terminar"],
      ),
    },
  ],
  // Lo que propone el perfil profesional en Perú (`medicalProfessionalFor`).
  "equipo-colegiatura": (faq) => [
    { ...faq, a: `${faq.a} En Perú vienen propuestos «Médico cirujano» y el CMP, y se pueden cambiar.` },
  ],
}

/** Una pregunta que la base marca solo de odentIA y que un consultorio también tiene: la misma, con sus palabras. */
function fromBase(topicId: string, id: string): Faq {
  const found = HELP_TOPICS.find((topic) => topic.id === topicId)?.faqs?.find((faq) => faq.id === id)
  if (!found) throw new Error(`La guía base ya no tiene «${id}» en «${topicId}»`)
  const { own: _own, ...faq } = found
  return { ...faq, q: say(faq.q), a: say(faq.a) }
}

/** Lo que solo tiene un consultorio, por tema: preguntas que la guía de odentIA no trae. */
const OWN_FAQS: Record<string, Faq[]> = {
  pacientes: [
    {
      id: "registro-signos-vitales-examen-fisico",
      q: "¿Dónde registro los signos vitales y el examen físico?",
      a: "Dentro de la atención, en su bloque «Examen físico»: los signos vitales (el IMC sale solo del peso y la talla) y cada sistema «Sin alteraciones» o «Con hallazgos», con lo que encontraste y la parte del cuerpo. Lo que no marcas queda «No examinado», nunca normal. En su página, Clínica › Signos vitales los muestra en el tiempo.",
      area: "clinica",
      needs: "clinical.write",
    },
    {
      id: "emito-descanso-medico",
      q: "¿Cómo emito un descanso médico?",
      a: "En la atención, en su bloque «Documentos», con «Nuevo» › «Descanso médico»: «Desde» qué día y cuántos «Días» (de 1 a 365), las «Indicaciones (opcional)», como reposo relativo, y el diagnóstico solo si marcas «La persona autoriza que el diagnóstico figure». Queda firmado con tu perfil profesional y numerado; no se corrige, se anula con motivo.",
      forms: ["como doy un descanso", "cuantos dias de descanso puedo dar", "descanso sin diagnostico"],
      area: "clinica",
      needs: "clinical.write",
    },
    {
      id: "pacientes-falta-cita-de-lo-indicado",
      q: "¿Qué es «Falta la cita de lo indicado»?",
      a: "Es lo que se indicó en una atención y todavía no tiene cita: en latidIA lo indicado queda aceptado al indicarlo, sin esperar un presupuesto. En «Qué sigue», en el Resumen o en el Plan de su página, «Reservar lo indicado» abre «Nueva cita» con eso ya marcado. Reserva quien lleva la agenda.",
      forms: ["donde reservo lo que le indico el medico", "que es reservar lo indicado", "falta la cita de lo indicado"],
      area: "plan",
      needs: "appointments.write",
    },
    {
      id: "pacientes-embarazo-habitos-vacunas",
      q: "¿Dónde anoto el embarazo, los hábitos y las vacunas?",
      a: "En su página › Clínica › Antecedentes, al registrar o editar, dentro de «Entrevista de salud»: «Embarazo y lactancia», cada uno con el día en que lo dijo, «Gineco-obstétricos», «Hábitos» (tabaco, alcohol y actividad física) y «Vacunas», con «Agregar vacuna». A un hombre no se le pregunta el embarazo ni lo gineco-obstétrico. Lo guardado se lee en «Antecedentes médicos», y la receta recuerda el embarazo y la lactancia anotados. Lo cambia quien escribe en la historia clínica.",
      forms: ["donde pongo que esta embarazada", "donde anoto si fuma", "donde pongo las vacunas", "donde anoto que da de lactar"],
      area: "clinica",
      needs: "clinical.write",
    },
    {
      id: "pacientes-lista-de-problemas",
      q: "¿Dónde veo los diagnósticos activos de un paciente?",
      a: "En su página, en el Resumen, «Lista de problemas»: el embarazo o la lactancia anotados y cada diagnóstico activo de sus atenciones, con su código, desde cuándo y quién lo puso. «Marcar resuelto» lo saca de la lista sin abrir la atención, y «Historia» lleva a sus atenciones. La ve quien lee la historia clínica; marcar resuelto es de quien escribe en ella.",
      forms: ["lista de problemas", "como quito un diagnostico que ya paso", "diagnosticos vigentes del paciente"],
      area: "clinica",
      needs: "clinical.read",
    },
    {
      id: "pacientes-examen-marcar-resto",
      q: "¿Tengo que marcar cada sistema del examen uno por uno?",
      a: "No: en el bloque «Examen físico» de la atención, marca primero lo que tiene hallazgos y pulsa «Marcar el resto sin alteraciones»; solo marca lo que falta, nunca cambia lo ya marcado. Si marcaste uno por error, tócalo otra vez y vuelve a «No examinado». Son diez sistemas, del estado general al neurológico.",
      forms: ["como pongo todo el examen normal", "marque un sistema por error", "marcar el resto sin alteraciones"],
      area: "clinica",
      needs: "clinical.write",
    },
    {
      id: "pacientes-signos-vitales-cuales",
      q: "¿Qué signos vitales puedo registrar?",
      a: "En el bloque «Examen físico» de la atención: presión arterial, frecuencia cardiaca y respiratoria, temperatura, saturación, peso, talla, perímetro cefálico y glucosa capilar. El IMC no se escribe: sale del peso y la talla. Debajo dice lo que tenía la última vez, con su fecha, para compararlo sin salir de la atención.",
      forms: ["donde pongo la glucosa", "como veo la presion de la vez pasada", "donde anoto el perimetro cefalico"],
      area: "clinica",
      needs: "clinical.write",
    },
    {
      id: "pacientes-signos-vitales-en-el-tiempo",
      q: "¿Dónde veo cómo va su presión o su peso?",
      a: "En su página › Clínica › Signos vitales: un gráfico por cada signo que se le tomó y, al lado, «Última medición». «Ver como tabla» los pone por fecha, con quién los tomó, y «Ver los gráficos» vuelve. Ahí solo se miran: se registran en el «Examen físico» de cada atención. Lo ve quien lee la historia clínica.",
      forms: ["grafico de la presion", "ver el peso en una tabla", "puedo anotar la presion sin abrir una atencion"],
      area: "clinica",
      needs: "clinical.read",
    },
    {
      id: "pacientes-receta-avisos",
      q: "¿Por qué la receta me pide el peso o no me deja un medicamento controlado?",
      a: "Un medicamento controlado (un opioide, una benzodiazepina, un barbitúrico o un estimulante) no se emite en la receta común: va en la receta oficial de tu país. A un menor de 12 años la receta le pide el «Peso (kg)» y propone el último registrado. Si tiene un embarazo o una lactancia anotados, lo recuerda y avisa de lo que está contraindicado en el embarazo: se emite igual y queda guardado que viste el aviso. Pasadas las 42 semanas dice «Embarazo por confirmar» y sigue avisando hasta que actualices sus antecedentes.",
      forms: ["no me deja recetar tramadol", "la receta me pide el peso", "aviso de embarazo en la receta"],
      area: "clinica",
      needs: "clinical.write",
    },
    {
      id: "pacientes-dictado-que-decir",
      q: "¿Qué le puedo dictar a Clío en una consulta?",
      a: "Casi toda la consulta: el motivo, los signos vitales («presión 118 con 76»), el examen por sistemas, el diagnóstico, la receta, el control, el descanso, las alergias y los procedimientos, y corriges de viva voz. «¿Qué puedo decir?», junto a «Dictar», trae un ejemplo de cada uno. Lo que no dictas del examen queda «No examinado».",
      forms: ["puedo dictar la presion", "puedo dictar un descanso medico", "que entiende clio"],
      area: "clinica",
      needs: "clinical.write",
    },
    // La tomografía médica se sube y se descarga como la dental (`tomography: { kind: "ct" }`).
    fromBase("pacientes", "pacientes-tomografia-subir-descargar"),
    fromBase("pacientes", "pacientes-recepcion-sube-tomografia"),
  ],
  especialidades: [
    {
      id: "especialidades-trae-latidia",
      q: "¿Qué especialidades trae latidIA?",
      a: "Tu consultorio nace con cinco: Medicina general, Medicina familiar, Medicina interna, Pediatría y Ginecología y obstetricia. Es la lista general de latidIA, no la norma de un país. En Configuración › Especialidades, «Editar» dice quién atiende cada una y «Agregar especialidad» crea otra, como cardiología.",
      forms: ["puedo agregar cardiologia", "no encuentro mi especialidad", "con que especialidades empieza el consultorio"],
    },
  ],
  formularios: [
    {
      id: "formularios-consentimientos-latidia",
      q: "¿Qué consentimientos trae latidIA?",
      a: "Tres, como textos de partida para que un profesional los revise: el de procedimiento menor en consultorio, el de aplicación de medicamentos inyectables y el de toma de muestras, cada uno unido a sus servicios de la biblioteca. Se leen y se cambian en Configuración › Consentimientos.",
      forms: ["hay consentimiento para inyectables", "consentimiento para una sutura", "consentimientos que vienen con latidia"],
    },
  ],
}

/** Los nombres de `BY_ID` que la guía base sí trae: uno que ya no existe detiene el arranque. */
const edited = new Set<string>()

function medicalTopic(topic: HelpTopic): HelpTopic {
  const worded: HelpTopic = {
    ...topic,
    purpose: say(topic.purpose),
    terms: topic.terms.map(say),
    ...(topic.faqs ? { faqs: topic.faqs.map((faq) => ({ ...faq, q: say(faq.q), a: say(faq.a) })) } : {}),
  }
  const byTopic = EDITS[topic.id]?.(worded) ?? worded
  const faqs = [
    ...(byTopic.faqs ?? []).flatMap((faq) => {
      const edit = BY_ID[faq.id]
      if (!edit) return [faq]
      edited.add(faq.id)
      return edit(faq)
    }),
    ...(OWN_FAQS[topic.id] ?? []),
  ]
  return faqs.length > 0 ? { ...byTopic, faqs } : byTopic
}

export const MEDICAL_HELP_TOPICS: readonly HelpTopic[] = SHARED_HELP_TOPICS.map(medicalTopic)

const stray = [
  ...Object.keys(BY_ID).filter((id) => !edited.has(id)),
  ...Object.keys(OWN_FAQS).filter((id) => !SHARED_HELP_TOPICS.some((topic) => topic.id === id)),
]
if (stray.length > 0) throw new Error(`La guía de latidIA edita lo que la guía base ya no tiene: ${stray.join(", ")}`)
