/**
 * Las plantillas en blanco de las guías de la web de odentIA (ADR 0214): el odontograma, el
 * odontograma de niños y el presupuesto, para imprimir y llenar a mano.
 *
 * Salen del mismo kit de los papeles que imprime la app (`DocumentKit`) y el odontograma, de
 * la misma hoja de la norma (`odontogramSheetScene`, cuatro filas: a los 7 años se usan las
 * dos denticiones). Van sin membrete de clínica, sin persona ni firma electrónica, y al pie
 * «Plantilla gratis de odentIA · odentia32.com». No llevan fecha que cambie: el mismo código
 * da el mismo archivo, así la web y el correo del aviso mandan lo mismo
 * (`pnpm --filter @odentia/services plantillas` los vuelve a escribir en la web).
 */
import { odontogramSheetScene } from "@odentia/dental/odontogram-sheet"
import { drawChart, NTS_SOURCE } from "./dental/odontogram-pdf.js"
import { type DocumentClinic, DocumentKit, SIZE, sheetFormat } from "./document-kit.js"

/** Las plantillas, con su archivo en la web (`apps/web/public/guias/`). */
export const BLANK_SHEETS = {
  odontograma: { file: "odontograma.pdf", title: "Odontograma" },
  "odontograma-ninos": { file: "odontograma-ninos.pdf", title: "Odontograma de niños" },
  presupuesto: { file: "presupuesto-dental.pdf", title: "Presupuesto dental" },
} as const

export type BlankSheet = keyof typeof BLANK_SHEETS
export const BLANK_SHEET_KEYS = Object.keys(BLANK_SHEETS) as BlankSheet[]

export function isBlankSheet(value: unknown): value is BlankSheet {
  return typeof value === "string" && Object.hasOwn(BLANK_SHEETS, value)
}

/** El pie de toda plantilla. */
export const BLANK_SHEET_FOOTER = "Plantilla gratis de odentIA · odentia32.com"

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

async function openTemplate(title: string): Promise<DocumentKit> {
  const kit = await DocumentKit.open(TEMPLATE, sheetFormat("A4"), {
    title,
    docLabel: title,
    legalNote: BLANK_SHEET_FOOTER,
    createdAt: MADE_AT,
    blankLetterhead: true,
  })
  kit.pdf.setProducer("odentIA")
  kit.pdf.setCreator("odentIA")
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
    { size: SIZE.label, leading: 1.45 },
  )
}

/**
 * La leyenda corta: los colores, los dibujos y las siglas de la hoja, como los dice la app
 * (`@odentia/dental/catalog`). En la de niños, lo propio de los niños y la palabra «temporal».
 */
function legend(kit: DocumentKit, children: boolean): void {
  // La leyenda va entera en una hoja: partida no se lee.
  kit.ensure(children ? 175 : 140)
  kit.subheading("CÓMO SE MARCA", { size: SIZE.label, before: 10, after: 2 })
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
    "el aspa azul es el diente que falta (DEX se extrajo por caries, DAO por otra causa, DNE no erupcionado); el cuadrado alrededor de la corona, una corona; la línea vertical en la raíz, una endodoncia (TC).",
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
    "RR remanente radicular · S sellante · FFP fosas y fisuras profundas · IMP implante.",
  )
  if (children) {
    legendLine(
      kit,
      "En niños",
      "PP pulpotomía · PC pulpectomía · la corona de acero se marca CM · la flecha en zigzag azul es el diente que está saliendo. «Temporal» en una corona o una restauración quiere decir provisional, no de leche.",
    )
  }
}

/** Qué dientes suele tener a cada edad (AAPD, Dental Growth and Development, 2026). */
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

/** Las edades de la guía de niños, para tenerlas al lado de la hoja. */
export const ERUPTION_BY_AGE: ReadonlyArray<readonly [string, string]> = ERUPTION

async function blankOdontogram(children: boolean): Promise<Uint8Array> {
  const kit = await openTemplate(
    children ? BLANK_SHEETS["odontograma-ninos"].title : BLANK_SHEETS.odontograma.title,
  )
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
  ruledBoxes(kit, ["Especificaciones", "Observaciones"], 4)
  kit.gap(8)
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
    kit.text("Fuente de las edades: AAPD, «Dental Growth and Development».", {
      size: SIZE.label,
      tone: "gray",
      leading: 1.4,
    })
  }
  return kit.finish()
}

/** Las fases en el orden en que se atiende, como las de la app (`treatment-templates.ts`), con sus renglones. */
const PHASES: Array<[string, number]> = [
  ["Urgencia", 1],
  ["Básica", 3],
  ["Quirúrgica", 1],
  ["Rehabilitadora", 2],
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
  const kit = await openTemplate(BLANK_SHEETS.presupuesto.title)
  kit.gap(10)
  kit.titleWithDetails("Presupuesto de tratamiento", [], SIZE.titleBudget)
  kit.gap(6)
  kit.blankLines([
    [{ label: "N.°" }, { label: "Fecha" }, { label: "Vale hasta" }],
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
    "Un renglón por tratamiento, con su diente (y sus caras, si es una restauración). La corona de un diente va después de su endodoncia.",
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
        { label: "Diente (caras)", width: 90 },
        { label: "Tratamiento" },
        { label: "Sesiones", width: 58, align: "center" },
        { label: "Importe", width: 78, align: "right" },
      ],
      rows: [
        ...Array.from({ length: lines }, () => [EMPTY, EMPTY, EMPTY, EMPTY]),
        [EMPTY, `Subtotal ${phase.toLocaleLowerCase("es")}`, EMPTY, EMPTY],
      ],
      rowPad: 4,
      size: SIZE.dense,
    })
  }

  kit.subheading("OTRO CAMINO (ELIJA UNO; NO SE SUMAN)", { size: SIZE.label, before: 12, after: 2 })
  kit.text(
    "Dos formas de resolver lo mismo, cada una con su total. Lo demás del plan va igual en las dos.",
    {
      size: SIZE.label,
      tone: "gray",
      leading: 1.4,
    },
  )
  kit.table({
    columns: [
      { label: "Opción A", pad: 9 },
      { label: "Importe", width: 70, align: "right", pad: 18 },
      { label: "Opción B", pad: 9 },
      { label: "Importe", width: 70, align: "right" },
    ],
    rows: [
      ...Array.from({ length: 2 }, () => [EMPTY, EMPTY, EMPTY, EMPTY]),
      ["Subtotal A", EMPTY, "Subtotal B", EMPTY],
    ],
    rowPad: 4,
    size: SIZE.dense,
  })

  kit.gap(8)
  kit.blankLines([[{ label: "Total" }, { label: "Total con la A" }, { label: "Total con la B" }]])

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

/** El PDF de una plantilla. */
export function renderBlankSheet(sheet: BlankSheet): Promise<Uint8Array> {
  switch (sheet) {
    case "odontograma":
      return blankOdontogram(false)
    case "odontograma-ninos":
      return blankOdontogram(true)
    case "presupuesto":
      return blankBudget()
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
