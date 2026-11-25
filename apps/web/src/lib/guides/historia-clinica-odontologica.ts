// «Cómo llenar una historia clínica odontológica». Las partes siguen la copia de la historia que
// imprime la app (`patient-record-copy.ts`) y su plantilla en blanco (`blank-sheets.ts`). Lo
// práctico de llenarla, sin normas: la guía no dice qué exige la ley de cada país.
import type { Guide } from "./types"

export const guide: Guide = {
  slug: "historia-clinica-odontologica",
  topic: "Historia clínica",
  title: "Cómo llenar una historia clínica odontológica,",
  accent: "parte por parte.",
  name: "Cómo llenar una historia clínica odontológica",
  menu: "Historia clínica",
  seoTitle: "Historia clínica odontológica: formato PDF y cómo llenarla",
  description:
    "Cómo llenar una historia clínica odontológica: datos, motivo, antecedentes, examen, odontograma, diagnóstico y evolución. Formato en PDF gratis.",
  lead: "Qué va en cada parte, en el orden en que atiendes: de los datos del paciente a la evolución de cada visita. Con el formato en blanco en PDF.",
  updated: "2026-11-25",
  published: "2026-11-25",
  // Su lista en el canal: un video que se suma ahí aparece solo en la guía.
  playlist: "PLAdZkePtKV2U",
  video: {
    youtubeId: "ngFPnBO64ZE",
    title: "La primera atención de un paciente en odentIA: anamnesis, consulta, cobro y presupuesto",
    published: "2026-11-21T06:35:18+00:00",
  },
  short: [
    "Arriba, quién es: sus datos y, si es menor, quién lo acompaña. Un número de historia por paciente, para siempre.",
    "Después, por qué vino con sus palabras, sus antecedentes marcados uno por uno, el examen y el odontograma.",
    "Cierra con el diagnóstico, el plan y una línea de evolución por cada visita, con su firma.",
  ],
  steps: [
    {
      title: "Sus datos y su número de historia",
      text: [
        "Nombre completo, documento, fecha de nacimiento (la edad sale de ahí), teléfono, dirección y ocupación. Si es menor de edad, también su **responsable**: quién es, su documento y su parentesco.",
        "Cada paciente tiene **un solo número de historia**, el mismo en todas sus visitas. Si vuelve años después, se sigue en la misma: no se abre otra.",
      ],
    },
    {
      title: "Por qué vino, con sus palabras",
      text: [
        "El **motivo de consulta** se escribe como lo dice el paciente, entre comillas: «me duele la muela de abajo cuando tomo frío». Después, el **relato**: desde cuándo, cómo empezó, qué lo alivia o lo empeora y si tomó algo.",
      ],
      figure: {
        kind: "tabla",
        head: ["Parte", "Ejemplo"],
        rows: [
          ["Motivo", "«Me duele la muela de abajo cuando tomo frío»"],
          ["Desde cuándo", "Hace dos semanas"],
          ["Cómo es", "Dolor que dura segundos con lo frío; no lo despierta de noche"],
          ["Qué tomó", "Paracetamol, dos veces"],
        ],
      },
    },
    {
      title: "Sus antecedentes, todos con Sí o No",
      text: [
        "Pregunta uno por uno y marca **Sí, No o No sabe** en cada uno: un casillero vacío no dice si lo preguntaste. Lo que sea Sí lleva su detalle (qué medicamento, a qué es alérgico).",
      ],
      figure: {
        kind: "tabla",
        head: ["Pregunta", "Por qué importa"],
        rows: [
          ["¿Alergias? (anestesia, penicilina, látex)", "Cambia lo que le pones o le recetas"],
          ["¿Toma medicamentos? (anticoagulantes, para los huesos)", "Pueden hacerlo sangrar más o cambiar una extracción"],
          ["¿Diabetes, presión alta, algo del corazón?", "Cambian la anestesia y cómo cicatriza"],
          ["¿Algo del riñón o del hígado, gastritis o úlcera?", "Cambian los analgésicos y antibióticos que le recetas"],
          ["¿Defensas bajas, tuberculosis o VIH?", "Cambian los cuidados y cómo cicatriza"],
          ["¿Está embarazada o dando de lactar?", "Cambian los medicamentos; la radiografía se toma con protección y solo si hace falta"],
          ["¿Sangra mucho cuando se corta?", "Te prepara antes de una extracción"],
        ],
        caption: "Lo que cambia el plan se repasa antes de cada anestesia, no solo el primer día.",
      },
    },
    {
      title: "El examen y el odontograma",
      text: [
        "Anota los **signos vitales** que tomes (presión y pulso, como mínimo antes de una anestesia) y el **examen**: lo que ves fuera de la boca (cara, ganglios, articulación) y dentro (encía, lengua, mucosas, higiene). También las **pruebas** que sostienen el diagnóstico: la radiografía y lo que viste en ella, y la prueba de frío o la percusión de la pieza.",
        "El estado de cada pieza va en el **odontograma**: cómo se llena, paso a paso, está en la [guía del odontograma](/guias/como-llenar-un-odontograma) (y en la de [niños](/guias/odontograma-en-ninos)).",
      ],
    },
    {
      title: "El diagnóstico y el plan",
      text: [
        "Un **diagnóstico por cada problema**, con su pieza: «caries de dentina en el 36». Si usas los códigos CIE-10, va el código al lado. De ahí sale el **plan**, ordenado por fases; con sus precios, es el presupuesto: lo ves en la [guía del presupuesto](/guias/presupuesto-dental).",
      ],
    },
    {
      title: "Una línea de evolución por visita",
      text: [
        "Cada vez que viene, una línea con la **fecha**, la **pieza**, **lo que hiciste** (con el material y la anestesia), lo que le indicaste y cuándo vuelve. La firma quien atendió.",
        "Lo escrito no se borra ni se tacha: si algo estaba mal, se corrige en una **línea nueva** que dice qué cambia.",
      ],
      figure: {
        kind: "tabla",
        head: ["Fecha", "Lo que se hizo", "Firma"],
        rows: [
          ["03/11", "15: resina de una cara (O), con lidocaína al 2 % con epinefrina, infiltrativa, un cartucho. Sin molestias. Vuelve en 6 meses al control.", "Dra. Paredes"],
          ["10/11", "Corrige la línea del 03/11: la resina fue en el 14, no en el 15.", "Dra. Paredes"],
        ],
      },
    },
  ],
  sheets: [{ sheet: "historia-clinica", label: "Historia clínica en blanco", detail: "Datos, antecedentes, examen, odontograma y evolución · PDF" }],
  tryIt: {
    demo: "historia",
    title: "En odentIA, la historia se llena mientras atiendes.",
    text: "Dictas y Clío lo ordena en su lugar: el motivo, los hallazgos de cada pieza y lo que hiciste. El paciente puede dejar sus datos y su salud desde su enlace antes de llegar, y sus alergias te avisan antes de la anestesia.",
    note: "Aquí puedes tocar el odontograma de su historia: elige una pieza y mira lo que tiene, en el arco y de frente.",
    product: { href: "/historia-clinica-y-odontograma", label: "Mira «Historia y odontograma»" },
  },
  faq: [
    {
      q: "¿Abro una historia nueva si el paciente vuelve después de años?",
      a: "No. Se sigue en la misma, con su mismo número: ahí está todo lo que se le hizo.",
    },
    {
      q: "¿Qué hago si me equivoqué en algo que ya escribí?",
      a: "No lo borres ni lo taches. Escribe una línea nueva, con la fecha, que diga qué se corrige.",
    },
    {
      q: "¿Cada cuánto se actualizan los antecedentes?",
      a: "En cada visita pregunta si cambió algo, sobre todo los medicamentos, y siempre antes de una anestesia o una extracción.",
    },
    {
      q: "¿Y si es un niño?",
      a: "Lo mismo, con los datos de su responsable, y el odontograma de niños.",
    },
  ],
  related: ["como-llenar-un-odontograma", "consentimiento-informado-dental"],
  card: "Qué va en cada parte: datos, motivo, antecedentes, examen, odontograma, diagnóstico y evolución.",
}
