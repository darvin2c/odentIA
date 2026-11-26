/**
 * Las plantillas en blanco de las guías de la web de odentIA (ADR 0216): el odontograma, el
 * odontograma de niños, el presupuesto, la historia clínica, el consentimiento informado, el
 * cierre de caja, el plan de tratamiento, el periodontograma y la lista de códigos CIE-10, para
 * imprimir y llenar a mano. Cada una sigue la hoja que ya imprime la app.
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
import { BUNDLED_DIAGNOSIS_LISTS, readDiagnosisList } from "@odentia/db"
import {
  DENTAL_EXAM_LABELS,
  FDI_ADULT_ROWS,
  type FurcationEntry,
  furcationEntriesFor,
  isDentalDiagnosis,
  TREATMENT_PHASE_LABELS,
  TREATMENT_PHASES,
} from "@odentia/dental"
import { odontogramSheetScene } from "@odentia/dental/odontogram-sheet"
import { rgb } from "pdf-lib"
import {
  type Cell,
  type DocFormat,
  type DocumentClinic,
  DocumentKit,
  SIZE,
  sheetFormat,
  type Tone,
} from "../document-kit.js"
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
  "plan-de-tratamiento": { file: "plan-de-tratamiento-odontologico.pdf", title: "Plan de tratamiento odontológico" },
  periodontograma: { file: "periodontograma.pdf", title: "Periodontograma" },
  "cie10-odontologia": { file: "cie10-odontologia.pdf", title: "Códigos CIE-10 en odontología" },
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
  "plan-de-tratamiento": {
    title: "Plan de tratamiento odontológico por fases (PDF) · odentIA",
    subject: "Plan de tratamiento odontológico para llenar a mano en A4: el diagnóstico por pieza con su código CIE-10, las cinco fases (urgencia, básica o higiénica, quirúrgica, rehabilitadora y mantenimiento) con sus sesiones y fechas, la reevaluación de la encía y las firmas.",
    keywords: [
      "plan de tratamiento odontológico",
      "plan de tratamiento odontológico por fases",
      "formato de plan de tratamiento dental",
      "plan de tratamiento dental PDF",
    ],
  },
  periodontograma: {
    title: "Periodontograma para imprimir (PDF) · odentIA",
    subject: "Periodontograma de adultos con notación FDI para llenar a mano en A4 horizontal: profundidad de sondaje, recesión, pérdida de inserción, sangrado, supuración, movilidad y furca por pieza, los datos para el grado y el índice de placa de O'Leary.",
    keywords: ["periodontograma", "periodontograma PDF", "periodontograma para imprimir", "ficha periodontal", "índice de O'Leary"],
  },
  "cie10-odontologia": {
    title: "Códigos CIE-10 en odontología, lista para imprimir (PDF) · odentIA",
    subject: "Los códigos CIE-10 odontológicos de la lista del MINSA (2024-07) con su título: los de uso diario al frente y la lista completa por categoría.",
    keywords: ["CIE-10 odontología", "códigos CIE-10 odontológicos", "CIE-10 dental", "CIE-10 MINSA odontología", "CIE-10 PDF"],
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

/**
 * La A4 apaisada, para lo que va a lo ancho (el periodontograma: 16 piezas con sus tres sitios).
 * El kit dibuja en el tamaño que se le dé; el margen es menor que el de la vertical para que
 * cada sitio tenga una celda donde quepa un número escrito con lapicero.
 */
const A4_LANDSCAPE: DocFormat = { ...sheetFormat("A4"), width: 841.89, height: 595.28, margin: 40 }

async function openTemplate(
  title: string,
  sheet: keyof typeof BLANK_SHEETS,
  options: { format?: DocFormat; footer?: string } = {},
): Promise<DocumentKit> {
  const kit = await DocumentKit.open(TEMPLATE, options.format ?? sheetFormat("A4"), {
    title,
    docLabel: title,
    legalNote: options.footer ?? BLANK_SHEET_FOOTER,
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
  ["¿Tiene alergia a algún medicamento o material, como la anestesia, la penicilina o el látex?", "¿A qué? ¿Qué le pasó?"],
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
]

/**
 * Las enfermedades que se marcan: las de la lista de la app (`DECLARED_CONDITION_OPTIONS`), con sus
 * palabras, y las que una historia en papel también pregunta porque cambian la atención (los
 * riñones y el hígado en los medicamentos, la úlcera en los antiinflamatorios, las defensas
 * bajas, la tuberculosis y el VIH en el cuidado y en la cicatrización).
 */
const DISEASES = [
  ...DECLARED_CONDITION_OPTIONS,
  "Enfermedad de los riñones",
  "Enfermedad del hígado",
  "Gastritis o úlcera",
  "Defensas bajas",
  "Tuberculosis",
  "VIH",
]

/** Lo de su boca que pregunta la app (`antecedentesOdontologicos`): el hilo, el bruxismo y sus hábitos. */
const MOUTH_HABITS = [
  "¿Usa hilo dental?",
  "¿Aprieta o rechina los dientes?",
  "¿Se muerde las uñas?",
  "¿Muerde lápices u objetos?",
  "¿Respira por la boca?",
  "¿Se chupa el dedo?",
]

/**
 * Cada cosa con su «Sí» y su «No», de dos en dos por fila: lo que no se marcó queda sin
 * responder, no se lee como un «No».
 */
function yesNoPairs(kit: DocumentKit, title: string, items: readonly string[]): void {
  const box: Cell = [{ checkbox: true, size: 11 }]
  const rows: Cell[][] = []
  for (let index = 0; index < items.length; index += 2) {
    const second = items[index + 1]
    rows.push([items[index] ?? EMPTY, box, box, second ?? EMPTY, second ? box : EMPTY, second ? box : EMPTY])
  }
  kit.table({
    columns: [
      { label: title, pad: 8 },
      { label: "Sí", width: 26, align: "center" },
      { label: "No", width: 44, align: "center", pad: 18 },
      { label: title, pad: 8 },
      { label: "Sí", width: 26, align: "center" },
      { label: "No", width: 26, align: "center" },
    ],
    rows,
    rowPad: 2,
    size: SIZE.label,
  })
}

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

  // Entra entero bajo el relato, en la primera hoja.
  section(kit, "Antecedentes odontológicos", 24 + 40 + 3 * 17 + 16, 6)
  kit.blankLines([[{ label: "Última visita al dentista", span: 2 }, { label: "Cepillados al día" }]])
  kit.choiceRow("¿Cómo le fue esa vez?", ["Positiva", "Regular", "Traumática"])
  kit.choiceRow("Ansiedad dental", ["Ninguna", "Leve", "Moderada", "Alta"])
  yesNoPairs(kit, "Su boca y sus hábitos", MOUTH_HABITS)

  // Lo de su salud empieza en una hoja nueva: sus dos tablas van juntas.
  kit.newPage()
  kit.subheading("ANTECEDENTES: SU SALUD", { size: SIZE.label, before: 2, after: 3 })
  questions(kit, HEALTH_QUESTIONS)
  kit.gap(6)
  kit.gap(4)
  yesNoPairs(kit, "Enfermedad", DISEASES)
  kit.blankLines([[{ label: "Otra enfermedad", span: 3 }, { label: "Grupo sanguíneo" }]])

  section(kit, "Antecedentes personales y hábitos", 7 * 19 + 40)
  questions(kit, PERSONAL_QUESTIONS)
  kit.gap(4)
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
  kit.subheading("EXÁMENES AUXILIARES", { size: SIZE.label, before: 2, after: 0 })
  ruledBoxes(kit, ["Radiografías y pruebas (frío, percusión)"], 3)
  section(kit, "Diagnóstico", 5 * 22)
  const box: Cell = [{ checkbox: true, size: 11 }]
  kit.table({
    columns: [
      { label: "Diente o zona", width: 80 },
      { label: "Diagnóstico" },
      { label: "CIE-10", width: 60 },
      { label: DIAGNOSIS_VERIFICATION_LABELS.provisional, width: 62, align: "center" },
      { label: DIAGNOSIS_VERIFICATION_LABELS.confirmed, width: 62, align: "center" },
    ],
    rows: Array.from({ length: 4 }, () => [EMPTY, EMPTY, EMPTY, box, box]),
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
    rows: Array.from({ length: 6 }, () => blankRow(4)),
    rowPad: 4,
    size: SIZE.dense,
  })

  section(kit, "Evolución", 4 * 22)
  hint(kit, "Cada atención: lo que se hizo, en qué diente, y lo que sigue. Firma quien atendió. Si se acaba, sigue en una hoja aparte.")
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
    // La pieza escrita evita tratar la que no es.
    [{ label: "Tratamiento", span: 3 }, { label: "Pieza(s)" }, { label: "Fecha" }],
    [{ label: "Paciente", span: 2 }, { label: "Documento" }, { label: "Historia clínica" }],
    [{ label: "Representante, si es menor", span: 4 }, { label: "Documento", span: 2 }, { label: "Parentesco", span: 2 }],
  ])
  ruledBoxes(kit, [CONSENT_SECTION_LABELS.procedure], 2)
  kit.gap(6)
  kit.blankLines([[{ label: CONSENT_SECTION_LABELS.diagnosis, span: 3 }, { label: "CIE-10" }]])
  ruledBoxes(kit, [CONSENT_SECTION_LABELS.benefits, CONSENT_SECTION_LABELS.risks], 4)
  ruledBoxes(kit, [CONSENT_PERSONAL_RISKS_LABEL, CONSENT_SECTION_LABELS.alternatives], 3)
  ruledBoxes(kit, [CONSENT_SECTION_LABELS.consequences, CONSENT_SECTION_LABELS.notes], 3)
  kit.gap(6)
  const signatures = [
    {
      heading: "Paciente o representante legal",
      strokes: null,
      // De un menor firma su representante legal, como dice la hoja de la app: su nombre va arriba.
      lines: [{ text: "Nombre, documento y fecha" }],
    },
    { heading: "Huella digital", strokes: null, lines: [{ text: "Si no sabe firmar" }], width: 84 },
    {
      heading: "Profesional que informa",
      strokes: null,
      lines: [{ text: "Nombre y colegiatura" }, { text: "Fecha y hora" }],
    },
  ]
  const boxHeight = 50
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
        columns: [
          // «Gastos pagados con la caja» no cabe en una línea junto al comprobante.
          { label: "Gastos con la caja" },
          { label: "Comprobante", width: 72 },
          { label: "Importe", width: 64, align: "right" },
        ],
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

/** El fondo de una franja (la fase, la cara) y el de una celda que no se llena. */
const BAND_FILL = rgb(0xf1 / 255, 0xf5 / 255, 0xf9 / 255)
const NONE_FILL = rgb(0xe2 / 255, 0xe8 / 255, 0xf0 / 255)

/**
 * Un texto en una celda, centrado en su alto. Deja `kit.y` donde estaba: quien dibuja la
 * tabla ya reservó su alto, así nunca pasa de hoja a la mitad.
 */
function cellText(
  kit: DocumentKit,
  value: string,
  box: { x: number; top: number; width: number; height: number },
  style: {
    size?: number
    face?: "sans" | "sansSemi" | "sansBold"
    tone?: Tone
    align?: "left" | "right" | "center"
  } = {},
): void {
  const size = style.size ?? SIZE.dense
  const leading = 1.3
  const face = style.face ?? "sans"
  const lines = kit.lay(value, box.width, { size, leading, face })
  const saved = kit.y
  kit.y = box.top - Math.max(0, (box.height - lines.length * size * leading) / 2)
  kit.text(value, {
    size,
    leading,
    indent: box.x - kit.left,
    width: box.width,
    face,
    tone: style.tone ?? "ink",
    align: style.align ?? "left",
  })
  kit.y = saved
}

/** Una celda de una tabla para llenar: vacía, con texto o con una casilla para marcar. */
type GridCell = string | { text: string; strong?: boolean; tone?: Tone } | { checkbox: true }
/** Una fila: sus celdas, o una franja con su nombre que corta la tabla (la fase). */
type GridRow = GridCell[] | { band: string }

/**
 * Una tabla a todo el ancho con el encabezado una sola vez y franjas que la parten, como las
 * fases del plan: así entran todas en una hoja. Las filas tienen el alto de un renglón escrito.
 */
function bandedTable(kit: DocumentKit, columns: SideColumn[], rows: GridRow[], rowHeight = 19): void {
  const headHeight = SIZE.label * 1.3 + 5
  const bandHeight = 16
  const height = headHeight + rows.reduce((sum, row) => sum + ("band" in row ? bandHeight : rowHeight), 0)
  kit.ensure(height + 2)
  const fixed = columns.reduce((sum, column) => sum + (column.width ?? 0), 0)
  const free = columns.filter((column) => column.width === undefined).length
  let edge = kit.left
  const placed = columns.map((column) => {
    const width = column.width ?? (kit.width - fixed) / Math.max(free, 1)
    const at = { ...column, x: edge, width }
    edge += width
    return at
  })
  const top = kit.y
  for (const column of placed)
    cellText(kit, column.label, { x: column.x + 3, top, width: column.width - 6, height: headHeight }, {
      size: SIZE.label,
      face: "sansSemi",
      tone: "gray",
      align: column.align,
    })
  const rule = (y: number, ink: boolean) =>
    kit.page.drawLine({
      start: { x: kit.left, y },
      end: { x: kit.right, y },
      thickness: ink ? 0.75 : 0.4,
      color: kit.color(ink ? "ink" : "gray"),
    })
  let y = top - headHeight
  rule(y, true)
  rows.forEach((row, index) => {
    const last = index === rows.length - 1
    if ("band" in row) {
      kit.page.drawRectangle({ x: kit.left, y: y - bandHeight, width: kit.width, height: bandHeight, color: BAND_FILL })
      cellText(kit, row.band, { x: kit.left + 4, top: y, width: kit.width - 8, height: bandHeight }, {
        size: SIZE.label,
        face: "sansBold",
      })
      y -= bandHeight
      rule(y, last)
      return
    }
    row.forEach((cell, i) => {
      const column = placed[i]
      if (!column) return
      if (typeof cell === "object" && "checkbox" in cell) {
        const size = 10
        kit.page.drawRectangle({
          x: column.x + (column.width - size) / 2,
          y: y - (rowHeight + size) / 2,
          width: size,
          height: size,
          borderColor: kit.color("ink"),
          borderWidth: 0.75,
        })
        return
      }
      const text = typeof cell === "string" ? cell : cell.text
      if (!text) return
      cellText(kit, text, { x: column.x + 3, top: y, width: column.width - 6, height: rowHeight }, {
        face: typeof cell === "object" && cell.strong ? "sansBold" : "sans",
        tone: typeof cell === "object" ? cell.tone : "ink",
        align: column.align,
      })
    })
    // Una línea suave entre columnas: cada dato en su lugar.
    for (const column of placed.slice(1))
      kit.page.drawLine({
        start: { x: column.x, y },
        end: { x: column.x, y: y - rowHeight },
        thickness: 0.4,
        color: NONE_FILL,
      })
    y -= rowHeight
    rule(y, last)
  })
  kit.y = top - height
}

/** El alto de un renglón del plan: el de un renglón escrito, y así todo entra en una hoja. */
const PLAN_ROW = 18

/** Los renglones de cada fase del plan; la básica suma el de la reevaluación de la encía. */
const PLAN_LINES: Record<(typeof TREATMENT_PHASES)[number], number> = {
  urgencia: 2,
  basica: 3,
  quirurgica: 2,
  rehabilitadora: 3,
  mantenimiento: 1,
}

/**
 * El plan de tratamiento por fases, sin precios (la plata va en el presupuesto): el diagnóstico
 * de cada pieza con su código, las cinco fases de la app en su orden (`TREATMENT_PHASE_LABELS`),
 * con la reevaluación de la encía al terminar la básica y la fecha de cada sesión, lo que se
 * repasa antes de empezar y las firmas. La app lo imprime dentro del presupuesto; aquí va solo.
 */
async function blankTreatmentPlan(): Promise<Uint8Array> {
  const kit = await openTemplate(BLANK_SHEETS["plan-de-tratamiento"].title, "plan-de-tratamiento")
  kit.gap(10)
  kit.titleWithDetails("Plan de tratamiento odontológico", [], SIZE.titleBudget)
  kit.gap(4)
  kit.blankLines([
    [{ label: "Paciente", span: 3 }, { label: "Edad" }],
    [{ label: "Historia clínica" }, { label: "Documento" }, { label: "Fecha" }],
  ])
  ruledBoxes(kit, ["Antes de empezar: alergias, medicamentos (anticoagulantes) y alertas"], 2)

  section(kit, "Diagnóstico por pieza", 5 * PLAN_ROW, 8)
  bandedTable(
    kit,
    [
      { label: "Pieza", width: 62 },
      { label: "Diagnóstico" },
      { label: "CIE-10", width: 62 },
      { label: DIAGNOSIS_VERIFICATION_LABELS.provisional, width: 62, align: "center" },
      { label: DIAGNOSIS_VERIFICATION_LABELS.confirmed, width: 62, align: "center" },
    ],
    Array.from({ length: 4 }, (): GridRow => [EMPTY, EMPTY, EMPTY, { checkbox: true }, { checkbox: true }]),
    PLAN_ROW,
  )

  section(kit, "El plan, por fases", 14 * PLAN_ROW, 8)
  hint(
    kit,
    "Un renglón por tratamiento, en su fase y en el orden en que se hace: la corona va después de su endodoncia. Anota la fecha de cada sesión el día que se hace. Los precios van en el presupuesto.",
  )
  kit.gap(3)
  const rows: GridRow[] = []
  for (const phase of TREATMENT_PHASES) {
    rows.push({ band: TREATMENT_PHASE_LABELS[phase] })
    for (let line = 0; line < PLAN_LINES[phase]; line++) rows.push(blankRow(5) as GridCell[])
    // La encía se vuelve a medir al terminar la básica: de eso depende lo que sigue.
    if (phase === "basica")
      rows.push([EMPTY, { text: "Reevaluación de la encía", tone: "gray" }, EMPTY, EMPTY, EMPTY])
  }
  bandedTable(
    kit,
    [
      { label: "Pieza (caras)", width: 72 },
      { label: "Tratamiento" },
      { label: "CIE-10", width: 54 },
      { label: "Sesiones", width: 50, align: "center" },
      { label: "Fecha de cada sesión", width: 128 },
    ],
    rows,
    PLAN_ROW,
  )

  kit.gap(10)
  kit.blankLines(
    [
      [{ label: "Profesional", span: 2 }, { label: "Colegiatura" }, { label: "Firma" }],
      [{ label: "Paciente o su responsable", span: 2 }, { label: "Documento" }, { label: "Firma" }],
    ],
    { height: 25 },
  )
  return kit.finish()
}

/** Cómo se dice cada entrada de furca en su celda (minúscula, chica, en una esquina). */
const FURCATION_MARK: Record<FurcationEntry, string> = {
  buccal: "v",
  lingual: "l",
  mesiopalatal: "mp",
  distopalatal: "dp",
  mesial: "m",
  distal: "d",
}

/** Las entradas de furca del lado mesial: van hacia el centro de la boca. */
const MESIAL_ENTRIES = new Set<FurcationEntry>(["mesiopalatal", "mesial"])

type ArchRow =
  | { kind: "teeth"; height: number }
  | { kind: "sites"; height: number }
  | { kind: "tooth"; label: string; box: boolean; height: number }
  | { kind: "site"; label: string; height: number; gray?: boolean }
  | { kind: "band"; label: string; height: number }
  | { kind: "furcation"; label: string; face: "buccal" | "lingual"; height: number }

/**
 * Una arcada del periodontograma, como se mira de frente (`FDI_ADULT_ROWS`): por pieza, si
 * falta, si es un implante y su movilidad; después cada cara en el orden en que se sonda
 * (`probingSequence`: arriba por fuera y por dentro; abajo por dentro y por fuera), con los
 * tres sitios de cada pieza (`PERIODONTAL_SITES`), y la furca con las entradas de cada pieza
 * (`furcationEntriesFor`). Las piezas sin esa entrada quedan en gris.
 */
function periodontalArch(kit: DocumentKit, upper: boolean): void {
  const teeth = FDI_ADULT_ROWS[upper ? 0 : 1] ?? []
  const labelWidth = 104
  const toothWidth = (kit.width - labelWidth) / teeth.length
  const siteWidth = toothWidth / 3
  const tall = 17
  const short = 14
  const faces = upper
    ? [
        { face: "buccal" as const, name: "Vestibular", how: "por fuera, de la 18 a la 28" },
        { face: "lingual" as const, name: "Palatino", how: "por dentro, de la 28 a la 18" },
      ]
    : [
        { face: "lingual" as const, name: "Lingual", how: "por dentro, de la 48 a la 38" },
        { face: "buccal" as const, name: "Vestibular", how: "por fuera, de la 38 a la 48" },
      ]
  const rows: ArchRow[] = [
    { kind: "teeth", height: 16 },
    { kind: "sites", height: 11 },
    { kind: "tooth", label: "Ausente", box: true, height: 15 },
    { kind: "tooth", label: "Implante", box: true, height: 15 },
    { kind: "tooth", label: "Movilidad (0 a 3)", box: false, height: tall },
  ]
  for (const { face, name, how } of faces) {
    rows.push(
      { kind: "band", label: `${name.toLocaleUpperCase("es")} · ${how}`, height: 15 },
      { kind: "site", label: "Sondaje (mm)", height: tall },
      { kind: "site", label: "Recesión (mm)", height: tall },
      { kind: "site", label: "Pérdida de inserción", height: tall, gray: true },
      { kind: "site", label: "Sangrado", height: short },
      { kind: "site", label: "Supuración", height: short },
      { kind: "furcation", label: "Furca (1 a 3)", face, height: tall },
    )
  }
  const height = rows.reduce((sum, row) => sum + row.height, 0)
  kit.ensure(height + 2)
  const top = kit.y
  const gridLeft = kit.left + labelWidth
  const xOf = (index: number) => gridLeft + index * toothWidth
  // En la mitad izquierda de la hoja (cuadrantes 1 y 4) lo distal queda a la izquierda.
  const leftSide = (index: number) => index < teeth.length / 2
  const thin = (x: number, from: number, to: number) =>
    kit.page.drawLine({ start: { x, y: from }, end: { x, y: to }, thickness: 0.3, color: kit.color("gray") })
  const label = (value: string, rowTop: number, rowHeight: number, style: Parameters<typeof cellText>[3]) =>
    cellText(kit, value, { x: kit.left + 4, top: rowTop, width: labelWidth - 8, height: rowHeight }, style)
  let y = top
  rows.forEach((row, rowIndex) => {
    const rowTop = y
    const rowBottom = y - row.height
    if (row.kind === "band") {
      // La franja va de lado a lado, sin las líneas de las piezas: se lee de corrido.
      kit.page.drawRectangle({ x: kit.left, y: rowBottom, width: kit.width, height: row.height, color: BAND_FILL })
      cellText(kit, row.label, { x: kit.left + 4, top: rowTop, width: kit.width - 8, height: row.height }, {
        size: SIZE.label,
        face: "sansBold",
      })
    } else if (row.kind === "teeth") {
      label("Pieza", rowTop, row.height, { size: SIZE.label, face: "sansSemi", tone: "gray" })
      teeth.forEach((tooth, index) =>
        cellText(kit, String(tooth), { x: xOf(index), top: rowTop, width: toothWidth, height: row.height }, {
          size: SIZE.dense,
          face: "sansBold",
          align: "center",
        }),
      )
    } else if (row.kind === "sites") {
      label("Sitios", rowTop, row.height, { size: 7, tone: "gray" })
      teeth.forEach((_, index) => {
        const [first, last] = leftSide(index) ? ["D", "M"] : ["M", "D"]
        const mark = { size: 6.5, tone: "gray" as const, align: "center" as const }
        cellText(kit, first, { x: xOf(index), top: rowTop, width: siteWidth, height: row.height }, mark)
        cellText(kit, last, { x: xOf(index) + 2 * siteWidth, top: rowTop, width: siteWidth, height: row.height }, mark)
      })
    } else {
      const gray = row.kind === "site" && row.gray
      label(row.label, rowTop, row.height, { size: SIZE.label, face: gray ? "sans" : "sansSemi", tone: gray ? "gray" : "ink" })
      teeth.forEach((tooth, index) => {
        const x = xOf(index)
        if (row.kind === "tooth") {
          if (!row.box) return
          const size = 9
          kit.page.drawRectangle({
            x: x + (toothWidth - size) / 2,
            y: rowBottom + (row.height - size) / 2,
            width: size,
            height: size,
            borderColor: kit.color("ink"),
            borderWidth: 0.75,
          })
          return
        }
        if (row.kind === "site") {
          thin(x + siteWidth, rowTop, rowBottom)
          thin(x + 2 * siteWidth, rowTop, rowBottom)
          return
        }
        // La furca: las entradas de esta pieza que se sondan desde esta cara.
        const entries = furcationEntriesFor(tooth).filter((entry) =>
          row.face === "buccal" ? entry === "buccal" : entry !== "buccal",
        )
        if (entries.length === 0) {
          kit.page.drawRectangle({ x, y: rowBottom, width: toothWidth, height: row.height, color: NONE_FILL })
          return
        }
        // Dos entradas: cada una en su mitad, la mesial hacia el centro de la boca.
        const mesialFirst = !leftSide(index)
        const ordered = [...entries].sort(
          (a, b) => Number(MESIAL_ENTRIES.has(b) === mesialFirst) - Number(MESIAL_ENTRIES.has(a) === mesialFirst),
        )
        const part = toothWidth / ordered.length
        ordered.forEach((entry, at) => {
          if (at > 0) thin(x + at * part, rowTop, rowBottom)
          cellText(kit, FURCATION_MARK[entry], { x: x + at * part + 1.5, top: rowTop - 0.5, width: part - 3, height: 7 }, {
            size: 5.5,
            tone: "gray",
          })
        })
      })
    }
    y = rowBottom
    const line = rowIndex === 0 || row.kind === "band" || rows[rowIndex + 1]?.kind === "band"
    kit.page.drawLine({
      start: { x: kit.left, y },
      end: { x: kit.right, y },
      thickness: line ? 0.75 : 0.4,
      color: kit.color(line ? "ink" : "gray"),
    })
  })
  // El borde de cada pieza, y la línea media más gruesa, en cada tramo entre franjas.
  const bottom = top - height
  let from = top
  let segmentTop = top
  rows.forEach((row, rowIndex) => {
    const to = from - row.height
    const next = rows[rowIndex + 1]
    if (row.kind !== "band" && (!next || next.kind === "band")) {
      for (let index = 0; index < teeth.length; index++)
        kit.page.drawLine({
          start: { x: xOf(index), y: segmentTop },
          end: { x: xOf(index), y: to },
          thickness: index === 0 ? 0.75 : index === teeth.length / 2 ? 1.5 : 0.6,
          color: kit.color("ink"),
        })
    }
    if (row.kind === "band") segmentTop = to
    from = to
  })
  kit.page.drawRectangle({ x: kit.left, y: bottom, width: kit.width, height, borderColor: kit.color("ink"), borderWidth: 0.75 })
  kit.y = bottom
}

/**
 * La placa de O'Leary (1972): cada pieza en un cuadro partido en sus cuatro caras
 * (`PLAQUE_FACES`: vestibular, lingual o palatina, mesial y distal), como se miran de frente:
 * la vestibular hacia el labio y la mesial hacia el centro.
 */
function plaqueChart(kit: DocumentKit): void {
  const cell = kit.width / 16
  const square = Math.min(36, cell - 8)
  const numberHeight = 14
  const gapRows = 14
  const height = 2 * (numberHeight + square) + gapRows
  kit.ensure(height + 4)
  const top = kit.y
  const ink = kit.color("ink")
  FDI_ADULT_ROWS.forEach((teeth, arch) => {
    const upper = arch === 0
    const rowTop = top - arch * (numberHeight + square + gapRows)
    // El número de los de arriba va arriba y el de los de abajo, abajo: las dos filas quedan juntas.
    const squareTop = upper ? rowTop - numberHeight : rowTop
    const numberTop = upper ? rowTop : rowTop - square
    teeth.forEach((tooth, index) => {
      const x = kit.left + index * cell + (cell - square) / 2
      cellText(kit, String(tooth), { x, top: numberTop, width: square, height: numberHeight }, {
        size: SIZE.dense,
        face: "sansBold",
        align: "center",
      })
      const bottom = squareTop - square
      kit.page.drawRectangle({ x, y: bottom, width: square, height: square, borderColor: ink, borderWidth: 0.75 })
      kit.page.drawLine({ start: { x, y: bottom }, end: { x: x + square, y: squareTop }, thickness: 0.5, color: ink })
      kit.page.drawLine({ start: { x, y: squareTop }, end: { x: x + square, y: bottom }, thickness: 0.5, color: ink })
      // La letra de cada cara, chica y en gris: se pinta encima.
      const inner = upper ? "P" : "L"
      const [left, right] = index < 8 ? ["D", "M"] : ["M", "D"]
      const mark = { size: 6, tone: "gray" as const, align: "center" as const }
      const third = square / 3
      cellText(kit, upper ? "V" : inner, { x, top: squareTop - 1, width: square, height: third }, mark)
      cellText(kit, upper ? inner : "V", { x, top: bottom + third + 1, width: square, height: third }, mark)
      cellText(kit, left, { x: x + 1, top: squareTop - third, width: third, height: third }, mark)
      cellText(kit, right, { x: x + square - third - 1, top: squareTop - third, width: third, height: third }, mark)
    })
  })
  kit.y = top - height
}

/**
 * El periodontograma de adultos en A4 apaisada: la arcada superior, la inferior con los datos
 * para el grado y la placa de O'Leary, con las mismas reglas que la app (`periodontal.ts`).
 */
async function blankPeriodontogram(): Promise<Uint8Array> {
  const kit = await openTemplate(BLANK_SHEETS.periodontograma.title, "periodontograma", { format: A4_LANDSCAPE })
  kit.gap(8)
  kit.titleWithDetails("Periodontograma", [], SIZE.titleBudget)
  kit.gap(2)
  kit.blankLines([
    [{ label: "Paciente", span: 4 }, { label: "Edad" }, { label: "Historia clínica", span: 2 }, { label: "Fecha", span: 2 }],
  ])
  kit.gap(4)
  kit.text(
    [
      { text: "Recesión: ", face: "sansSemi" },
      { text: "positiva si se ve raíz (+2), negativa si la encía cubre la corona (−1); con el signo cambiado, la pérdida de inserción sale mal. ", tone: "gray" },
      { text: "Pérdida de inserción ", face: "sansSemi" },
      { text: "= sondaje + recesión. ", tone: "gray" },
      { text: "Sangrado y supuración: ", face: "sansSemi" },
      { text: "un punto en el sitio. ", tone: "gray" },
      { text: "Furca ", face: "sansSemi" },
      { text: "de Hamp, de 1 a 3; ", tone: "gray" },
      { text: "movilidad ", face: "sansSemi" },
      { text: "de Miller, de 0 a 3. Sonda con fuerza ligera.", tone: "gray" },
    ],
    { size: SIZE.label, leading: 1.4 },
  )
  section(kit, "Arcada superior", 300, 8)
  periodontalArch(kit, true)

  kit.newPage()
  kit.subheading("ARCADA INFERIOR", { size: SIZE.label, before: 2, after: 3 })
  periodontalArch(kit, false)
  section(kit, "Datos para el grado", 3 * 24, 12)
  kit.blankLines([
    [
      { label: "Pérdida ósea en la radiografía (%, en la pieza más afectada)", span: 4 },
      { label: "Piezas perdidas por la encía", span: 3 },
      { label: "Cigarrillos al día", span: 2 },
    ],
  ])
  kit.gap(4)
  kit.choiceRow("Diabetes", ["No", "Sí"])
  kit.blankLines([
    [
      { label: "HbA1c (%)", span: 2 },
      { label: "Diagnóstico", span: 3 },
      { label: "Estadio" },
      { label: "Grado" },
      { label: "Extensión", span: 2 },
    ],
  ])

  kit.newPage()
  kit.subheading("PLACA DE O'LEARY", { size: SIZE.label, before: 2, after: 3 })
  hint(
    kit,
    "Después de teñir, pinta cada cara con placa: V vestibular, P palatina, L lingual, M mesial y D distal. Tacha la pieza que falta: no se cuenta.",
  )
  kit.gap(10)
  plaqueChart(kit)
  kit.gap(16)
  kit.blankLines([
    [{ label: "Caras con placa", span: 2 }, { label: "Caras examinadas (piezas × 4)", span: 2 }, { label: "Placa (%)", span: 2 }],
  ])
  kit.gap(2)
  hint(kit, "Placa (%) = caras con placa ÷ caras examinadas × 100.")
  kit.gap(18)
  kit.blankLines([[{ label: "Examinó", span: 3 }, { label: "Colegiatura" }, { label: "Firma", span: 2 }]], { height: 26 })
  return kit.finish()
}

/** Los códigos de todos los días en la consulta (mesa de las guías, voz clínica, 26 nov). */
export const DAILY_DENTAL_ICD10 = [
  "K02.0",
  "K02.1",
  "K02.5",
  "K04.0",
  "K04.1",
  "K04.4",
  "K04.5",
  "K04.6",
  "K04.7",
  "K05.1",
  "K05.2",
  "K05.3",
  "K03.6",
  "K06.0",
  "K08.1",
  "K08.3",
  "K01.1",
  "K10.3",
  "K07.6",
  "K03.0",
  "K12.0",
  "S02.5",
  "S03.2",
  "Z01.2",
] as const

/** Lo que más se escribe mal. */
const ICD10_REMINDERS = [
  "Un diente extraído es K08.1, no K00.0.",
  "Junto a K04.0 escribe si es reversible o irreversible.",
  "K05.3: anota el estadio y el grado al lado.",
  "Marca si el diagnóstico es presuntivo o definitivo.",
]

export interface DentalIcd10 {
  /** De dónde sale la lista, para el pie y la web. */
  source: string
  /** Los códigos odontológicos en el orden del archivo; `category` si tiene subcódigos. */
  codes: Array<{ code: string; title: string; category: boolean }>
  /** Los de uso diario, en su orden. */
  daily: string[]
}

let icd10: DentalIcd10 | null = null

/**
 * Los códigos odontológicos de la CIE-10 del MINSA, leídos como los carga la app: el archivo
 * oficial del repositorio con su SHA-256 (`readDiagnosisList`: `readDiagnosisFile` y
 * `prepareDiagnosisRows`, con los títulos de `minsaTitleForDisplay`), y lo odontológico con
 * `isDentalDiagnosis`. Nunca la semilla de desarrollo (`cie10.csv`), que no es oficial.
 */
export function dentalIcd10(): DentalIcd10 {
  if (icd10) return icd10
  const load = BUNDLED_DIAGNOSIS_LISTS.find((list) => list.system === "ICD-10-PE" && list.official)
  if (!load) throw new Error("Falta la CIE-10 del MINSA en las listas del repositorio")
  const codes = readDiagnosisList(load)
    .rows.filter((row) => isDentalDiagnosis("ICD-10-PE", row.code))
    .map((row) => ({ code: row.code, title: row.title, category: row.isCategory }))
  const known = new Set(codes.map((row) => row.code))
  const missing = DAILY_DENTAL_ICD10.filter((code) => !known.has(code))
  if (missing.length > 0) throw new Error(`La lista del MINSA no trae ${missing.join(", ")}`)
  icd10 = {
    source: `Lista CIE-10 del MINSA (${load.edition}), códigos odontológicos`,
    codes,
    daily: [...DAILY_DENTAL_ICD10],
  }
  return icd10
}

/**
 * La lista completa en dos columnas: cada categoría en negrita y sus subcódigos debajo. Una
 * categoría no queda sola al pie de una columna: baja con su primer subcódigo.
 */
function icd10Columns(kit: DocumentKit, codes: DentalIcd10["codes"]): void {
  const gapX = 20
  const columnWidth = (kit.width - gapX) / 2
  const codeWidth = 42
  const size = SIZE.label
  const leading = 1.35
  const faceOf = (category: boolean) => (category ? "sansBold" : "sans")
  const heightOf = (entry: DentalIcd10["codes"][number]) =>
    kit.lay(entry.title, columnWidth - codeWidth, { size, leading, face: faceOf(entry.category) }).length * size * leading +
    1.5
  // Un aire antes de cada grupo (K02, S03…): un código suelto, como D10.0, no se lee como de la categoría de arriba.
  const opensGroup = (index: number) => index > 0 && codes[index - 1]?.code.slice(0, 3) !== codes[index]?.code.slice(0, 3)
  const floor = kit.y - kit.room()
  let column = 0
  let start = kit.y
  let top = start
  codes.forEach((entry, index) => {
    const next = codes[index + 1]
    const space = opensGroup(index) && top !== start ? 5 : 0
    const keep = space + heightOf(entry) + (entry.category && next ? heightOf(next) : 0)
    if (top - keep < floor) {
      if (column === 0) column = 1
      else {
        kit.newPage()
        start = kit.y
        column = 0
      }
      top = start
    }
    const x = kit.left + column * (columnWidth + gapX)
    const face = faceOf(entry.category)
    const at = top - (top !== start && opensGroup(index) ? 5 : 0)
    const saved = kit.y
    kit.y = at
    kit.text(entry.code, { size, leading, face, indent: x - kit.left, width: codeWidth })
    kit.y = at
    kit.text(entry.title, { size, leading, face, indent: x - kit.left + codeWidth, width: columnWidth - codeWidth })
    top = kit.y - 1.5
    kit.y = saved
  })
}

/**
 * Los códigos CIE-10 de la odontología: al frente los de uso diario con su título y lo que más
 * se escribe mal; detrás, la lista completa por categoría. Todo sale de `dentalIcd10`.
 */
async function blankIcd10(): Promise<Uint8Array> {
  const list = dentalIcd10()
  const kit = await openTemplate(BLANK_SHEETS["cie10-odontologia"].title, "cie10-odontologia", {
    footer: `${list.source} · ${BLANK_SHEET_FOOTER}`,
  })
  kit.gap(10)
  kit.titleWithDetails("Códigos CIE-10 en odontología", [], SIZE.titleBudget)
  section(kit, "Los de uso diario", 24 * 19, 10)
  const titles = new Map(list.codes.map((entry) => [entry.code, entry.title]))
  bandedTable(
    kit,
    [{ label: "Código", width: 62 }, { label: "Título" }],
    list.daily.map((code): GridRow => [{ text: code, strong: true }, titles.get(code) ?? EMPTY]),
  )
  section(kit, "Para no equivocarse", 4 * 16, 14)
  kit.bullets(ICD10_REMINDERS, { size: SIZE.dense, leading: 1.5 })

  kit.newPage()
  kit.subheading("LA LISTA COMPLETA", { size: SIZE.label, before: 2, after: 2 })
  hint(kit, "Cada categoría en negrita y sus códigos debajo: en la historia va el código con su subcódigo.")
  kit.gap(6)
  icd10Columns(kit, list.codes)
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
    case "plan-de-tratamiento":
      return blankTreatmentPlan()
    case "periodontograma":
      return blankPeriodontogram()
    case "cie10-odontologia":
      return blankIcd10()
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
 * en papel o por enlace, y el del enlace espera la confirmación del profesional
 * (`CONSENT_SIGNATURE_NOTES.enlace`, `consent-pdf.ts`), y el cierre calcula lo que debe haber y la
 * diferencia (`cash-close-drawer.tsx`).
 */
const SHEET_PITCH = {
  "historia-clinica":
    "En odentIA, la historia se llena mientras atiendes: conversas con el paciente o dictas, y Clío deja cada cosa en su lugar (el motivo, el relato, su salud y el examen) para que tú lo confirmes.",
  consentimiento:
    "En odentIA, los tratamientos que más lo piden traen su consentimiento sugerido, y le sumas los riesgos propios de su caso. El paciente lo firma en la tablet o en papel y queda en su historia con la fecha y la hora; si lo firma desde su celular, queda pendiente hasta que el profesional lo confirma con él.",
  "cierre-de-caja":
    "En odentIA, la caja suma sola lo que debe haber: cuentas el efectivo, te dice si cuadra, sobra o falta, y la hoja de cierre sale lista para firmar.",
  "plan-de-tratamiento":
    "En odentIA, cada tratamiento que indicas cae en su fase y nace con sus sesiones habituales: tú lo mueves si hace falta. Cada cita dice «sesión 1 de 2» y, al terminar, reservas la siguiente desde ahí.",
  periodontograma:
    "En odentIA, el periodontograma se llena a pantalla completa, una pieza y una cara a la vez: la pérdida de inserción y los índices salen solos, y lo comparas con el anterior.",
  "cie10-odontologia":
    "En odentIA no buscas el código: marcas la caries en el odontograma y el diagnóstico ya viene propuesto con su código. El buscador encuentra por nombre o por código, sin tildes y con lo odontológico primero.",
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
    "/guias/plan-de-tratamiento-odontologico",
    "/guias/como-llenar-un-periodontograma",
    "/guias/cie-10-odontologia",
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
