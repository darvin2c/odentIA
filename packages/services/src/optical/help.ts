import { HELP_TOPICS, type HelpFaq, type HelpTopic } from "../help-guide.js"

/*
 * ---------- La guía de la Ayuda en vistIA ----------
 *
 * La misma guía de odentIA, como la de latidIA (`medical/help.ts`): las mismas
 * pantallas con las palabras de una óptica (optómetra, sala de examen) y sin lo
 * que una óptica no tiene: el odontograma, la pieza, el visor de tomografías en
 * cortes, el dictado de Clío, el riesgo anestésico ni el descanso médico. Lo
 * indicado queda aceptado al indicarlo, como en latidIA, y se invita a volver al
 * año, al control anual de la vista. El examen de la vista, la receta de lentes y
 * el pedido llegan en otra entrega: la guía no los promete.
 */

/** Las palabras que cambian en toda la guía. */
const WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/odentIA/g, "vistIA"],
  [/odentia/g, "vistia"],
  [/odontólogos/g, "optómetras"],
  [/odontólogo/g, "optómetra"],
  [/Caja y odontología/g, "Caja y los optómetras"],
  [/unidades dentales/g, "salas de examen"],
  [/unidad dental/g, "sala de examen"],
  [/en su sala o unidad/g, "en su sala de examen"],
  [/en el sillón/g, "en la consulta"],
]

const say = (text: string) =>
  WORDS.reduce((out, [word, replacement]) => out.replace(word, replacement), text)

type Faq = HelpFaq

const withoutForms = (faq: Faq, ...drop: string[]): Faq =>
  faq.forms ? { ...faq, forms: faq.forms.filter((form) => !drop.includes(form)) } : faq

/** Lo que la página de una persona cuenta distinto en una óptica, por pregunta; sin entrada, queda igual. */
const PATIENT_FAQS: Record<string, (faq: Faq) => Faq[]> = {
  // Sin odontograma ni pieza, sin dictado y sin visor de tomografías en cortes.
  "¿Dónde registro un hallazgo del odontograma?": () => [],
  "¿Por qué la pieza quedó dibujada después del tratamiento?": () => [],
  "¿Cómo se firma el odontograma?": () => [],
  "¿Cómo dicto una atención?": () => [],
  "¿Para qué es «Guardar en tu atención de hoy» en la tomografía?": () => [],
  // Lo indicado ya queda aceptado: lo que falta es su cita.
  "¿Dónde veo sus alergias, qué le toca y su última atención?": (faq) => [
    {
      ...faq,
      a: faq.a
        .replace("la cita de lo aceptado (con sus nombres)", "la cita de lo indicado (con sus nombres)")
        .replace("la limpieza o el control que también falta reservar", "el control que también falta reservar")
        // Una óptica no anestesia: arriba no va la ASA (`showsAsa`).
        .replace("alergias, enfermedades, medicación y ASA", "alergias, enfermedades y medicación"),
    },
  ],
  "¿Dónde quedaron Atenciones, Recetas u Órdenes?": (faq) => [
    {
      ...faq,
      a: "Clínica tiene tres secciones: Antecedentes, Historia y Documentos. Historia es lo que pasó y cuándo, día por día: cada atención es una tarjeta con quién atendió, el diagnóstico con su nombre y su código, lo que se hizo, lo que se indicó (tratamientos, controles, recetas y pedidos) y lo que se firmó; lo anulado va plegado al final de su día, con su motivo, quién y cuándo. Documentos es para buscar un papel: una sola lista con «Requieren acción» y un filtro por tipo (recetas, órdenes, consentimientos, formularios e imágenes); «Nuevo» abre directo el formulario.",
    },
  ],
  // Las sesiones de una óptica son las de la terapia visual (diez en la biblioteca), sin pieza.
  "¿Cómo llevo un tratamiento de varias sesiones?": (faq) => [
    withoutForms(
      {
        ...faq,
        a: faq.a
          .replace("por ejemplo una corona en dos", "por ejemplo una terapia visual de diez")
          .replace("(por ejemplo, la endodoncia de la 46 en su sesión 2 de 2)", "(por ejemplo, la terapia visual en su sesión 2 de 10)")
          .replace(" Si lo indicas desde la pieza del odontograma, el panel también pide «Sesiones previstas» con las habituales del servicio.", "")
          // Resolver el diagnóstico de la pieza al firmar es de odentIA.
          .replace(
            " Si su tratamiento resuelve un diagnóstico de esa pieza (la pulpitis de la 46 con su endodoncia), el cierre lo propone marcado como resuelto: desmárcalo si sigue activo.",
            "",
          )
          .replace("en curso en esa pieza,", "en curso,"),
      },
      "endodoncia en dos sesiones",
    ),
  ],
  "¿Dónde hago la receta, el consentimiento o la orden de la atención?": (faq) => [
    { ...faq, a: faq.a.replace("(pieza, diagnóstico, procedimiento y quien atiende)", "(diagnóstico, procedimiento y quien atiende)") },
  ],
  "¿Se puede cambiar una receta ya emitida? ¿Qué comprueba el QR?": (faq) => [
    { ...faq, a: faq.a.replace("Receta, orden y descanso quedan guardados", "Receta y orden quedan guardadas") },
  ],
  "¿Qué le doy al paciente para su seguro?": (faq) => [{ ...faq, a: faq.a.replace("; el odontograma, a color", "") }],
  // «¿Cuándo vuelve?» va con el año de la óptica y su control lleva el nombre del control anual.
  "¿Cómo dejo dicho cuándo vuelve?": (faq) => [
    {
      ...faq,
      a: faq.a
        .replace("«En 6 meses»", "«En 1 año»")
        .replace("(la corona tras la endodoncia)", "(una terapia visual indicada que aún no empieza)")
        .replace(
          "con el nombre de lo que hiciste hoy o de mantenimiento,",
          "con el nombre de lo que hiciste hoy (con «En 1 año», «Control anual de la vista»),",
        ),
    },
  ],
  // Una sola fase: el plan no habla de fases.
  "¿Dónde está el plan de tratamiento?": (faq) => [
    { ...faq, a: faq.a.replace("los tratamientos por fases (con", "los tratamientos (con") },
  ],
  // El presupuesto es opcional: no se arma solo al firmar (`assembleEncounterBudget`).
  "¿Cómo se arma y se envía el presupuesto?": (faq) => [
    {
      ...faq,
      a: "No hace falta: lo que indicas en la atención queda aceptado al indicarlo y se agenda sin presupuesto. Si la persona lo pide, en su Plan, «Preparar presupuesto» lo arma con lo indicado que tiene precio. «Revisar y enviar» muestra lo que se propone, hasta cuándo vale y cómo se explica cada tratamiento (la explicación sale de cada servicio y se puede cambiar solo para este paciente), con «Ver el PDF» antes de enviar. «Enviar por WhatsApp» (o por correo, si no tiene WhatsApp) dice antes a quién le llega. Recepción lo envía y anota la respuesta, pero no cambia precios.",
    },
  ],
  // Lo indicado nace aceptado: las opciones no se marcan en la atención, solo en el presupuesto (como latidIA).
  "¿Puedo ofrecer dos opciones, por ejemplo resina o corona?": (faq) => [
    withoutForms(
      {
        ...faq,
        q: "¿Puedo ofrecer dos opciones en un presupuesto?",
        a: "Sí, en su Plan, con «Duplicar como otra opción»: copias la opción y cambias lo que haga falta. Cada opción tiene su total (nunca se suman) y una es la recomendada. Al anotar la respuesta no hace falta que elija: lo que va en todas se acepta y lo de cada opción puede quedar para después.",
      },
      "otro camino para la pieza",
      "conservar o extraer",
    ),
  ],
  "¿Cómo anoto que aceptó una parte y lo otro lo está pensando?": (faq) => [
    withoutForms(
      {
        ...faq,
        a: "En su Plan, «¿Qué respondió?»: no hace falta que elija una opción. Lo que va en todas se marca Acepta, Para después o No; para lo demás eliges la opción, «Lo piensa» o «No acepta». Si lo piensa, sigue esperando respuesta y su oportunidad sigue abierta hasta que decida; después se completa ahí mismo. Lo que ya respondió no se vuelve a preguntar.",
      },
      "lo piensa con la muela",
    ),
  ],
  "¿Cómo anoto que dijo que sí en la consulta, sin imprimir ni enviar?": (faq) => [
    withoutForms(
      {
        ...faq,
        a: faq.a
          .replace("con caminos, eliges el camino,", "con opciones, eliges la opción,")
          .replace("sin caminos,", "sin opciones,"),
      },
      "acepto en el sillon",
    ),
  ],
  "¿Qué pasa si cambio un precio después de enviarlo?": (faq) => [
    {
      ...faq,
      a: faq.a
        .replace("que la corona sube", "que la terapia visual sube")
        .replace(
          "Si todavía no eligió camino, la revisión lleva todos los caminos",
          "Si todavía no eligió opción, la revisión lleva todas las opciones",
        ),
    },
  ],
  // Sin dictado; el motivo, en las palabras de quien viene a una óptica.
  "¿Qué va en cada campo de «Consulta»?": (faq) => [
    {
      ...faq,
      a: faq.a
        .replace("por ejemplo: vengo porque me duele", "por ejemplo: veo borroso de lejos")
        .replace("por ejemplo, 3 días", "por ejemplo, 3 meses")
        .replace("si escribes o dictas otro", "si escribes otro"),
    },
  ],
  // Una óptica no anestesia: no se pide ni se muestra la ASA (`asksAsa`, `showsAsa`).
  "¿Por qué la atención me pide sus enfermedades y su medicación?": (faq) => [
    withoutForms(
      {
        ...faq,
        a: faq.a
          .replace(
            "un problema del corazón, la presión alta, la diabetes, un anticoagulante o un embarazo cambian la anestesia y lo que se receta",
            "la diabetes, la presión alta, un medicamento o un embarazo cambian lo que se revisa en el ojo y lo que se indica",
          )
          .replace(
            " Si se usa un anestésico local (lidocaína, articaína…) y todavía falta algo de eso o su riesgo anestésico (ASA), el cierre lo dice junto a los materiales.",
            "",
          )
          .replace(" La ASA se ve en «Antecedentes y última atención» y se elige en Antecedentes, en «Riesgo anestésico (ASA)».", ""),
      },
      "asa antes de la anestesia",
      "donde pongo la clasificacion asa",
    ),
  ],
  // Las imágenes de una óptica son sus pruebas del ojo (`OPTICAL_IMAGING_TYPES`).
  "¿Dónde subo una radiografía?": (faq) => [
    {
      ...faq,
      q: "¿Dónde subo una retinografía o un campo visual?",
      a: faq.a.replace(
        "imagen o archivo, con su tipo y la fecha de toma",
        "imagen o archivo, con su tipo (retinografía, topografía corneal, OCT, campo visual o foto del ojo) y la fecha de toma",
      ),
      forms: ["donde subo una retinografia", "donde subo una prueba del ojo", "subir imagen", "subir examen", "subir campo visual", "subir topografia"],
    },
  ],
  // La OCT es una imagen con su informe: no hay visor de cortes (`imagingStudy: null`).
  "¿Cómo veo una tomografía?": () => [
    {
      q: "¿Cómo veo una OCT?",
      a: "Como cualquier imagen: en su página › Clínica › Documentos, «Ver» la abre a toda la ventana y «Informe y datos» muestra su informe sin salir de ella. En vistIA la OCT es una imagen con su informe, no un estudio en cortes: no se recorre por cortes ni en 3D.",
      forms: ["como veo una tomografia", "tomografia de coherencia optica", "tomografia en 3d", "tomografia en cortes"],
    },
  ],
  "¿Cómo cierro una orden de imagen con su resultado?": (faq) => [
    withoutForms(
      {
        ...faq,
        a: "En su página › Clínica › Documentos › Órdenes, «Subir resultado». «Ya está en la ficha» elige la imagen que ya se subió (por ejemplo, la topografía que trajo de otro centro) y la une a la orden sin copiarla. «Archivo nuevo» sube una imagen o un PDF. La orden queda «Con resultado».",
      },
      "resultado de la tomografia",
    ),
  ],
  // «Por invitar a volver» va con el año de la óptica, no con los 6 meses de odentIA.
  "¿Qué son «Por agendar», «Deben» y los demás atajos?": (faq) => [
    { ...faq, a: faq.a.replace("no vino en 6 meses", "no vino en 12 meses").replace("hace más de 6 meses", "hace más de 12 meses") },
  ],
  "¿Qué ve el paciente en su portal?": (faq) => [
    {
      ...faq,
      a: faq.a
        .replace("Recetas, órdenes (con su resultado) y descansos desde que se emiten", "Recetas y órdenes (con su resultado) desde que se emiten")
        .replace("y las radiografías y fotos con su informe", "y las imágenes y fotos con su informe")
        .replace(
          "No ve las notas de sus atenciones, la tomografía ni los archivos DICOM (no se abren en el teléfono), ni lo que es",
          "No ve las notas de sus atenciones ni lo que es",
        ),
      ...(faq.forms
        ? { forms: faq.forms.map((form) => (form === "el paciente ve sus radiografias" ? "el paciente ve sus imagenes" : form)) }
        : {}),
    },
  ],
  "¿Cómo oculto una imagen o un archivo de su portal?": (faq) => [
    {
      ...faq,
      ...(faq.forms ? { forms: faq.forms.map((form) => (form === "que no vea una radiografia" ? "que no vea una imagen" : form)) } : {}),
    },
  ],
}

/** Lo que en una óptica es otra cosa, por tema: sus palabras de búsqueda y sus preguntas. */
const EDITS: Record<string, (topic: HelpTopic) => HelpTopic> = {
  // El adelanto de una óptica es para su terapia visual, no para una corona.
  finanzas: (topic) => ({
    ...topic,
    faqs: (topic.faqs ?? []).map((faq) => {
      if (faq.q === "¿Cómo cobro un adelanto para un tratamiento?" && faq.forms)
        return { ...faq, forms: faq.forms.map((form) => (form === "adelanto para la corona" ? "adelanto para la terapia visual" : form)) }
      // Lo que una óptica encarga al laboratorio y sus insumos (`expenseHints` de sus palabras).
      if (faq.q === "¿En qué tipo va cada gasto?")
        return {
          ...faq,
          a: faq.a.replace(
            "«Laboratorio», coronas, prótesis y trabajos de laboratorio; «Materiales», insumos como algodón, guantes o resinas;",
            "«Laboratorio», lunas, lentes de contacto y trabajos del laboratorio óptico; «Materiales», insumos como paños, estuches o líquidos de limpieza;",
          ),
        }
      return faq
    }),
  }),
  pacientes: (topic) => ({
    ...topic,
    terms: [...topic.terms.filter((term) => term !== "odontograma"), "pruebas del ojo"],
    faqs: (topic.faqs ?? []).flatMap((faq) => PATIENT_FAQS[faq.q]?.(faq) ?? [faq]),
  }),
  // Clío no dicta en una óptica: la mesa del plan quitó dictar la refracción.
  agente: (topic) => ({
    ...topic,
    purpose: topic.purpose.replace(
      "(Sofi, tu agente de recepción; Clío, tu agente clínico, y Argos, tu agente administrador)",
      "(Sofi, tu agente de recepción, y Argos, tu agente administrador)",
    ),
    faqs: (topic.faqs ?? []).map((faq): Faq => {
      if (faq.q === "¿Cómo enciendo el agente?")
        return { ...faq, a: faq.a.replace("Clío y Argos tienen el suyo en su página.", "Argos tiene el suyo en su página.") }
      if (faq.q === "¿Qué es Sofi?")
        return {
          ...faq,
          a: faq.a.replace(
            "Clío es tu agente clínico, que ordena lo que dicta quien atiende, y Argos tu agente administrador, que mira cómo va la clínica y hace lo que le encargues.",
            "Argos es tu agente administrador, que mira cómo va la clínica y hace lo que le encargues. Clío, el agente que ordena lo que dicta quien atiende, no dicta en una óptica.",
          ),
        }
      if (faq.q === "¿Cómo enciendo a Clío?")
        return {
          q: "¿Puedo dictar la atención?",
          a: "No: en una óptica Clío no dicta, porque una medida mal oída son unos lentes mal hechos. Lo de la atención se escribe en ella.",
          forms: [
            "como enciendo a clio",
            "como activo a clio",
            "como apago a clio",
            "como dicto una atencion",
            "como uso el dictado",
            "dictado",
            "dictar",
            "como funciona clio",
            "como funciona el dictado",
          ],
          general: true,
        }
      return faq
    }),
  }),
  // Su biblioteca es la de una óptica, sin «Deja en la pieza»; lo que se vende no es un servicio.
  servicios: (topic) => ({
    ...topic,
    purpose: `${topic.purpose} La biblioteca de vistIA trae los de una óptica: el examen de la vista y su control, los lentes de contacto, la adaptación y la reparación de anteojos, las pruebas especiales y la terapia visual. Las monturas, las lunas y los lentes de sol no son servicios: son productos que se venden, en Inventario.`,
    terms: topic.terms.filter((term) => term !== "deja en la pieza"),
    faqs: (topic.faqs ?? [])
      .filter((faq) => !faq.q.includes("Deja en la pieza"))
      .map((faq): Faq => {
        if (faq.q === "¿Qué son las sesiones habituales de un servicio?")
          return { ...faq, a: faq.a.replaceAll("una corona en dos", "una terapia visual en diez") }
        // Sofi ofrece el examen de la vista (`OPTICAL_AGENT_TEXTS.visit`).
        if (faq.q === "¿Sofi manda la lista de precios?")
          return { ...faq, a: faq.a.replace("y después ofrece una evaluación", "y después ofrece un examen de la vista") }
        return faq
      }),
  }),
  // Lo que vende una óptica, no lo de un consultorio dental. «Lentes» no va en sus búsquedas ni en
  // una pregunta: el buscador la lee como «lento» («el sistema está lento» no es una pregunta del inventario).
  inventario: (topic) => ({
    ...topic,
    terms: [
      ...topic.terms.filter((term) => term !== "guantes" && term !== "resina" && term !== "anestesia"),
      "monturas",
      "lunas",
      "estuches",
      "gotas",
    ],
    faqs: (topic.faqs ?? []).map((faq) =>
      faq.q === "¿Cómo vendo un cepillo o un enjuague?" ? { ...faq, q: "¿Cómo vendo una montura o un estuche?" } : faq,
    ),
  }),
  // Sin presupuesto que aceptar, el embudo va de venir a pagar (`funnelStepsOf`).
  reportes: (topic) => ({
    ...topic,
    faqs: (topic.faqs ?? []).map((faq) =>
      faq.q === "¿Qué es «Dónde se caen los pacientes»?"
        ? {
            ...faq,
            a: faq.a
              .replace(
                "vinieron (una cita atendida o una atención firmada), recibieron presupuesto, lo aceptaron (del todo o en parte) y, además, pagaron algo",
                "vinieron (una cita atendida o una atención firmada) y, además, pagaron algo",
              )
              .replace(
                "agendar, recibir el presupuesto y aceptarlo son los mismos momentos de Oportunidades",
                "agendar es el mismo momento de Oportunidades",
              ),
          }
        : faq,
    ),
  }),
  organizacion: (topic) => ({
    ...topic,
    faqs: (topic.faqs ?? []).map((faq): Faq => {
      if (faq.q === "¿Puedo poner el color de mi clínica?")
        return { ...faq, a: faq.a.replace("las recetas, órdenes, descansos y consentimientos", "las recetas, órdenes y consentimientos") }
      // Lo del ojo primero (`opticalDiagnosisPattern`); el ojo se escribe en la nota, sin «dónde».
      if (faq.q === "¿Cómo elijo el diagnóstico de una atención?")
        return {
          q: faq.q,
          a: "Con lo que propone la atención, con los más usados en tu clínica o con el buscador de toda la lista, que no distingue tildes ni mayúsculas y muestra primero los del ojo. En una sesión o un control, propone el diagnóstico del tratamiento que continúa; nada entra solo: «Usar» lo registra con el tipo de la última vez o, si nunca se registró, te pide el tipo. El ojo se escribe en la nota del diagnóstico. «Presuntivo» basta para cerrar. Si la persona ya tenía ese diagnóstico, el sistema lo anota solo como «Ya diagnosticado antes».",
        }
      return faq
    }),
  }),
  equipo: (topic) => ({ ...topic, terms: [...topic.terms, "optometrista"] }),
  disponibilidad: (topic) => ({
    ...topic,
    terms: topic.terms.filter((term) => term !== "sillones" && term !== "sillón"),
  }),
  // Las tres con que nace una óptica (`OPTICAL_SPECIALTIES`); la terapia visual se busca como servicio.
  especialidades: (topic) => ({
    ...topic,
    terms: [
      "optometría",
      "contactología",
      ...topic.terms.filter((term) => !["ortodoncia", "endodoncia", "periodoncia", "pediatría"].includes(term)),
    ],
  }),
}

function opticalTopic(topic: HelpTopic): HelpTopic {
  const worded: HelpTopic = {
    ...topic,
    purpose: say(topic.purpose),
    terms: topic.terms.map(say),
    ...(topic.faqs ? { faqs: topic.faqs.map((faq) => ({ ...faq, q: say(faq.q), a: say(faq.a) })) } : {}),
  }
  return EDITS[topic.id]?.(worded) ?? worded
}

/** La guía de la Ayuda en vistIA. */
export const OPTICAL_HELP_TOPICS: readonly HelpTopic[] = HELP_TOPICS.map(opticalTopic)
