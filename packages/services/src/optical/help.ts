import { SHARED_HELP_TOPICS, type HelpFaq, type HelpTopic } from "../help-guide.js"

/*
 * ---------- La guía de la Ayuda en vistIA ----------
 *
 * La misma guía de odentIA, como la de latidIA (`medical/help.ts`): las mismas
 * pantallas con las palabras de una óptica (optómetra, sala de examen) y sin lo
 * que una óptica no tiene: el odontograma, la pieza, el visor de tomografías en
 * cortes, el dictado de Clío, el riesgo anestésico ni el descanso médico. Lo
 * indicado queda aceptado al indicarlo, como en latidIA, y se invita a volver al
 * año, al control anual de la vista. El examen de la vista y la receta de lentes
 * tienen sus preguntas en Pacientes, y «Pedidos» es una pantalla que solo tiene una
 * óptica (`OPTICAL_ONLY_TOPICS`). Ventas y Taller son roles de vistIA (ADR 0171): donde
 * la guía dice quién puede, Ventas va con recepción y con caja (`SALES_TOO`).
 *
 * Capas, en este orden: las palabras (`WORDS`), lo de cada tema (`EDITS`), lo de cada
 * respuesta por su nombre fijo (`BY_ID`) y, al final, lo que solo tiene una óptica
 * (`OWN_FAQS` y `OPTICAL_ONLY_TOPICS`).
 */

/** Las palabras que cambian en toda la guía. */
const WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/odentIA/g, "vistIA"],
  [/odentia/g, "vistia"],
  [/odontólogos/g, "optómetras"],
  [/odontólogo/g, "optómetra"],
  [/Caja y odontología/g, "Caja y los optómetras"],
  // Antes que «unidad dental»: el presupuesto se arma en la consulta, no «en la sala de examen».
  [/en la unidad dental/g, "en la consulta"],
  [/unidades dentales/g, "salas de examen"],
  [/unidad dental/g, "sala de examen"],
  [/en su sala o unidad/g, "en su sala de examen"],
]

const say = (text: string) =>
  WORDS.reduce((out, [word, replacement]) => out.replace(word, replacement), text)

type Faq = HelpFaq

const withoutForms = (faq: Faq, ...drop: string[]): Faq =>
  faq.forms ? { ...faq, forms: faq.forms.filter((form) => !drop.includes(form)) } : faq

/**
 * Cambia un trozo de una respuesta heredada. Si la base ya no lo dice, falla al
 * cargar: el texto de odentIA no vuelve a la guía de vistIA sin que nadie lo vea.
 */
function swap(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`La guía de vistIA cambia «${from}», que la guía base ya no dice`)
  return text.replace(from, to)
}

const swaps = (text: string, ...pairs: Array<readonly [from: string, to: string]>) =>
  pairs.reduce((out, [from, to]) => swap(out, from, to), text)

/**
 * Donde la guía dice quién puede, Ventas también: tiene los permisos de recepción
 * (pacientes, agenda, contactos y oportunidades, conversaciones, tareas) y cobra
 * como caja, sin cerrarla (`packages/auth/src/permissions.ts`). Son las frases de
 * la base, enteras; lo que solo es de caja (cerrar) o de quien administra no cambia.
 */
const SALES_TOO: ReadonlyArray<readonly [string, string]> = [
  ["recepción y Administración", "recepción, Ventas y Administración"],
  ["recepción o Administración", "recepción, Ventas o Administración"],
  ["recepción, el propietario y el administrador", "recepción, Ventas, el propietario y el administrador"],
  ["Recepción, el propietario y el administrador", "Recepción, Ventas, el propietario y el administrador"],
  ["recepción, propietario y administrador", "recepción, Ventas, propietario y administrador"],
  ["recepción, el optómetra y Administración", "recepción, Ventas, el optómetra y Administración"],
  ["caja y Administración", "caja, Ventas y Administración"],
  ["Lo ven caja, la dueña y la administración", "Lo ven caja, Ventas, la dueña y la administración"],
  ["Recepción, quien atiende y caja los ven", "Recepción, Ventas, quien atiende y caja los ven"],
  ["recepción, la de cualquiera", "recepción y Ventas, la de cualquiera"],
  ["cuando recepción marca que llegó tu paciente", "cuando recepción o Ventas marca que llegó tu paciente"],
]

const withSales = (text: string) => SALES_TOO.reduce((out, [phrase, withRole]) => out.replaceAll(phrase, withRole), text)

/** Lo que la página de una persona cuenta distinto en una óptica, por pregunta; sin entrada, queda igual. */
const PATIENT_FAQS: Record<string, (faq: Faq) => Faq[]> = {
  // Sin odontograma ni pieza, sin dictado y sin visor de tomografías en cortes.
  "¿Dónde registro un hallazgo del odontograma?": () => [],
  "¿Por qué la pieza quedó dibujada después del tratamiento?": () => [],
  "¿Cómo se firma el odontograma?": () => [],
  "¿Cómo dicto una atención?": () => [],
  "¿Para qué es «Guardar en tu atención de hoy» en la tomografía?": () => [],
  // Las piezas son de odentIA: ni el aviso del tratamiento para otras piezas ni «va después» en la misma pieza.
  "¿Por qué me avisa que el tratamiento es para otras piezas?": () => [],
  "¿Por qué la corona dice «va después de terminar» la endodoncia?": () => [],
  // Lo indicado ya queda aceptado: lo que falta es su cita.
  "¿Dónde veo sus alergias, qué le toca y su última atención?": (faq) => [
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
        // Una óptica no anestesia: arriba no va la ASA (`showsAsa`).
        ["alergias, enfermedades, medicación y ASA", "alergias, enfermedades y medicación"],
      ),
    },
  ],
  // Sus cuatro secciones (`opticalUi.record`: «Recetas de lentes» va después de Antecedentes) y sus filtros (`documentFilters`).
  "¿Dónde quedaron Atenciones, Recetas u Órdenes?": (faq) => [
    {
      ...faq,
      a: `${swaps(
        faq.a,
        ["Antecedentes, Odontograma (con el Periodontograma debajo), Historia y Documentos", "Antecedentes, Recetas de lentes, Historia y Documentos"],
        [" En el celular, la lista de hallazgos va justo debajo del odontograma.", ""],
        [
          "(presupuestos, recetas, órdenes, consentimientos, formularios, imágenes, otros archivos y, en clínicas de Perú, odontogramas)",
          "(presupuestos, recetas, órdenes, consentimientos, formularios, imágenes y otros archivos)",
        ],
      )} La receta de lentes (la medida) está en «Recetas de lentes»; la de gotas u otro medicamento, en Documentos.`,
      forms: [...(faq.forms ?? []), "donde estan las recetas de lentes", "no encuentro la medida que le di"],
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
          .replace(
            " Si lo indicas desde la pieza del odontograma, el panel también pide «Sesiones previstas» con las habituales del servicio, y «Cambiar» un tratamiento indicado hoy por otro también las pide, con las habituales del nuevo, y lo pasa a la fase que le toca (una exodoncia cambiada por una endodoncia deja la cirugía).",
            " «Cambiar» un tratamiento indicado hoy por otro también pide sus sesiones, con las habituales del nuevo.",
          )
          // Resolver el diagnóstico de la pieza al firmar es de odentIA.
          .replace(
            " Si su tratamiento resuelve un diagnóstico de esa pieza (la pulpitis de la 46 con su endodoncia), el cierre lo propone marcado como resuelto: desmárcalo si sigue activo. Una periodontitis apical o un absceso periapical vienen sin marcar: sanan en su control con radiografía, que queda indicado al año al terminar la endodoncia.",
            "",
          )
          .replace(" (la de una endodoncia busca hora desde una semana después, para que actúe la medicación)", "")
          .replace(" («Corona · sesión 1 de 2: mar 10 nov, 9:00 · la sesión 2 se reserva en esa cita»)", "")
          .replace("en curso en esa pieza,", "en curso,")
          .replace("va antes que lo aceptado sin empezar", "va antes que lo indicado sin empezar"),
      },
      "endodoncia en dos sesiones",
    ),
  ],
  "¿Dónde hago la receta, el consentimiento o la orden de la atención?": (faq) => [
    { ...faq, a: faq.a.replace("(pieza, diagnóstico, procedimiento y quien atiende)", "(diagnóstico, procedimiento y quien atiende)") },
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
        )
        .replace("(lo aceptado, o lo que indicaste hoy)", "(lo que indicaste hoy o antes)")
        .replace("tiene algo aceptado sin empezar", "tiene algo indicado sin empezar")
        .replace("Lo aceptado se reserva sin esperar al control", "Lo indicado se reserva sin esperar al control"),
    },
  ],
  // Una sola fase: el plan no habla de fases.
  "¿Dónde está el plan de tratamiento?": (faq) => [
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
        a: "Sí, en su Plan, con «Duplicar como otra opción»: copias la opción y cambias lo que haga falta. Cada opción tiene su total (nunca se suman) y una va recomendada: nace la primera y se cambia con «Marcar como recomendada», en el Plan o en «Revisar y enviar». Es la que la persona ve marcada, aunque «Lo que le proponemos» diga otra cosa: «Antes de enviar» te recuerda cuál es. Si ya se lo entregaste, se cambia con «Crear revisión», no con «Anular presupuesto»: la revisión conserva el número y en ella la marcas. Lo cambia quien lo preparó. Al anotar la respuesta no hace falta que elija: lo que va en todas se acepta y lo de cada opción puede quedar para después.",
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
        .replace("Si escribes o dictas otro", "Si escribes otro"),
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
      id: "oct",
      area: "clinica",
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
    {
      ...faq,
      a: swap(faq.a, "quien tiene algo aceptado sin una cita", "quien tiene algo indicado sin una cita")
        .replace("no vino en 6 meses", "no vino en 12 meses")
        .replace("hace más de 6 meses", "hace más de 12 meses"),
    },
  ],
  // Además de lo de siempre, el cliente ve sus recetas de lentes y sus pedidos (`portalPapers`, «Tus pedidos»).
  "¿Qué ve el paciente en su portal?": (faq) => [
    {
      ...faq,
      a: faq.a
        .replace(
          "Recetas y órdenes (con su resultado) desde que se emiten;",
          "Recetas y órdenes (con su resultado) desde que se emiten; sus recetas de lentes (la externa, desde que un optómetra la verifica); sus pedidos, en «Tus pedidos», junto a su cuenta;",
        )
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

/**
 * El examen de la vista y la receta de lentes (entrega 3 del plan): cómo se anotan,
 * se emiten, se imprimen y se transcriben, con los nombres de sus botones.
 */
const EYE_FAQS: Faq[] = [
  {
    id: "anoto-examen-vista",
    q: "¿Cómo anoto el examen de la vista?",
    a: "En la atención, en «Examen de la vista»: quién acompaña si es menor, si ya usa lentes, la agudeza visual de cada ojo sin y con corrección, de lejos y de cerca (20/20, 20/25+1, 0,8, CD 1 m y, de cerca, también J1, N5 o 0,5M), la refracción (esfera, cilindro, eje, adición y prisma; si el prisma es compuesto, el segundo va en el otro eje), la distancia pupilar de cada ojo y, si la mides, la binocular de lejos y de cerca, y la salud del ojo, con la presión si la mides. Si algo conviene que lo vea un oftalmólogo, como la presión alta o una vista que no mejora con lentes, te lo dice ahí mismo; tú decides si lo derivas con una orden de interconsulta.",
    forms: ["como anoto la medida de la vista", "donde pongo la graduacion", "como registro la refraccion", "donde va la agudeza visual"],
    area: "clinica",
    needs: "clinical.write",
  },
  {
    id: "emito-receta-lentes",
    q: "¿Cómo emito la receta de lentes?",
    a: "Con la refracción del examen guardada, en «Receta de lentes» de la atención: «Emitir receta de anteojos», o «Emitir receta de lentes de contacto», que trae la graduación llevada al ojo (desde 4 dioptrías cambia: un −8,00 de anteojos es un −7,25 de contacto) y sin prisma, para que la revises, y pide la curva base, el diámetro y la marca de cada ojo. La firmas tú, con tu colegiatura del perfil profesional. Queda en «Recetas de lentes» de su ficha: ahí se imprime con «Imprimir», con su código QR para comprobarla, y el cliente la ve en su portal.",
    forms: ["como hago la receta de lentes", "como imprimo la receta de lentes", "como le doy la medida al cliente", "receta de anteojos"],
    area: "clinica",
    needs: "clinical.write",
  },
  {
    id: "receta-trae-oftalmologo",
    q: "¿Qué hago con la receta que trae de su oftalmólogo?",
    a: "En «Recetas de lentes» de su ficha, «Transcribir receta externa»: la graduación de cada ojo (con el prisma, si es de anteojos), la distancia pupilar si la dice, la fecha, quién la firmó y la foto de la receta, que queda entre sus documentos. Queda «Sin verificar» hasta que un optómetra la revise con «La revisé: verificar», y recién entonces el cliente la ve en su portal.",
    forms: ["receta externa", "trae receta del oftalmologo", "como registro una receta de afuera"],
    area: "clinica",
    needs: "clinical.write",
  },
  {
    id: "equivoque-receta-emitida-corrijo",
    q: "¿Me equivoqué en una receta ya emitida, cómo la corrijo?",
    a: "Una receta emitida no se edita: en «Recetas de lentes» de su ficha, «Anular» con el motivo. Si era de un examen, quien la firmó tiene en «Anteriores» «Emitir otra desde su examen», con la graduación escrita para corregirla, aunque la atención ya esté firmada. Si la receta se anuló porque se anuló su atención, esa atención ya no emite otra: se emite desde una atención nueva.",
    forms: ["corregir receta de lentes", "me equivoque en la receta", "como cambio una receta emitida"],
    area: "clinica",
    needs: "clinical.write",
  },
  {
    id: "pasa-receta-vencio",
    q: "¿Qué pasa si su receta venció?",
    a: "Una receta de lentes vale 12 meses desde su fecha, y cada una dice hasta cuándo. Vencida, su ficha y la venta avisan que conviene un examen nuevo y no impiden nada: tú decides si lo examinas otra vez. Lo mismo una externa sin verificar.",
    forms: ["receta vencida", "cuanto dura una receta de lentes", "hasta cuando vale la medida"],
    area: "clinica",
    needs: "clinical.read",
  },
]

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
    terms: [
      ...topic.terms.filter((term) => term !== "odontograma"),
      "pruebas del ojo",
      "examen de la vista",
      "medida de la vista",
      "graduación",
      "receta de anteojos",
      "receta externa",
    ],
    faqs: [...(topic.faqs ?? []).flatMap((faq) => PATIENT_FAQS[faq.q]?.(faq) ?? [faq]), ...EYE_FAQS],
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
          id: "dictar-atencion",
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
        // Los ejemplos de la base son de una endodoncia.
        if (faq.q === "¿Qué son la espera entre sesiones y los controles al terminar?")
          return {
            ...faq,
            a: swaps(
              faq.a,
              ["(por ejemplo, una semana para que actúe una medicación)", "(por ejemplo, una semana entre las sesiones de terapia visual)"],
              ["como un control radiográfico al año", "como un control al mes de terminar"],
            ),
          }
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
    faqs: (topic.faqs ?? []).map((faq): Faq => {
      // La montura se vende con su pedido (`opticalOrders.lineKinds`); lo suelto, por mostrador o en la cuenta.
      if (faq.q === "¿Cómo vendo un cepillo o un enjuague?")
        return {
          ...faq,
          q: "¿Cómo vendo una montura o un estuche?",
          a: "Márcalo con «Se vende» y ponle su precio de venta. La montura que va con sus lunas se vende con su pedido: en Pedidos, «Vender lentes», en «Lo que lleva», «Montura» la busca en el inventario. Lo suelto, como un estuche, se vende en Finanzas › Caja o Cobros, «Venta de mostrador», o en «Cobrar» › «Agregar producto» si va a la cuenta de un paciente; si lo quitas de la cuenta o anulas el ticket, vuelve a la sede.",
          forms: [...(faq.forms ?? []), "como saco una montura del stock al venderla", "vender un estuche suelto"],
        }
      // Ventas tiene el inventario con precios y recibe lo que llega (`inventory.read`, `inventory.receive`).
      if (faq.q === "¿Quién puede recibir lo que llega?")
        return {
          ...faq,
          a: swap(
            faq.a,
            "Recepción ve el inventario sin precios, registra lo que llegó y el uso fuera de una atención.",
            "Recepción ve el inventario sin precios y Ventas con precios; los dos registran lo que llegó y el uso fuera de una atención.",
          ),
        }
      return faq
    }),
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
      // Lo del ojo primero (`opticalDiagnosisPattern`); el ojo se escribe en la nota, sin «dónde».
      if (faq.q === "¿Cómo elijo el diagnóstico de una atención?")
        return {
          id: faq.id,
          q: faq.q,
          a: "Con lo que propone la atención, con los más usados en tu clínica o con el buscador de toda la lista, que no distingue tildes ni mayúsculas y muestra primero los del ojo. En una sesión o un control, propone el diagnóstico del tratamiento que continúa; nada entra solo: «Usar» lo registra con el tipo de la última vez o, si nunca se registró, te pide el tipo. El ojo se escribe en la nota del diagnóstico. «Presuntivo» basta para cerrar. Si la persona ya tenía ese diagnóstico, el sistema lo anota solo como «Ya diagnosticado antes».",
        }
      return faq
    }),
  }),
  equipo: (topic) => ({
    ...topic,
    terms: [...topic.terms, "optometrista", "ventas", "vendedor", "vendedora", "taller", "tallerista"],
  }),
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

/**
 * Lo que una respuesta heredada dice distinto en una óptica, por su nombre fijo; sin
 * entrada, queda igual. Lo indicado queda aceptado al indicarlo y el plan tiene una sola
 * fase (`optical/hooks.ts`); Clío no dicta (`dictation: null`).
 */
const BY_ID: Record<string, (faq: Faq) => Faq[]> = {
  // Sin dictado no hay sugerencias que corregir ni página de Clío donde probarlo.
  "pacientes-dictado-corregir-pausar": () => [],
  "agente-clio-probar-dictado": () => [],
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
  "ofrecer-dos-opciones": (faq) => [withoutForms(faq, "dos caminos")],
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
  // Cada cuánto puede repetirse un control, como el control anual de la vista (`FOLLOW_UP_REPEAT_MONTHS`).
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
  // Los roles de una óptica: los de siempre y los dos suyos (`PRODUCT_ROLES`).
  "equipo-roles": (faq) => [
    { ...faq, a: `${faq.a} En una óptica hay además Ventas, que atiende el mostrador, vende y cobra, y Taller, que solo ve los pedidos.` },
  ],
  // Lo que propone el perfil profesional en Perú (`opticalProfessionalFor`).
  "equipo-colegiatura": (faq) => [
    { ...faq, a: `${faq.a} En Perú vienen propuestos «Tecnólogo médico en optometría» y el CTMP, y se pueden cambiar.` },
  ],
}

/** Lo que solo tiene una óptica en las pantallas de siempre, por tema; lo del pedido va en su tema (`OPTICAL_ONLY_TOPICS`). */
const OWN_FAQS: Record<string, Faq[]> = {
  pacientes: [
    {
      id: "pacientes-recetas-lentes-quien",
      q: "¿Quién ve las recetas de lentes y quién puede transcribir o anular una?",
      a: "«Recetas de lentes», en su página › Clínica, es de quien lee la historia clínica: el optómetra, administración y la dueña la ven y la imprimen con «Imprimir»; transcribir la externa, verificarla y anularla es de quien escribe en la historia. Ventas no ve esa sección: ve la receta vigente al vender, en «Vender lentes». El cliente la tiene en su portal.",
      forms: ["no me sale transcribir receta externa", "no veo las recetas de lentes", "el cliente pide que le imprima su medida"],
      area: "clinica",
      needs: "clinical.read",
    },
    {
      id: "pacientes-receta-gotas",
      q: "¿Dónde receto unas gotas?",
      a: "En la atención, en el bloque «Documentos», «Nuevo» › «Receta»: es la receta de medicamentos, con lágrimas artificiales y lo del ojo rojo o alérgico en su lista; lo que no está se escribe. La receta de lentes (la medida) es otra: sale del bloque «Receta de lentes», con la refracción guardada.",
      forms: ["como receto gotas", "receta de medicamentos en la optica", "la receta de anteojos esta en documentos"],
      area: "clinica",
      needs: "clinical.write",
    },
    {
      id: "pacientes-receta-lentes-enviar",
      q: "¿Cómo le mando su receta de lentes por WhatsApp?",
      a: "La receta de lentes no se envía desde la ficha: en «Recetas de lentes», «Imprimir» la abre en PDF para dársela o guardarla, y el cliente la ve y la descarga en su portal. «Enviar» es de la receta de medicamentos y de la orden.",
      forms: ["enviar la medida al cliente", "no veo enviar en la receta de lentes", "mandar la receta de anteojos"],
      area: "clinica",
      needs: "clinical.read",
    },
    {
      id: "pacientes-salud-ojo-oftalmologo",
      q: "¿Por qué me dice que conviene que lo vea un oftalmólogo?",
      a: "En «Examen de la vista», «Salud del ojo» anota el examen externo, las pupilas y el fondo de ojo (sin alteraciones, con hallazgos o no realizado) y la presión, si la mides. «Conviene que lo vea un oftalmólogo» sale con una presión mayor de 21 mmHg, con hallazgos en las pupilas o en el fondo de ojo, o si con corrección no llega a 20/40. Solo informa: tú decides si lo derivas. Lo de la familia o sus cirugías va en «Lo que importa para la vista».",
      forms: ["que pongo en salud del ojo", "donde anoto que tiene glaucoma en la familia", "aviso de oftalmologo en el examen"],
      area: "clinica",
      needs: "clinical.write",
    },
  ],
  inventario: [
    {
      id: "inventario-montura-marca-modelo",
      q: "¿Dónde pongo la marca y el modelo de una montura?",
      a: "Al crear o editar el producto, en Inventario › Productos, abre «Más datos»: «Código de barras» (pásale el lector), «Marca», «Modelo», «Color» y «Medidas». Con eso la encuentras al vender por marca o modelo, o escaneándola. Lo hacen la dueña y la administración.",
      forms: ["puedo usar lector de codigo de barras", "dos monturas iguales de otro color", "codigo de barras de un producto"],
      needs: "inventory.write",
    },
  ],
  equipo: [
    {
      id: "roles-hay-optica",
      q: "¿Qué roles hay en una óptica?",
      a: "Además de los de siempre, dos de las ópticas. Ventas atiende el mostrador: registra a los clientes, lleva la agenda, las conversaciones y las tareas, vende y cobra, ve el inventario con precios y los pedidos, y ve la receta de lentes vigente sin el resto de la historia clínica. Taller ve los pedidos con sus medidas y la copia de la receta con que se hacen, y marca cómo van; nada más de la óptica. Se eligen al invitar o en «Cambiar rol».",
      forms: ["que hace el rol ventas", "que ve el taller", "rol para el vendedor", "rol para el que hace los lentes", "roles de una optica"],
    },
    {
      id: "equipo-ventas-no-puede",
      q: "¿Ventas puede cerrar la caja?",
      a: "No: Ventas vende y cobra, pero «Cerrar caja» es de Caja, de administración y de la dueña. Tampoco ve la historia clínica, salvo la receta de lentes vigente al vender.",
      forms: ["no me deja cerrar caja siendo ventas", "que no puede hacer el vendedor", "ventas ve la historia clinica"],
    },
  ],
  tareas: [
    {
      id: "tareas-ventas-taller",
      q: "¿Qué tareas ven Ventas y Taller?",
      a: "En Tareas, «Mías y de mi área»: Ventas ve las suyas y las que no tienen responsable del equipo de recepción y de caja. Taller ve solo las que llevan su nombre.",
      forms: ["que tareas ve el taller", "ventas ve las tareas de caja", "no veo tareas de mi area"],
    },
  ],
  whatsapp: [
    {
      id: "whatsapp-mensaje-pedido-listo",
      q: "¿Dónde cambio el mensaje de pedido listo?",
      a: "En Configuración › Integraciones › WhatsApp, entre los mensajes, «Pedido listo»: es el que sale cuando alguien marca listo un pedido. Se cambia como los demás, con «Editar el texto», y WhatsApp lo revisa antes de usarlo.",
      forms: ["mensaje de pedido listo", "plantilla de pedido listo", "cambiar el aviso de pedido listo"],
    },
  ],
  formularios: [
    {
      id: "formularios-consentimientos-optica",
      q: "¿Qué consentimientos trae vistIA?",
      a: "Dos: «Dilatación de las pupilas», que se pide con el examen de la vista y la retinografía, y «Adaptación de lentes de contacto», con la adaptación y su control. Son textos de partida para que un profesional los revise; se leen y se cambian en Configuración › Consentimientos.",
      forms: ["hay consentimiento para dilatar la pupila", "consentimiento de lentes de contacto", "consentimientos que vienen con vistia"],
    },
  ],
  especialidades: [
    {
      id: "especialidades-trae-optica",
      q: "¿Qué especialidades trae vistIA?",
      a: "Tu óptica nace con tres: Optometría (el examen, las pruebas especiales y los anteojos con su taller), Contactología (los lentes de contacto) y Terapia visual. Es la lista general de vistIA, no la norma de un país. En Configuración › Especialidades, «Editar» dice quién atiende cada una y «Agregar especialidad» crea otra.",
      forms: ["quien atiende la terapia visual", "a que especialidad va el taller", "con que especialidades empieza la optica"],
    },
  ],
}

/** Los nombres de `BY_ID` que la guía base sí trae: uno que ya no existe detiene el arranque. */
const edited = new Set<string>()

function opticalTopic(topic: HelpTopic): HelpTopic {
  const worded: HelpTopic = {
    ...topic,
    purpose: say(topic.purpose),
    terms: topic.terms.map(say),
    ...(topic.faqs ? { faqs: topic.faqs.map((faq) => ({ ...faq, q: say(faq.q), a: withSales(say(faq.a)) })) } : {}),
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

/** Lo que se pregunta del pedido además de venderlo y marcarlo: dónde se ve, quién puede y qué lleva. */
const MORE_ORDER_FAQS: Faq[] = [
  {
    id: "pedidos-entregados-buscar",
    q: "¿Dónde veo los pedidos ya entregados o anulados?",
    a: "En Pedidos, las pestañas «Abiertos», «Atrasados», «Listos», «Entregados» y «Anulados». El buscador encuentra por número, persona, qué es o quién lo hace.",
    forms: ["como busco un pedido por su numero", "donde estan los pedidos anulados", "pedidos entregados"],
    needs: "orders.read",
  },
  {
    id: "pedidos-de-un-cliente",
    q: "¿Dónde veo los pedidos de un cliente?",
    a: "En su página › Cobros › «Pedidos»: cada pedido con su número, cómo va y para cuándo se prometió. Tocarlo lo abre en Pedidos, y quien vende tiene ahí mismo «Vender lentes». Lo ve quien ve los pedidos.",
    forms: ["pedidos de una persona", "como se si le hicimos un pedido", "ya estan los lentes de un cliente"],
    needs: "orders.read",
  },
  {
    id: "pedidos-quien-vende-quien-marca",
    q: "¿Quién puede vender lentes y quién marca los pasos?",
    a: "Venden, rehacen y anulan quienes llevan los pedidos y la caja: Ventas, Caja, administración y la dueña. Los pasos los marca y el aviso lo reenvía quien lleva los pedidos, también Taller, que no ve importes. Recepción y el optómetra ven cómo va, sin cambiarlo.",
    forms: ["por que no me sale vender lentes", "el taller puede anular un pedido", "quien puede vender"],
    needs: "orders.read",
  },
  {
    id: "pedidos-sin-receta",
    q: "¿Puedo vender sin receta?",
    a: "Sí: en «Vender lentes», en «Receta», elige «Sin receta»; si la persona no tiene una vigente, el pedido va sin ella. La receta la copia quien puede verla: Ventas, administración y la dueña. A Caja le dice «la agrega quien la ve» y vende sin ella.",
    forms: ["no me aparece la receta al vender", "pedido sin receta", "vender unos lentes de sol con pedido"],
  },
  {
    id: "pedidos-montura-lunas-medidas",
    q: "¿Cómo agrego la montura y las lunas al pedido?",
    a: "En «Vender lentes», en «Lo que lleva»: «Montura» y «Lentes de contacto» se buscan en el inventario por nombre, marca o modelo, o pasando el lector por su código de barras; «Lunas» y «Otro» se escriben con su precio. En «Medidas para montar» van «Altura OD» y «Altura OI», en milímetros, si las tienes.",
    forms: ["puedo escanear la montura", "donde pongo la altura de montaje", "como vendo lentes de contacto"],
  },
  {
    id: "pedidos-adelanto-varios-medios",
    q: "¿Puede dejar el adelanto con dos medios de pago?",
    a: "Sí: en «Vender lentes», en el adelanto, eliges el primer medio y «Agregar otro medio» suma hasta tres; en efectivo escribes lo que te da en «Recibes en efectivo». Al guardar, el aviso trae «Ver el ticket». Con varias sedes, «Se vende en» dice en cuál.",
    forms: ["adelanto con yape y efectivo", "donde veo el ticket del adelanto", "vender lentes en otra sede"],
  },
  {
    id: "pedidos-sin-ficha",
    q: "¿Puedo hacerle un pedido a alguien que no está registrado?",
    a: "No: el pedido va a nombre de un paciente. Regístralo primero con «Nuevo paciente» y después véndele. Lo que no necesita pedido se vende sin ficha en Finanzas › Caja o Cobros, «Venta de mostrador».",
    forms: ["cliente nuevo quiere lentes", "vender lentes sin ficha", "pedido para quien no es paciente"],
  },
  {
    id: "pedidos-no-veo-receta",
    q: "¿Por qué no veo la receta en el pedido?",
    a: "La copia de la receta la ven quien hace el pedido (Taller), Ventas y quien lee la historia clínica; a recepción y a caja el pedido les dice «Va con el pedido; la ve quien lo hace». Cada vez que alguien la ve queda en «Consultas a la historia clínica» de esa persona.",
    forms: ["dice que la ve quien lo hace", "el taller ve la historia", "no me sale la receta del pedido"],
    needs: "orders.read",
  },
  {
    id: "pedidos-que-significa-cada-paso",
    q: "¿Qué significa cada paso de un pedido?",
    a: "«Por enviar»: vendido, todavía no va al laboratorio. «En laboratorio»: se está haciendo. «Por revisar»: llegó y falta comprobarlo. «Listo»: se puede entregar. Después, «Entregado» o «Anulado». Si dice «se rehízo», ese ya no se trabaja: sigue en el pedido nuevo, que se abre desde ahí.",
    forms: ["que es por revisar", "que es se rehizo", "por que este pedido no tiene boton"],
    needs: "orders.read",
  },
]

/** Lo que solo tiene una óptica: sus pantallas, que no están en la guía de odentIA. */
const OPTICAL_ONLY_TOPICS: readonly HelpTopic[] = [
  {
    id: "pedidos",
    path: "/orders",
    title: "Pedidos",
    parent: null,
    purpose:
      "Los lentes que se encargaron al laboratorio o al taller propio, del que vence antes al que vence después: en qué paso está cada uno (por enviar, en laboratorio, por revisar, listo o entregado), para cuándo se le prometió a la persona y, para quien ve la caja, cuánto le falta pagar. «Atrasados» junta los que pasaron su fecha sin estar listos. Cada pedido se abre al lado con lo que lleva, la copia de la receta con que se hace, las medidas para montar y quién marcó cada paso. Desde aquí se vende con «Vender lentes».",
    terms: [
      "pedidos",
      "pedido de lentes",
      "trabajos",
      "laboratorio",
      "taller",
      "orden de trabajo",
      "lentes listos",
      "estado del pedido",
      "saldo",
      "adelanto",
      "vender lentes",
      "rehacer lentes",
      "garantia",
      "atrasados",
    ],
    writePermission: "orders.write",
    faqs: [
      {
        id: "vendo-unos-lentes",
        q: "¿Cómo vendo unos lentes?",
        a: "En Pedidos, «Vender lentes» (también en su página › Cobros › «Pedidos»): para quién, la receta (la vigente; si venció o no se verificó te lo dice, no lo impide), lo que lleva (la montura del inventario y las lunas con su precio), las medidas para montar, qué es, quién lo hace, para cuándo y el adelanto con su medio de pago, o «Sin adelanto». El adelanto se cobra en la caja de siempre y el pedido queda «Por enviar», con una copia de la receta para el taller. Venden Ventas, Caja, administración y la dueña. «Vender con esta receta», en «Recetas de lentes» de la ficha, solo le aparece a quien además lee la historia clínica: administración y la dueña.",
        forms: ["como vendo lentes", "como hago una venta de anteojos", "como registro el adelanto", "como encargo los lentes al laboratorio", "no me sale vender con esta receta"],
      },
      {
        id: "marco-va-pedido",
        q: "¿Cómo marco cómo va un pedido?",
        a: "Ábrelo: el botón dice el paso que sigue, «Enviado al laboratorio», «Llegó del laboratorio», «Revisado: está listo» o «Entregar». Si el taller propio no pasa por el laboratorio, «Marcar listo» en «…». Cada paso dice quién lo marcó y cuándo, y no se vuelve atrás: si algo salió mal, se rehace.",
        forms: ["como marco que llegaron los lentes", "como paso el pedido a listo", "como entrego los lentes", "en que paso esta el pedido"],
      },
      {
        id: "avisa-lentes-estan-listos",
        q: "¿Se le avisa cuando sus lentes están listos?",
        a: "Sí: al marcar el pedido listo le llega «Tus lentes ya están listos para recoger», por WhatsApp con su mensaje aprobado, escrito si te escribió en las últimas 24 horas, o por correo. El pedido dice en «Aviso de que está listo» si salió, si llegó, si falló o si no se sabe. Si no salió o falló, «Enviar el aviso»; si no se sabe si llegó, confírmalo con la persona antes de «Enviarlo otra vez», para que no le llegue dos veces.",
        forms: ["se le avisa que sus lentes estan listos", "como le aviso que ya estan sus lentes", "mensaje de lentes listos", "no le llego el aviso"],
      },
      {
        id: "sofi-responde-estan-lentes",
        q: "¿Sofi responde si ya están sus lentes?",
        a: "Sí: le dice en qué paso está su pedido y para cuándo se le prometió. Cuánto le falta pagar solo se lo dice a la persona, a su representante o a quien paga por ella. Nunca le dice la receta.",
        forms: ["sofi dice si estan mis lentes", "el agente responde por el pedido", "cuanto me falta pagar sofi"],
      },
      {
        id: "cliente-ve-pedido-portal",
        q: "¿El cliente ve su pedido en su portal?",
        a: "Sí, en «Tus pedidos», junto a «Tu cuenta»: si ya está listo para recoger, para cuándo y lo que le falta pagar. Si su cuenta no se muestra en el portal, sus pedidos tampoco.",
        forms: ["el cliente ve su pedido", "pedido en el portal", "puede ver si estan sus lentes"],
      },
      {
        id: "falta-pagar-recogerlos",
        q: "¿Y si le falta pagar al recogerlos?",
        a: "El pedido listo dice cuánto falta y ofrece el cobro de siempre, el mismo de Cobros. Entregar no lo exige: tú decides.",
        forms: ["cobrar el saldo de los lentes", "cuanto le falta pagar de sus lentes", "pagar el resto del pedido"],
      },
      {
        id: "ve-bien-lentes-nuevos",
        q: "¿Qué hago si no ve bien con sus lentes nuevos?",
        a: "En el pedido, «…» › «Rehacer», con por qué se rehace y para cuándo: sale otro pedido unido al original, con lo mismo y sin cobrar otra vez; lo que faltaba pagar sigue en el nuevo, y el original queda reemplazado. Rehacer y anular son de quien lleva la caja.",
        forms: ["no ve bien con sus lentes", "rehacer un pedido", "garantia de los lentes", "se rompio la luna en el taller"],
      },
      {
        id: "anulo-pedido",
        q: "¿Cómo anulo un pedido?",
        a: "En el pedido, «…» › «Anular», con el motivo, mientras no se haya entregado. Cada cosa del pedido sin nada cobrado se anula con él y, si es la montura, vuelve al inventario. Lo que ya tiene algo cobrado (por ejemplo, la montura que cubrió el adelanto) queda en su cuenta, con lo que falta: tú decides desde Cobros si lo devuelves, lo cobras o lo anulas.",
        forms: ["cancelar un pedido", "anular la venta de lentes", "se arrepintio de los lentes"],
      },
      ...MORE_ORDER_FAQS,
    ],
  },
]

/** La guía de la Ayuda en vistIA: las pantallas de siempre, con lo de una óptica, y las suyas. */
export const OPTICAL_HELP_TOPICS: readonly HelpTopic[] = [...SHARED_HELP_TOPICS.map(opticalTopic), ...OPTICAL_ONLY_TOPICS]

const stray = [
  ...Object.keys(BY_ID).filter((id) => !edited.has(id)),
  ...Object.keys(OWN_FAQS).filter((id) => !SHARED_HELP_TOPICS.some((topic) => topic.id === id)),
]
if (stray.length > 0) throw new Error(`La guía de vistIA edita lo que la guía base ya no tiene: ${stray.join(", ")}`)
