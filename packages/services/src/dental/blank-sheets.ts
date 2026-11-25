/**
 * Las plantillas en blanco de las guías de la web de odentIA (ADR 0216): el odontograma, el
 * odontograma de niños, el presupuesto, la historia clínica, el consentimiento informado y el
 * cierre de caja, para imprimir y llenar a mano. Cada una sigue la hoja que ya imprime la app.
 *
 * Salen del mismo kit de los papeles que imprime la app (`DocumentKit`) y el odontograma, de
 * la misma hoja de la norma (`odontogramSheetScene`, cuatro filas: a los 7 años se usan las
 * dos denticiones). Van sin membrete de clínica, sin persona ni firma electrónica, y al pie
 * «Plantilla gratis de odentIA · odentia32.com». No llevan fecha que cambie: el mismo código
 * da el mismo archivo, así la web y el correo del aviso mandan lo mismo
 * (`pnpm --filter @odentia/services plantillas` los vuelve a escribir en la web).
 */
import {
  CONSENT_DECLARATION,
  CONSENT_PERSONAL_RISKS_LABEL,
  CONSENT_SECTION_LABELS,
  DECLARED_CONDITION_OPTIONS,
  DIAGNOSIS_VERIFICATION_LABELS,
} from "@odentia/clinical"
import { DENTAL_EXAM_LABELS, TREATMENT_PHASE_LABELS } from "@odentia/dental"
import { odontogramSheetScene } from "@odentia/dental/odontogram-sheet"
import { type Cell, type DocumentClinic, DocumentKit, SIZE, sheetFormat } from "../document-kit.js"
import type { GuideSheets } from "../guide-sheets.js"
import { drawChart, NTS_SOURCE } from "./odontogram-pdf.js"

/** Las plantillas, con su archivo en la web (`apps/web/public/guias/`). */
export const BLANK_SHEETS = {
  odontograma: { file: "odontograma.pdf", title: "Odontograma" },
  "odontograma-ninos": { file: "odontograma-ninos.pdf", title: "Odontograma de niños" },
  presupuesto: { file: "presupuesto-dental.pdf", title: "Presupuesto dental" },
  "historia-clinica": { file: "historia-clinica-odontologica.pdf", title: "Historia clínica odontológica" },
  consentimiento: { file: "consentimiento-informado-dental.pdf", title: "Consentimiento informado dental" },
  "cierre-de-caja": { file: "cierre-de-caja.pdf", title: "Cierre de caja" },
} as const

/**
 * Lo que Google lee del PDF (ya lo indexa como una página): el título que muestra en los resultados,
 * el tema y las palabras con que lo buscan. Sin esto mostraba el nombre del archivo.
 */
const SEARCH: Record<keyof typeof BLANK_SHEETS, { title: string; subject: string; keywords: string[] }> = {
  odontograma: {
    title: "Odontograma en blanco para imprimir (PDF) · odentIA",
    subject: "Odontograma de adultos con notación FDI, del 11 al 48, con su leyenda de colores y siglas, para llenar a mano en A4.",
    keywords: ["odontograma", "odontograma para imprimir", "odontograma en blanco", "odontograma PDF", "notación FDI"],
  },
  "odontograma-ninos": {
    title: "Odontograma de niños para imprimir (PDF) · odentIA",
    subject: "Odontograma infantil con dientes de leche del 51 al 85 y dentición mixta, con las edades de erupción, para llenar a mano en A4.",
    keywords: ["odontograma infantil", "odontograma de niños", "dientes de leche", "dentición mixta", "odontograma PDF"],
  },
  presupuesto: {
    title: "Plantilla de presupuesto dental (PDF) · odentIA",
    subject: "Presupuesto dental por fases, con opciones, forma de pago, adelanto, vigencia y firmas, para llenar a mano en A4.",
    keywords: ["presupuesto dental", "plantilla de presupuesto dental", "formato de presupuesto odontológico", "presupuesto dental PDF"],
  },
  "historia-clinica": {
    title: "Formato de historia clínica odontológica (PDF) · odentIA",
    subject: "Historia clínica odontológica para llenar a mano en A4: datos del paciente, motivo de consulta, antecedentes, signos vitales, examen, odontograma, diagnóstico con CIE-10, plan de tratamiento y evolución.",
    keywords: [
      "historia clínica odontológica",
      "formato de historia clínica dental",
      "historia clínica dental PDF",
      "ficha odontológica",
      "anamnesis odontológica",
    ],
  },
  consentimiento: {
    title: "Formato de consentimiento informado dental (PDF) · odentIA",
    subject: "Consentimiento informado odontológico para llenar a mano en A4: procedimiento, diagnóstico, beneficios, riesgos, alternativas, consecuencias de no tratarse, declaración y firmas.",
    keywords: [
      "consentimiento informado odontológico",
      "formato de consentimiento informado dental",
      "consentimiento informado dental PDF",
      "consentimiento informado odontología",
    ],
  },
  "cierre-de-caja": {
    title: "Formato de cierre de caja (PDF) · odentIA",
    subject: "Cierre de caja para llenar a mano en A4: lo que debe haber, el efectivo contado, la diferencia, lo que queda y lo que se entrega, los cobros y gastos del día, el arqueo de billetes y monedas, y las firmas.",
    keywords: ["cierre de caja", "formato de cierre de caja", "arqueo de caja", "cuadre de caja", "cierre de caja PDF"],
  },
}

export type BlankSheet = keyof typeof BLANK_SHEETS
export const BLANK_SHEET_KEYS = Object.keys(BLANK_SHEETS) as BlankSheet[]

/** El pie de toda plantilla. */
const BLANK_SHEET_FOOTER = "Plantilla gratis de odentIA · odentia32.com"

/** Una fecha fija: el PDF no cambia de un armado a otro. */
const MADE_AT = new Date("2026-11-24T12:00:00.000Z")

/** El papel no es de una clínica: el membrete va en blanco para la suya. */
const TEMPLATE: DocumentClinic = {
  tradeName: "",
  legalName: null,
  fiscalDocType: null,
  fiscalDocNumber: null,
  address: null,
  phone: null,
  branchName: null,
  logo: null,
  locale: "es-PE",
  timezone: "America/Lima",
  sheetSize: "A4",
  receiptWidth: "80",
}

async function openTemplate(title: string, sheet: keyof typeof BLANK_SHEETS): Promise<DocumentKit> {
  const kit = await DocumentKit.open(TEMPLATE, sheetFormat("A4"), {
    title,
    docLabel: title,
    legalNote: BLANK_SHEET_FOOTER,
    createdAt: MADE_AT,
    blankLetterhead: true,
  })
  kit.pdf.setProducer("odentIA")
  kit.pdf.setCreator("odentIA")
  kit.pdf.setAuthor("odentIA")
  kit.pdf.setTitle(SEARCH[sheet].title, { showInWindowTitleBar: true })
  kit.pdf.setSubject(SEARCH[sheet].subject)
  kit.pdf.setKeywords(SEARCH[sheet].keywords)
  kit.pdf.setLanguage("es")
  return kit
}

/** Recuadros lado a lado, cada uno con su título y sus renglones, para escribir a mano. */
function ruledBoxes(kit: DocumentKit, titles: string[], lines: number): void {
  const gapX = 15
  const leading = 19
  const titleHeight = SIZE.label * 1.4 + 4
  const height = lines * leading + 4
  kit.ensure(titleHeight + height + 6)
  kit.y -= 6
  const width = (kit.width - gapX * (titles.length - 1)) / titles.length
  const top = kit.y - titleHeight
  titles.forEach((title, index) => {
    const x = kit.left + index * (width + gapX)
    const caption = title.toLocaleUpperCase("es")
    kit.centeredText(
      caption,
      x + kit.textWidth(caption, "sansBold", SIZE.label) / 2,
      kit.y - SIZE.label,
      {
        size: SIZE.label,
        face: "sansBold",
        color: kit.color("ink"),
      },
    )
    kit.page.drawRectangle({
      x,
      y: top - height,
      width,
      height,
      borderColor: kit.color("gray"),
      borderWidth: 0.75,
    })
    for (let line = 1; line < lines; line++) {
      const y = top - 2 - line * leading
      kit.page.drawLine({
        start: { x: x + 6, y },
        end: { x: x + width - 6, y },
        thickness: 0.4,
        color: kit.color("gray"),
      })
    }
  })
  kit.y = top - height
}

/** Una línea de la leyenda: su nombre en negrita y lo demás en gris. */
function legendLine(kit: DocumentKit, label: string, text: string): void {
  kit.text(
    [
      { text: `${label}: `, face: "sansSemi" },
      { text, tone: "gray" },
    ],
    { size: SIZE.label, leading: 1.38 },
  )
}

/**
 * La leyenda corta: los colores, los dibujos y las siglas de la hoja, como los dice la app
 * (`@odentia/dental/catalog`). En la de niños, lo propio de los niños y la palabra «temporal».
 */
function legend(kit: DocumentKit, children: boolean): void {
  // La leyenda va entera en una hoja: partida no se lee.
  kit.ensure(children ? 175 : 125)
  kit.subheading("CÓMO SE MARCA", { size: SIZE.label, before: children ? 10 : 6, after: 2 })
  legendLine(
    kit,
    "Rojo",
    "lo que hay que tratar (caries y lo que está en mal estado o es provisional).",
  )
  legendLine(
    kit,
    "Azul",
    "lo que está en buen estado y lo que no es una enfermedad, como el diente que falta.",
  )
  legendLine(
    kit,
    "Dibujos",
    "el aspa azul es el diente que falta (DEX se extrajo por caries, DAO por otra causa, DNE no erupcionado); el cuadrado alrededor de la corona, una corona; una línea vertical en cada raíz, una endodoncia (TC).",
  )
  legendLine(
    kit,
    "Caries",
    "MB mancha blanca · CE esmalte · CD dentina · CDP llega a la pulpa. Una caries de dos caras es una sola, con una sigla.",
  )
  legendLine(
    kit,
    "Restauraciones y coronas",
    "AM amalgama · R resina · IV ionómero de vidrio · CM metálica · CMC metalcerámica · CLM libre de metal · CT corona provisional.",
  )
  legendLine(
    kit,
    "Otros",
    "RR remanente radicular · S sellante · FFP fosas y fisuras profundas · IMP implante · I impactada (sin aspa).",
  )
  if (children) {
    legendLine(
      kit,
      "En niños",
      "PP pulpotomía (la pulpa de la corona pintada) · PC pulpectomía (una línea vertical en cada raíz) · la corona de acero se marca CM · la flecha en zigzag azul es el diente que está saliendo. «Temporal» en una corona o una restauración quiere decir provisional, no de leche.",
    )
  }
}

/** Qué dientes suele tener a cada edad (AAPD, Reference Manual, «Dental Growth and Development», 2026, p. 675). */
const ERUPTION: Array<[string, string]> = [
  ["2½ a 5 años", "Los 20 de leche (51 a 85)"],
  [
    "6 años",
    "Los 20 de leche y los molares de los 6 años (16, 26, 36, 46); empiezan a salir los incisivos centrales de abajo (31, 41)",
  ],
  [
    "7 a 8 años",
    "Salieron los incisivos centrales (11, 21, 31, 41) y los laterales de abajo (32, 42); se cayeron sus dientes de leche (51, 61, 71, 72, 81, 82)",
  ],
  ["8 a 9 años", "Salen los laterales de arriba (12, 22) y se caen el 52 y el 62"],
  [
    "9 a 12 años",
    "Se cambian los caninos y los molares de leche por los caninos y premolares permanentes",
  ],
  ["12 a 14 años", "Salen los segundos molares (17, 27, 37, 47)"],
  ["17 años en adelante", "Pueden salir los terceros molares (18, 28, 38, 48)"],
]

async function blankOdontogram(children: boolean): Promise<Uint8Array> {
  const sheet = children ? "odontograma-ninos" : "odontograma"
  const kit = await openTemplate(BLANK_SHEETS[sheet].title, sheet)
  kit.gap(10)
  kit.titleWithDetails(children ? "Odontograma de niños" : "Odontograma", [])
  kit.gap(6)
  kit.blankLines(
    children
      ? [
          [{ label: "Paciente", span: 3 }, { label: "Edad" }],
          [{ label: "Responsable", span: 3 }, { label: "Parentesco" }],
          [{ label: "Historia clínica" }, { label: "Documento" }, { label: "Fecha" }],
        ]
      : [
          [{ label: "Paciente", span: 3 }, { label: "Edad" }],
          [{ label: "Historia clínica" }, { label: "Documento" }, { label: "Fecha" }],
        ],
  )
  kit.gap(4)
  kit.choiceRow("Momento", ["Inicio", "Nuevos hallazgos", "Culminación", "Reingreso"])
  kit.gap(6)
  drawChart(kit, odontogramSheetScene([]).rows)
  kit.gap(2)
  kit.text(NTS_SOURCE, { size: SIZE.label, tone: "gray", align: "center", leading: 1.35 })
  // En adultos, la hoja y su leyenda caben en una sola A4: se imprime una hoja por paciente.
  ruledBoxes(kit, ["Especificaciones", "Observaciones"], children ? 4 : 2)
  kit.gap(children ? 8 : 4)
  kit.blankLines([[{ label: "Examinó", span: 2 }, { label: "Colegiatura" }, { label: "Firma" }]])
  legend(kit, children)
  if (children) {
    kit.heading("Qué dientes suele tener a cada edad", { before: 14, keep: 120 })
    kit.table({
      columns: [{ label: "Edad", width: 110 }, { label: "Lo que suele tener en la boca" }],
      rows: ERUPTION.map(([age, teeth]) => [age, teeth]),
      size: SIZE.dense,
    })
    kit.gap(4)
    kit.text(
      "Las edades son aproximadas: muchos niños sanos no siguen el calendario al pie de la letra. Marca cada diente que está en la boca, en su fila: las del medio son los de leche.",
      { size: SIZE.label, tone: "gray", leading: 1.4 },
    )
    kit.text("Fuente de las edades: AAPD, Reference Manual of Pediatric Dentistry, «Dental Growth and Development» (2026), p. 675.", {
      size: SIZE.label,
      tone: "gray",
      leading: 1.4,
    })
  }
  return kit.finish()
}

/** Las fases en el orden en que se atiende, como las de la app (`treatment-templates.ts`), con sus renglones. */
const PHASES: Array<[string, number]> = [
  ["Urgencia", 2],
  ["Básica", 5],
  ["Quirúrgica", 2],
  ["Rehabilitadora", 3],
  ["Mantenimiento", 1],
]

/** Las cuatro filas FDI como se miran de frente, para encerrar en un círculo lo encontrado. */
const SITE_ROWS: number[][] = [
  [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28],
  [55, 54, 53, 52, 51, 61, 62, 63, 64, 65],
  [85, 84, 83, 82, 81, 71, 72, 73, 74, 75],
  [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38],
]

const EMPTY = ""

async function blankBudget(): Promise<Uint8Array> {
  const kit = await openTemplate(BLANK_SHEETS.presupuesto.title, "presupuesto")
  kit.gap(10)
  kit.titleWithDetails("Presupuesto de tratamiento", [], SIZE.titleBudget)
  kit.gap(6)
  kit.blankLines([
    [{ label: "N.°" }, { label: "Fecha" }, { label: "Vale hasta" }, { label: "Moneda" }],
    [{ label: "Paciente", span: 2 }, { label: "Edad" }, { label: "Historia clínica" }],
    [{ label: "Le atiende", span: 3 }, { label: "Colegiatura" }],
  ])

  kit.subheading("LO QUE ENCONTRAMOS", { size: SIZE.label, before: 10, after: 4 })
  kit.text(
    "Encierra en un círculo cada diente con algo que tratar; lo que encontraste va en su renglón del plan.",
    {
      size: SIZE.label,
      tone: "gray",
      leading: 1.4,
    },
  )
  kit.gap(4)
  kit.siteChart(
    SITE_ROWS.map((row) => row.map((tooth) => ({ label: String(tooth), marked: false }))),
  )

  kit.subheading("EL PLAN, POR FASES", { size: SIZE.label, before: 12, after: 2 })
  kit.text(
    "Un renglón por tratamiento, con su diente (y sus caras, si es una restauración). Si hay dos caminos para lo mismo, escribe A o B en «Opción», cada renglón en su fase: no se suman. La corona de un diente va después de su endodoncia.",
    {
      size: SIZE.label,
      tone: "gray",
      leading: 1.4,
    },
  )
  for (const [phase, lines] of PHASES) {
    // La fase con sus renglones y su subtotal no se parte entre dos hojas.
    kit.ensure(30 + (lines + 2) * 21)
    kit.heading(phase, { size: SIZE.table, face: "sansBold", before: 8, after: 2 })
    kit.table({
      columns: [
        { label: "Diente (caras)", width: 84 },
        { label: "Tratamiento" },
        { label: "Opción", width: 46, align: "center" },
        { label: "Sesiones", width: 54, align: "center" },
        { label: "Importe", width: 74, align: "right" },
      ],
      rows: [
        ...Array.from({ length: lines }, () => [EMPTY, EMPTY, EMPTY, EMPTY, EMPTY]),
        [EMPTY, `Subtotal ${phase.toLocaleLowerCase("es")}, sin las opciones`, EMPTY, EMPTY, EMPTY],
      ],
      rowPad: 4,
      size: SIZE.dense,
    })
  }

  kit.gap(8)
  kit.blankLines([[{ label: "Total, si no hay opciones" }, { label: "Total con la A" }, { label: "Total con la B" }]])

  kit.subheading("CÓMO SE PAGA", { size: SIZE.label, before: 12, after: 2 })
  kit.blankLines([[{ label: "Adelanto" }, { label: "Para", span: 2 }]])
  kit.choiceRow("El resto", ["Al hacer cada tratamiento", "En partes"])
  kit.blankLines([[{ label: "Si el importe cambia" }], [{ label: "No incluye" }]])

  kit.subheading("SU DECISIÓN", { size: SIZE.label, before: 12, after: 2 })
  kit.choiceRow("Si hay dos caminos", ["Elijo la opción A", "Elijo la B", "Lo voy a pensar"])
  kit.table({
    columns: [
      { label: "Tratamiento" },
      { label: "Acepto", width: 56, align: "center" },
      { label: "Después", width: 56, align: "center" },
      { label: "No", width: 56, align: "center" },
    ],
    rows: Array.from({ length: 2 }, () => [
      EMPTY,
      [{ checkbox: true }],
      [{ checkbox: true }],
      [{ checkbox: true }],
    ]),
    rowPad: 4,
    size: SIZE.dense,
  })

  kit.subheading("FIRMAS", { size: SIZE.label, before: 12, after: 2 })
  kit.blankLines(
    [
      [
        { label: "Paciente o su responsable", span: 2 },
        { label: "Documento" },
        { label: "Parentesco" },
      ],
      [
        { label: "Firma", span: 2 },
        { label: "Fecha", span: 2 },
      ],
      [{ label: "Profesional", span: 2 }, { label: "Colegiatura" }, { label: "Firma" }],
    ],
    { height: 26 },
  )
  return kit.finish()
}

/** Un título de sección en mayúsculas, con lo que le sigue: no queda solo al pie de una hoja. */
function section(kit: DocumentKit, title: string, keep: number, before = 12): void {
  kit.ensure(before + SIZE.label * 1.4 + 3 + keep)
  kit.subheading(title.toLocaleUpperCase("es"), { size: SIZE.label, before, after: 3 })
}

/** Una nota corta en gris bajo un título: cómo se llena. */
function hint(kit: DocumentKit, text: string): void {
  kit.text(text, { size: SIZE.label, tone: "gray", leading: 1.4 })
}

/** Preguntas con «Sí», «No» y «No sabe» para marcar, y dónde escribir el detalle. */
function questions(kit: DocumentKit, rows: Array<[string, string]>): void {
  const box: Cell = [{ checkbox: true, size: 11 }]
  kit.table({
    columns: [
      { label: "Pregunta" },
      { label: "Sí", width: 30, align: "center" },
      { label: "No", width: 30, align: "center" },
      { label: "No sabe", width: 46, align: "center" },
      { label: "Detalle", width: 140 },
    ],
    // Lo que se pregunta con el «Sí» va en gris junto a la pregunta: el detalle queda libre para escribir.
    rows: rows.map(([question, detail]) => [
      [{ inlines: detail ? [question, { text: ` ${detail}`, tone: "gray" }] : question }],
      box,
      box,
      box,
      EMPTY,
    ]),
    rowPad: 3,
    size: SIZE.label,
  })
}

/** Las preguntas de salud del registro de la app (`registration-questionnaire.tsx`), dichas a quien responde. */
const HEALTH_QUESTIONS: Array<[string, string]> = [
  ["¿Tiene alergia a algún medicamento o material?", "¿A qué? ¿Qué le pasó?"],
  [
    "¿Tiene una válvula del corazón operada, nació con un problema del corazón o tuvo una infección en el corazón (endocarditis)?",
    "",
  ],
  ["¿Algún médico le dijo que tome antibiótico antes de ir al dentista?", ""],
  ["¿Toma algún medicamento para que la sangre no forme coágulos, o aspirina todos los días?", "¿Cuál?"],
  ["¿Toma o tomó alguna vez medicinas para los huesos, por osteoporosis o por un cáncer?", "¿Cuál y desde cuándo?"],
  ["¿Toma algún otro medicamento todos los días?", "¿Cuál?"],
  ["¿Tuvo algún problema con la anestesia del dentista?", "¿Qué pasó?"],
  ["¿Sangró mucho después de una extracción?", ""],
]

const PERSONAL_QUESTIONS: Array<[string, string]> = [
  ["¿Está embarazada?", "¿De cuántas semanas?"],
  ["¿Está dando de lactar?", ""],
  ["¿Le han operado alguna vez?", "¿De qué y cuándo?"],
  ["¿Ha estado internado en un hospital?", "¿Por qué y cuándo?"],
  ["¿Le han hecho una transfusión de sangre?", "¿Cuándo?"],
  ["¿Fuma?", "¿Cuántos cigarrillos al día?"],
  ["¿Toma alcohol?", "¿De vez en cuando o con frecuencia?"],
  ["¿Usa hilo dental?", ""],
  ["¿Aprieta o rechina los dientes, por ejemplo al dormir?", ""],
]

/** Los hábitos que pregunta la app, en palabras del paciente. */
const HABITS = ["Morderse las uñas", "Morder lápices u objetos", "Respirar por la boca", "Chuparse el dedo"]

/** Las fases del plan en el orden en que se atiende, como las nombra la app. */
const PHASE_WORDS = Object.values(TREATMENT_PHASE_LABELS)
  .map((phase) => phase.toLocaleLowerCase("es"))
  .join(", ")

/** Una fila vacía para escribir a mano. */
const blankRow = (columns: number): Cell[] => Array.from({ length: columns }, () => EMPTY)

/**
 * La historia clínica odontológica: lo que guarda la app de cada paciente, en el orden de su
 * copia (`patient-record.ts`) y de su atención: los datos de su registro, el motivo, sus
 * antecedentes con las preguntas de su enlace, los signos vitales, el examen de la boca
 * (`@odentia/dental` examination), el odontograma de la norma, el diagnóstico con su código
 * CIE-10, el plan por fases y la evolución, con la firma de quien atiende.
 */
async function blankHistory(): Promise<Uint8Array> {
  const kit = await openTemplate(BLANK_SHEETS["historia-clinica"].title, "historia-clinica")
  kit.gap(10)
  kit.titleWithDetails("Historia clínica odontológica", [], SIZE.titleBudget)
  kit.gap(6)
  kit.blankLines([[{ label: "Historia clínica N.°" }, { label: "Fecha de apertura" }, { label: "Sede" }]])

  section(kit, "Datos del paciente", 7 * 24)
  kit.blankLines([
    [{ label: "Nombres y apellidos", span: 3 }, { label: "Sexo" }],
    [{ label: "Fecha de nacimiento", span: 3 }, { label: "Edad", span: 2 }, { label: "Documento (tipo y número)", span: 5 }],
    [{ label: "Lugar de nacimiento", span: 2 }, { label: "Nacionalidad" }, { label: "Estado civil" }],
    [{ label: "Ocupación", span: 2 }, { label: "Nivel educativo", span: 2 }],
    [{ label: "Dirección" }],
    [{ label: "Teléfono" }, { label: "Correo", span: 2 }, { label: "Seguro" }],
    [{ label: "Contacto de emergencia", span: 2 }, { label: "Parentesco" }, { label: "Teléfono" }],
  ])

  section(kit, "Responsable, si es menor de edad", 2 * 24)
  kit.blankLines([
    [{ label: "Nombres y apellidos", span: 2 }, { label: "Parentesco" }, { label: "Documento" }],
    [{ label: "Teléfono" }, { label: "Correo", span: 3 }],
  ])

  section(kit, "Motivo de consulta", 140)
  ruledBoxes(kit, ["Lo que lo trae, en sus palabras"], 2)
  kit.gap(2)
  kit.blankLines([[{ label: "Tiempo de enfermedad" }, { label: "¿Le duele ahora? De 0 a 10" }]])
  ruledBoxes(kit, ["Relato de la enfermedad: cómo empezó y siguió, qué lo alivia o empeora y qué tomó"], 3)

  section(kit, "Antecedentes odontológicos", 24 + 40)
  kit.blankLines([[{ label: "Última visita al dentista", span: 2 }, { label: "Cepillados al día" }]])
  kit.choiceRow("¿Cómo le fue esa vez?", ["Positiva", "Regular", "Traumática"])
  kit.choiceRow("Ansiedad dental", ["Ninguna", "Leve", "Moderada", "Alta"])

  // Lo de su salud empieza en una hoja nueva: sus dos tablas van juntas.
  kit.newPage()
  kit.subheading("ANTECEDENTES: SU SALUD", { size: SIZE.label, before: 2, after: 3 })
  questions(kit, HEALTH_QUESTIONS)
  kit.gap(6)
  kit.choiceRow("Enfermedades", [...DECLARED_CONDITION_OPTIONS])
  kit.blankLines([[{ label: "Otra enfermedad", span: 3 }, { label: "Grupo sanguíneo" }]])

  section(kit, "Antecedentes personales y hábitos", 10 * 24)
  questions(kit, PERSONAL_QUESTIONS)
  kit.gap(6)
  kit.choiceRow("Hábitos", HABITS)
  kit.blankLines([[{ label: "Antecedentes familiares" }]])

  section(kit, "Signos vitales", 3 * 24)
  kit.blankLines([
    [{ label: "Presión arterial (mmHg)" }, { label: "Frecuencia cardiaca (/min)" }],
    [{ label: "Frecuencia respiratoria (/min)" }, { label: "Temperatura (°C)" }],
    [{ label: "Saturación de oxígeno (%)", span: 4 }, { label: "Peso (kg)", span: 3 }, { label: "Talla (cm)", span: 3 }],
  ])

  const exam = (keys: string[]) => keys.map((key) => ({ label: DENTAL_EXAM_LABELS[key] ?? key }))
  section(kit, "Examen clínico", 5 * 24)
  kit.blankLines([exam(["atm", "ganglios", "labios"])])
  kit.choiceRow("Higiene oral", ["Buena", "Regular", "Mala"])
  kit.blankLines([exam(["encias", "lengua", "paladar"]), exam(["pisoBoca", "carrillos", "orofaringe"])])

  // El odontograma va entero, con su fuente y sus recuadros.
  section(kit, "Odontograma", 460)
  kit.choiceRow("Momento", ["Inicio", "Nuevos hallazgos", "Culminación", "Reingreso"])
  kit.gap(4)
  drawChart(kit, odontogramSheetScene([]).rows)
  kit.gap(2)
  kit.text(NTS_SOURCE, { size: SIZE.label, tone: "gray", align: "center", leading: 1.35 })
  ruledBoxes(kit, ["Especificaciones", "Observaciones"], 2)

  // El diagnóstico, el plan y la evolución, juntos en la última hoja.
  kit.newPage()
  kit.subheading("DIAGNÓSTICO", { size: SIZE.label, before: 2, after: 3 })
  const box: Cell = [{ checkbox: true, size: 11 }]
  kit.table({
    columns: [
      { label: "Diente o zona", width: 80 },
      { label: "Diagnóstico" },
      { label: "CIE-10", width: 60 },
      { label: DIAGNOSIS_VERIFICATION_LABELS.provisional, width: 62, align: "center" },
      { label: DIAGNOSIS_VERIFICATION_LABELS.confirmed, width: 62, align: "center" },
    ],
    rows: Array.from({ length: 5 }, () => [EMPTY, EMPTY, EMPTY, box, box]),
    rowPad: 4,
    size: SIZE.dense,
  })

  section(kit, "Plan de tratamiento", 6 * 22)
  hint(kit, `Un renglón por tratamiento, con su diente y sus caras. Las fases, en el orden en que se atiende: ${PHASE_WORDS}.`)
  kit.table({
    columns: [
      { label: "Diente (caras)", width: 84 },
      { label: "Tratamiento" },
      { label: "Fase", width: 100 },
      { label: "Sesiones", width: 54, align: "center" },
    ],
    rows: Array.from({ length: 8 }, () => blankRow(4)),
    rowPad: 4,
    size: SIZE.dense,
  })

  section(kit, "Evolución", 4 * 22)
  hint(kit, "Cada atención: lo que se hizo, en qué diente, y lo que sigue. Firma quien atendió.")
  // Los renglones que caben hasta la firma de la historia: la hoja se llena, sin pasar a otra.
  const signature = 24 + 14
  const rowHeight = SIZE.dense * 1.45 + 8 + 0.4
  const rows = Math.max(6, Math.floor((kit.room() - SIZE.label * 1.3 - 8 - signature) / rowHeight))
  kit.table({
    columns: [
      { label: "Fecha", width: 66 },
      { label: "Diente", width: 54 },
      { label: "Lo que se hizo y lo que sigue" },
      { label: "Firma", width: 92 },
    ],
    rows: Array.from({ length: rows }, () => blankRow(4)),
    rowPad: 4,
    size: SIZE.dense,
  })
  kit.gap(14)
  kit.blankLines([[{ label: "Profesional a cargo", span: 2 }, { label: "Colegiatura" }, { label: "Firma" }]])
  return kit.finish()
}

/**
 * El consentimiento informado: la hoja que la app imprime para firmar en papel
 * (`renderConsentPaperPdf` en `consent-pdf.ts`), con sus secciones en el mismo orden y con
 * sus nombres (`CONSENT_SECTION_LABELS`), la misma declaración y las firmas de quien
 * consiente, su huella y el profesional que informa. Las secciones van en blanco, para
 * escribirlas a mano con el paciente.
 */
async function blankConsent(): Promise<Uint8Array> {
  const kit = await openTemplate(BLANK_SHEETS.consentimiento.title, "consentimiento")
  kit.gap(10)
  kit.titleWithDetails("Consentimiento informado", [], SIZE.titleBudget)
  kit.gap(6)
  kit.blankLines([
    [{ label: "Tratamiento", span: 3 }, { label: "Fecha" }],
    [{ label: "Paciente", span: 2 }, { label: "Documento" }, { label: "Historia clínica" }],
  ])
  ruledBoxes(kit, [CONSENT_SECTION_LABELS.procedure], 2)
  kit.gap(6)
  kit.blankLines([[{ label: CONSENT_SECTION_LABELS.diagnosis, span: 3 }, { label: "CIE-10" }]])
  ruledBoxes(kit, [CONSENT_SECTION_LABELS.benefits, CONSENT_SECTION_LABELS.risks], 4)
  ruledBoxes(kit, [CONSENT_PERSONAL_RISKS_LABEL, CONSENT_SECTION_LABELS.alternatives], 3)
  ruledBoxes(kit, [CONSENT_SECTION_LABELS.consequences, CONSENT_SECTION_LABELS.notes], 3)
  kit.gap(8)
  const signatures = [
    {
      heading: "Paciente o representante legal",
      strokes: null,
      // Lo que la app dice en la hoja de un menor: «Firma su representante legal».
      lines: [{ text: "Nombre, documento y fecha" }, { text: "Si es menor de edad, firma su representante legal" }],
    },
    { heading: "Huella digital", strokes: null, lines: [{ text: "Si no sabe firmar" }], width: 84 },
    {
      heading: "Profesional que informa",
      strokes: null,
      lines: [{ text: "Nombre y colegiatura" }, { text: "Fecha y hora" }],
    },
  ]
  const boxHeight = 56
  // La declaración pasa de hoja con las firmas: una firma sola no dice qué se firmó.
  const declaration = { title: "Declaración", body: CONSENT_DECLARATION, size: SIZE.read }
  kit.ensure(kit.panelHeight(declaration) + 16 + kit.penSignaturesHeight(signatures, { boxHeight }))
  kit.panel(declaration)
  kit.gap(16)
  kit.penSignatures(signatures, { boxHeight })
  return kit.finish()
}

/** Los billetes y monedas que se cuentan, de mayor a menor. */
const CASH_PIECES = ["200", "100", "50", "20", "10", "5", "2", "1", "0,50", "0,20", "0,10"]

/** Una columna de una tabla lado a lado. */
interface SideColumn {
  label: string
  /** Ancho en puntos; sin él, reparte lo que queda. */
  width?: number
  align?: "left" | "right" | "center"
}

/** Lo que va en una celda: texto, texto en negrita o casillas para marcar una. */
type SideCell = string | { text: string; strong?: boolean } | { choices: string[] }

/**
 * Tablas angostas una al lado de la otra, con filas del mismo alto: lo que se suma de la caja
 * junto al conteo de billetes. `kit.table` ocupa todo el ancho; así la hoja cabe en una A4.
 */
function sideTables(kit: DocumentKit, tables: Array<{ columns: SideColumn[]; rows: SideCell[][] }>, rowHeight = 19): void {
  const gapX = 21
  const headHeight = SIZE.label * 1.3 + 4
  const rows = Math.max(...tables.map((table) => table.rows.length))
  kit.ensure(headHeight + rows * rowHeight + 2)
  const top = kit.y
  const tableWidth = (kit.width - gapX * (tables.length - 1)) / tables.length
  /** Un texto en su celda; deja `kit.y` donde estaba la fila. */
  const write = (
    value: string,
    x: number,
    rowTop: number,
    width: number,
    style: { strong?: boolean; head?: boolean; align?: "left" | "right" | "center" },
  ) => {
    const size = style.head ? SIZE.label : SIZE.dense
    const leading = 1.3
    kit.y = style.head ? rowTop : rowTop - (rowHeight - size * leading) / 2
    kit.text(value, {
      size,
      leading,
      indent: x - kit.left,
      width,
      face: style.head ? "sansSemi" : style.strong ? "sansBold" : "sans",
      tone: style.head ? "gray" : "ink",
      align: style.align ?? "left",
    })
  }
  tables.forEach((table, index) => {
    const x0 = kit.left + index * (tableWidth + gapX)
    const fixed = table.columns.reduce((sum, column) => sum + (column.width ?? 0), 0)
    const free = table.columns.filter((column) => column.width === undefined).length
    // Cada columna con su borde izquierdo y su ancho.
    let edge = x0
    const placed = table.columns.map((column) => {
      const width = column.width ?? (tableWidth - fixed) / Math.max(free, 1)
      const at = { ...column, x: edge, width }
      edge += width
      return at
    })
    for (const column of placed) write(column.label, column.x, top, column.width - 6, { head: true, align: column.align })
    const rule = (y: number, ink: boolean) =>
      kit.page.drawLine({
        start: { x: x0, y },
        end: { x: x0 + tableWidth, y },
        thickness: ink ? 0.75 : 0.4,
        color: kit.color(ink ? "ink" : "gray"),
      })
    const bodyTop = top - headHeight
    rule(bodyTop, true)
    table.rows.forEach((row, r) => {
      const rowTop = bodyTop - r * rowHeight
      row.forEach((cell, i) => {
        const column = placed[i]
        if (!column) return
        if (typeof cell === "object" && "choices" in cell) {
          // «☐ Cuadra ☐ Sobra ☐ Falta»: se marca una.
          const box = 10
          let x = column.x
          for (const choice of cell.choices) {
            kit.page.drawRectangle({
              x,
              y: rowTop - (rowHeight + box) / 2,
              width: box,
              height: box,
              borderColor: kit.color("ink"),
              borderWidth: 0.75,
            })
            write(choice, x + box + 4, rowTop, column.width, {})
            x += box + 4 + kit.textWidth(choice, "sans", SIZE.dense) + 12
          }
          return
        }
        const text = typeof cell === "string" ? cell : cell.text
        const strong = typeof cell === "object" && cell.strong
        if (text) write(text, column.x, rowTop, column.width - 6, { strong, align: column.align })
      })
      rule(rowTop - rowHeight, r === table.rows.length - 1)
    })
  })
  kit.y = top - headHeight - rows * rowHeight
}

/**
 * El cierre de caja: la hoja «CIERRE DE CAJA» que imprime la app al cerrar
 * (`CashClosureSheet` en `cash-close-drawer.tsx`), con sus renglones y en su orden: lo que
 * debe haber, lo contado, la diferencia, lo que queda y lo que se entrega, y los otros
 * medios, que no se cuentan. Para hacerlo a mano suma el conteo de billetes y monedas, y los
 * cobros y gastos del día.
 */
async function blankCashClose(): Promise<Uint8Array> {
  const kit = await openTemplate(BLANK_SHEETS["cierre-de-caja"].title, "cierre-de-caja")
  kit.gap(10)
  kit.titleWithDetails("Cierre de caja", [], SIZE.titleBudget)
  kit.gap(4)
  kit.blankLines([
    [{ label: "Fecha y hora", span: 2 }, { label: "Sede" }, { label: "Caja (moneda)" }],
    [{ label: "Cerró", span: 2 }, { label: "Desde (el cierre anterior)", span: 2 }],
  ])

  // Filas más bajas que las de una tabla: así el arqueo, los otros medios y los cobros caben en una hoja.
  const row = 17
  section(kit, "El efectivo", 12 * row + 20, 10)
  sideTables(
    kit,
    [
      {
        columns: [{ label: "Concepto" }, { label: "Importe", width: 78, align: "right" }],
        rows: [
          ["Quedó del cierre anterior", ""],
          ["+ Cobros en efectivo", ""],
          ["+ Efectivo ingresado", ""],
          ["− Gastos pagados con la caja", ""],
          ["− Efectivo retirado", ""],
          ["− Devuelto en efectivo", ""],
          [{ text: "= Debe haber", strong: true }, ""],
          ["Efectivo que contaste", ""],
          [{ text: "Diferencia", strong: true }, ""],
          [{ choices: ["Cuadra", "Sobra", "Falta"] }, ""],
          ["Queda en caja para mañana", ""],
          [{ text: "ENTREGA", strong: true }, ""],
        ],
      },
      {
        columns: [
          { label: "Billete o moneda" },
          { label: "Cantidad", width: 60, align: "center" },
          { label: "Importe", width: 78, align: "right" },
        ],
        rows: [...CASH_PIECES.map((piece) => [`S/ ${piece}`, "", ""]), [{ text: "Total contado", strong: true }, "", ""]],
      },
    ],
    row,
  )

  kit.gap(14)
  sideTables(
    kit,
    [
      {
        columns: [{ label: "Otros medios (no se cuentan)" }, { label: "Importe", width: 78, align: "right" }],
        rows: [["Tarjeta", ""], ["Transferencia", ""], ["Billetera digital", ""], ["Otro:", ""]],
      },
      {
        columns: [{ label: "Gastos pagados con la caja" }, { label: "Importe", width: 78, align: "right" }],
        rows: [[""], [""], [""], [""]],
      },
    ],
    row,
  )

  // Los cobros llenan lo que queda hasta las firmas, sin pasar a otra hoja.
  const signatures = 24 + 8 + 30
  const head = SIZE.label * 1.4 + 3 + 12 + SIZE.label * 1.3 + 4
  const charges = Math.max(8, Math.floor((kit.room() - head - 12 - signatures) / row))
  section(kit, "Cobros del día", 4 * row)
  sideTables(
    kit,
    [
      {
        columns: [
          { label: "Hora", width: 48 },
          { label: "Paciente" },
          { label: "Concepto" },
          { label: "Medio", width: 90 },
          { label: "Importe", width: 78, align: "right" },
        ],
        rows: Array.from({ length: charges }, () => [""]),
      },
    ],
    row,
  )

  kit.gap(12)
  kit.blankLines([[{ label: "Nota" }]])
  kit.gap(8)
  kit.blankLines([[{ label: "Entrega (quien cierra)", span: 2 }, { label: "Recibe", span: 2 }]], { height: 30 })
  return kit.finish()
}

/** El PDF de una plantilla. */
export function renderBlankSheet(sheet: BlankSheet): Promise<Uint8Array> {
  switch (sheet) {
    case "odontograma":
      return blankOdontogram(false)
    case "odontograma-ninos":
      return blankOdontogram(true)
    case "presupuesto":
      return blankBudget()
    case "historia-clinica":
      return blankHistory()
    case "consentimiento":
      return blankConsent()
    case "cierre-de-caja":
      return blankCashClose()
  }
}

const rendered = new Map<BlankSheet, Promise<Uint8Array>>()

/** El mismo PDF una sola vez por proceso: el correo del aviso los adjunta sin volver a dibujarlos. */
export function blankSheetBytes(sheet: BlankSheet): Promise<Uint8Array> {
  let bytes = rendered.get(sheet)
  if (!bytes) {
    bytes = renderBlankSheet(sheet)
    // Si falla, se intenta otra vez la próxima: un error no queda guardado.
    bytes.catch(() => rendered.delete(sheet))
    rendered.set(sheet, bytes)
  }
  return bytes
}

/**
 * Lo que el correo cuenta de la app según la plantilla, solo lo que la app hace: Clío ordena
 * lo conversado o dictado (`help-guide/clinica.ts`), el consentimiento se firma en la clínica,
 * por enlace o en papel (`consent-pdf.ts`) y el cierre calcula lo que debe haber y la
 * diferencia (`cash-close-drawer.tsx`).
 */
const SHEET_PITCH = {
  "historia-clinica":
    "En odentIA, la historia se llena mientras atiendes: conversas con el paciente o dictas, y Clío deja cada cosa en su lugar (el motivo, el relato, su salud y el examen) para que tú lo confirmes.",
  consentimiento:
    "En odentIA, el consentimiento sale de la plantilla del tratamiento con los riesgos propios de su caso, y el paciente lo firma en la tablet, desde su celular o en papel: queda en su historia con la fecha y la hora.",
  "cierre-de-caja":
    "En odentIA, la caja suma sola lo que debe haber: cuentas el efectivo, te dice si cuadra, sobra o falta, y la hoja de cierre sale lista para firmar.",
} as const satisfies Partial<Record<BlankSheet, string>>

/** Las plantillas de las guías de odentIA, para el aviso (`guideSheetsFor` en `products.ts`). */
export const DENTAL_GUIDE_SHEETS: GuideSheets = {
  // Las de `apps/web/src/pages/guias/` (`blank-sheets.test.ts` lo comprueba).
  pages: [
    "/guias/como-llenar-un-odontograma",
    "/guias/odontograma-en-ninos",
    "/guias/presupuesto-dental",
    "/guias/historia-clinica-odontologica",
    "/guias/consentimiento-informado-dental",
    "/guias/cierre-de-caja-dental",
  ],
  sheets: BLANK_SHEETS,
  bytes: (key) =>
    Object.hasOwn(BLANK_SHEETS, key)
      ? blankSheetBytes(key as BlankSheet)
      : Promise.reject(new Error("Esa plantilla no existe")),
  pitch: (keys) => {
    // La de la primera que pidió; el odontograma y el presupuesto, como siempre.
    const first = keys[0]
    if (first && Object.hasOwn(SHEET_PITCH, first)) return SHEET_PITCH[first as keyof typeof SHEET_PITCH]
    return keys.every((key) => key === "presupuesto")
      ? "En odentIA, el presupuesto sale del plan, con los precios de tu lista y hasta tres opciones, y el paciente lo recibe en su celular."
      : "En odentIA, el odontograma se llena en la pantalla: tocas el diente, eliges lo que ves y queda dibujado con su fecha en la historia del paciente."
  },
}
