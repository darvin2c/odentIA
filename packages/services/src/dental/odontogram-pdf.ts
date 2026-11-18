/**
 * El odontograma en PDF, dibujado en el servidor con el kit de los papeles (ADR 0115).
 *
 * - El firmado (solo en clínicas de Perú, NTS 188) es un papel emitido: se dibuja una
 *   vez, al firmar o la primera vez que se pide, y se guarda con su huella
 *   (`issuedPaperBytes`, ADR 0132). Verlo, imprimirlo y la copia de la historia son ese
 *   mismo archivo. Lleva lo de la hoja de antes: membrete de cuando se firmó, persona,
 *   historia clínica, documento, fecha, el momento, el gráfico a color, especificaciones,
 *   observaciones, quién firmó con su título y colegiatura, su firma y el QR.
 * - El de hoy no se firma ni se guarda: se dibuja al pedirlo y dice «Sin firmar» con su
 *   fecha. En Perú, con el gráfico de la norma; fuera, la hoja neutra con la numeración
 *   FDI y los hallazgos en palabras, como la que se imprime hoy en esos países: sin
 *   gráfico oficial no se inventa uno.
 *
 * El gráfico sale de `@odentia/dental/odontogram-sheet`, el mismo que dibuja la pantalla.
 */
import type { Db } from "@odentia/db"
import { diagnosisCodeLabel } from "@odentia/clinical"
import {
  conditionLabel,
  FDI_ADULT_ROWS,
  FDI_CHILD_ROWS,
  SIGNED_ODONTOGRAM_PURPOSE_LABELS,
  SIGNED_ODONTOGRAM_PURPOSE_SHORT,
  type SignedOdontogramPurpose,
  surfaceLabel,
  toothNameOf,
  variantLabel,
} from "@odentia/dental"
import {
  odontogramSheetScene,
  type SheetEntry,
  type SheetPoint,
  type SheetRow,
  type SheetShape,
} from "@odentia/dental/odontogram-sheet"
import {
  LineCapStyle,
  LineJoinStyle,
  popGraphicsState,
  pushGraphicsState,
  type RGB,
  rgb,
  setLineJoin,
} from "pdf-lib"
import type { PaperContext } from "../clinical-papers.js"
import { credentialOf } from "../clinical-papers.js"
import {
  chartNumber,
  type DocumentClinic,
  DocumentKit,
  dayTimeWords,
  dayWords,
  documentFormat,
  SIZE,
  type Strokes,
} from "../document-kit.js"
import { loadDocumentClinic } from "../document-clinic.js"
import { issuedPaperBytes, type PaperStorage } from "../issued-papers.js"
import { getOdontogramPrint, getSignedOdontogramPrint } from "./odontogram.js"
import { orgDentalProfile } from "./profile.js"

/** El gráfico impreso mide 170 mm a lo ancho, como la hoja de antes (`odonto-doc-row-16`). */
const CHART_WIDTH = (170 * 72) / 25.4
/** Entre fila y fila, como el `gap-3` de la hoja en pantalla, a la escala del papel. */
const ROW_GAP = 6
/** La línea de la fuente que la norma pone al pie del gráfico. */
const NTS_SOURCE =
  "Fuente: Dirección de Salud Bucal - Dirección General de Intervenciones Estratégicas en Salud Pública"

function colorOf(value: string): RGB {
  const hex = Number.parseInt(value.replace("#", ""), 16)
  return rgb(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255)
}

function pathOf(points: readonly SheetPoint[], closed: boolean): string {
  return `${points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x} ${y}`).join(" ")}${closed ? " Z" : ""}`
}

/** Un rectángulo con esquinas redondeadas como trazo (pdf-lib no las redondea). */
function roundedRect(x: number, y: number, w: number, h: number, r: number): string {
  return [
    `M${x + r} ${y}`,
    `L${x + w - r} ${y}`,
    `Q${x + w} ${y} ${x + w} ${y + r}`,
    `L${x + w} ${y + h - r}`,
    `Q${x + w} ${y + h} ${x + w - r} ${y + h}`,
    `L${x + r} ${y + h}`,
    `Q${x} ${y + h} ${x} ${y + h - r}`,
    `L${x} ${y + r}`,
    `Q${x} ${y} ${x + r} ${y}`,
    "Z",
  ].join(" ")
}

/**
 * Una primitiva de la escena en la página: `left`/`top` es la esquina de la fila y `s`
 * su escala. Las de trazo van como camino SVG, que pdf-lib dibuja con el eje y hacia
 * abajo, igual que la escena; el grosor del trazo lo escala el propio camino.
 */
function drawShape(
  kit: DocumentKit,
  shape: SheetShape,
  left: number,
  top: number,
  s: number,
): void {
  const page = kit.page
  const px = (x: number) => left + x * s
  const py = (y: number) => top - y * s
  if (shape.kind === "text") {
    // `central`: el medio de las cifras sobre `y`; Noto mide 0,714 de alto en sus mayúsculas.
    const size = shape.size * s
    const baseline = shape.baseline === "central" ? py(shape.y) - (0.714 * size) / 2 : py(shape.y)
    kit.centeredText(shape.text, px(shape.x), baseline, {
      size,
      face: "sansBold",
      color: colorOf(shape.fill),
    })
    return
  }
  const fill = shape.fill ? colorOf(shape.fill) : undefined
  const stroke = shape.stroke ? colorOf(shape.stroke) : undefined
  const width = shape.strokeWidth ?? 1
  const cap = shape.cap === "round" ? LineCapStyle.Round : undefined
  if (shape.kind === "line") {
    if (!stroke) return
    page.drawLine({
      start: { x: px(shape.x1), y: py(shape.y1) },
      end: { x: px(shape.x2), y: py(shape.y2) },
      thickness: width * s,
      color: stroke,
      ...(cap ? { lineCap: cap } : {}),
    })
    return
  }
  if (shape.kind === "circle" || shape.kind === "ellipse") {
    const rx = shape.kind === "circle" ? shape.r : shape.rx
    const ry = shape.kind === "circle" ? shape.r : shape.ry
    page.drawEllipse({
      x: px(shape.cx),
      y: py(shape.cy),
      xScale: rx * s,
      yScale: ry * s,
      ...(fill ? { color: fill } : {}),
      ...(stroke ? { borderColor: stroke, borderWidth: width * s } : {}),
    })
    return
  }
  const d =
    shape.kind === "rect"
      ? shape.rx
        ? roundedRect(shape.x, shape.y, shape.width, shape.height, shape.rx)
        : pathOf(
            [
              [shape.x, shape.y],
              [shape.x + shape.width, shape.y],
              [shape.x + shape.width, shape.y + shape.height],
              [shape.x, shape.y + shape.height],
            ],
            true,
          )
      : shape.kind === "polygon"
        ? pathOf(shape.points, true)
        : shape.kind === "polyline"
          ? pathOf(shape.points, false)
          : shape.d
  if (!fill && !stroke) return
  // pdf-lib no recibe la unión de los trazos: se fija alrededor del camino.
  const join = stroke && shape.join === "round"
  if (join) page.pushOperators(pushGraphicsState(), setLineJoin(LineJoinStyle.Round))
  page.drawSvgPath(d, {
    x: left,
    y: top,
    scale: s,
    ...(fill ? { color: fill, opacity: shape.fillOpacity ?? 1 } : {}),
    ...(stroke
      ? {
          borderColor: stroke,
          borderWidth: width,
          ...(cap ? { borderLineCap: cap } : {}),
        }
      : {}),
  })
  if (join) page.pushOperators(popGraphicsState())
}

/** Las cuatro filas del gráfico de la norma, centradas, cada una sin partirse entre dos hojas. */
function drawChart(kit: DocumentKit, rows: SheetRow[]): void {
  const full = rows.reduce((max, row) => Math.max(max, row.width), 0)
  const s = Math.min(kit.width, CHART_WIDTH) / full
  rows.forEach((row, index) => {
    const height = row.height * s
    kit.ensure(height)
    const left = kit.left + (kit.width - row.width * s) / 2
    const top = kit.y
    for (const shape of row.shapes) drawShape(kit, shape, left, top, s)
    kit.y = top - height
    if (index < rows.length - 1) kit.gap(ROW_GAP)
  })
}

/**
 * «Especificaciones» y «Observaciones»: su título y su recuadro (de dos renglones, vacío si
 * no hay nada), compactos para que el gráfico y la firma quepan en una hoja.
 */
function notesBox(kit: DocumentKit, title: string, lines: string[]): void {
  kit.subheading(title.toLocaleUpperCase("es"), { size: SIZE.label, before: 6, after: 2 })
  const pad = 5
  const body = lines.length ? lines.join("\n") : ""
  const leading = SIZE.second * 1.4
  const laid = body ? kit.lay(body, kit.width - pad * 2, { size: SIZE.second, leading: 1.4 }) : []
  const height =
    Math.max(
      2 * leading,
      laid.reduce((sum, line) => sum + line.height, 0),
    ) +
    pad * 2
  kit.ensure(height)
  const top = kit.y
  kit.page.drawRectangle({
    x: kit.left,
    y: top - height,
    width: kit.width,
    height,
    borderColor: kit.color("gray"),
    borderWidth: 0.75,
  })
  kit.y = top - pad
  if (body)
    kit.text(body, { size: SIZE.second, leading: 1.4, indent: pad, width: kit.width - pad * 2 })
  kit.y = top - height
}

/** La clínica como estaba al firmar (`paper_header`), sobre la hoja membretada de entonces. */
type FrozenEstablishment = Awaited<ReturnType<typeof getSignedOdontogramPrint>>["establishment"]

function clinicAtSigning(clinic: DocumentClinic, frozen: FrozenEstablishment): DocumentClinic {
  if (!frozen) return clinic
  return {
    ...clinic,
    tradeName: frozen.tradeName || frozen.legalName || clinic.tradeName,
    legalName: frozen.legalName ?? null,
    fiscalDocType: frozen.fiscalDocType ?? null,
    fiscalDocNumber: frozen.fiscalDocNumber ?? null,
    address: frozen.address ?? null,
    phone: frozen.phone ?? null,
    branchName: frozen.branchName ?? null,
    brandInk: frozen.brandInk ?? null,
  }
}

interface SheetPerson {
  name: string
  patientNumber: number
  docType: string | null
  docNumber: string | null
}

/** El encabezado de la hoja: «Odontograma» y, a la derecha, la persona, su historia y la fecha. */
function sheetHeading(kit: DocumentKit, person: SheetPerson, date: string, lines: string[]): void {
  kit.gap(10)
  kit.titleWithDetails("Odontograma", [
    { text: `Paciente: ${person.name}`, strong: true },
    {
      text: [
        `Historia clínica: ${chartNumber(person.patientNumber)}`,
        person.docNumber ? `${person.docType ?? "Documento"}: ${person.docNumber}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    },
    { text: `Fecha: ${date}` },
  ])
  kit.gap(4)
  for (const line of lines) kit.text(line, { size: SIZE.second, tone: "gray", leading: 1.4 })
}

function unsignedBox(kit: DocumentKit, at: Date): void {
  kit.gap(8)
  kit.stateBox({
    kind: "draft",
    title: "Sin firmar",
    detail: `Estado del odontograma al ${dayWords(at, kit.clinic)}: lo vigente ese día, no un odontograma firmado.`,
  })
}

export interface OdontogramSheetInput {
  person: SheetPerson
  entries: SheetEntry[]
  standard: string
  /** El momento (NTS 188); nulo en el de hoy. */
  purpose: SignedOdontogramPurpose | null
  at: Date
  specifications?: string | null
  observations?: string | null
  /** Quien lo firmó, con su perfil de entonces; nulo en el de hoy, que no se firma. */
  signer: {
    name: string
    title: string | null
    registration: string | null
    strokes: Strokes | null
  } | null
}

/** La hoja de la norma (Perú): el firmado o, sin `signer`, el de hoy marcado «Sin firmar». */
export async function renderNormOdontogramPdf(
  input: OdontogramSheetInput,
  context: PaperContext,
): Promise<Uint8Array> {
  const title = input.signer ? "Odontograma firmado" : "Odontograma sin firmar"
  const kit = await DocumentKit.open(context.clinic, documentFormat(context.clinic), {
    title,
    docLabel: title,
    patientLabel: input.person.name,
    createdAt: input.at,
  })
  sheetHeading(kit, input.person, dayWords(input.at, kit.clinic), [
    `${input.standard} · Gráfico oficial`,
  ])
  if (input.purpose)
    kit.text(SIGNED_ODONTOGRAM_PURPOSE_LABELS[input.purpose], { face: "sansSemi", size: SIZE.read })
  if (!input.signer) unsignedBox(kit, input.at)
  kit.gap(8)
  const scene = odontogramSheetScene(input.entries, {
    specifications: input.specifications,
    observations: input.observations,
  })
  drawChart(kit, scene.rows)
  notesBox(kit, "Especificaciones", scene.specifications)
  notesBox(kit, "Observaciones", scene.observations)
  kit.gap(8)
  if (input.signer) {
    const signed = {
      name: input.signer.name,
      credential: credentialOf(input.signer.title, input.signer.registration),
      at: dayTimeWords(input.at, kit.clinic),
      checkUrl: context.checkUrl,
      strokes: input.signer.strokes,
    }
    kit.signedBlock(signed)
  }
  kit.gap(4)
  kit.text(NTS_SOURCE, { size: SIZE.label, tone: "gray", align: "center", leading: 1.35 })
  return kit.finish()
}

/** Las cuatro filas FDI de la hoja neutra, como se leen de frente a la persona. */
const NEUTRAL_ROWS: readonly (readonly number[])[] = [
  FDI_ADULT_ROWS[0] ?? [],
  FDI_CHILD_ROWS[0] ?? [],
  FDI_CHILD_ROWS[1] ?? [],
  FDI_ADULT_ROWS[1] ?? [],
]

interface NeutralEntry extends SheetEntry {
  diagnosisSystem?: string | null
  diagnosisCode?: string | null
}

/**
 * La hoja neutra de hoy (donde no hay odontograma oficial): la numeración FDI con las
 * piezas que tienen algo y los hallazgos por pieza en palabras, marcada «Sin firmar».
 */
export async function renderNeutralOdontogramPdf(
  input: { person: SheetPerson; entries: NeutralEntry[]; at: Date },
  context: PaperContext,
): Promise<Uint8Array> {
  const title = "Odontograma sin firmar"
  const kit = await DocumentKit.open(context.clinic, documentFormat(context.clinic), {
    title,
    docLabel: title,
    patientLabel: input.person.name,
    createdAt: input.at,
  })
  sheetHeading(kit, input.person, dayWords(input.at, kit.clinic), [
    "Numeración internacional (FDI, ISO 3950) y los hallazgos por pieza",
  ])
  unsignedBox(kit, input.at)
  const byTooth = new Map<number, NeutralEntry[]>()
  for (const entry of input.entries) {
    const teeth = entry.details?.relatedTeeth?.length
      ? entry.details.relatedTeeth
      : [entry.toothNumber]
    for (const tooth of teeth) byTooth.set(tooth, [...(byTooth.get(tooth) ?? []), entry])
  }
  kit.gap(12)
  kit.siteChart(
    NEUTRAL_ROWS.map((row) =>
      row.map((tooth) => ({ label: String(tooth), marked: byTooth.has(tooth) })),
    ),
  )
  kit.text("Marcadas, las piezas con hallazgos.", {
    size: SIZE.label,
    tone: "gray",
    align: "center",
  })
  kit.subheading("Hallazgos por pieza", { before: 14 })
  const order = new Map(NEUTRAL_ROWS.flat().map((tooth, index) => [tooth, index]))
  const teeth = [...byTooth.keys()].sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99))
  if (teeth.length === 0) kit.text("Sin hallazgos registrados.", { size: SIZE.read })
  for (const tooth of teeth) {
    const words = (byTooth.get(tooth) ?? []).map((entry) => {
      const variant = variantLabel(entry.condition, entry.details?.variant)
      return [
        variant
          ? `${conditionLabel(entry.condition)} · ${variant}`
          : conditionLabel(entry.condition),
        entry.surface ? `cara ${surfaceLabel(entry.surface).toLocaleLowerCase("es")}` : null,
        entry.diagnosisCode
          ? diagnosisCodeLabel(entry.diagnosisSystem ?? null, entry.diagnosisCode)
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    })
    kit.text(`Pieza ${tooth} · ${toothNameOf(tooth)}`, {
      face: "sansSemi",
      size: SIZE.table,
      leading: 1.4,
    })
    kit.bullets(words, { size: SIZE.table })
    kit.gap(3)
  }
  return kit.finish()
}

/** Cómo se llama el papel en la copia de la historia y en el título de su archivo. */
export function signedOdontogramLabel(purpose: SignedOdontogramPurpose): string {
  return `Odontograma firmado · ${SIGNED_ODONTOGRAM_PURPOSE_LABELS[purpose]}`
}

/**
 * El PDF de un odontograma firmado: el guardado si ya existe; si no, se dibuja con lo
 * firmado y se guarda una vez (ADR 0132). Firmado no se anula: siempre vale.
 */
export async function signedOdontogramPaper(
  tx: Db,
  orgId: string,
  patientId: string,
  assessmentId: string,
  storage: PaperStorage,
  options: { viewing?: boolean } = {},
) {
  const data = await getSignedOdontogramPrint(tx, orgId, patientId, assessmentId)
  const { assessment, patient } = data
  const purpose = assessment.purpose as SignedOdontogramPurpose
  const bytes = await issuedPaperBytes(
    tx,
    {
      orgId,
      patientId,
      patientName: assessment.patientName,
      type: "signed_odontogram",
      documentId: assessment.id,
      voided: null,
      issuedAt: assessment.createdAt,
      draw: (context) =>
        renderNormOdontogramPdf(
          {
            person: {
              name: assessment.patientName,
              patientNumber: assessment.patientNumber ?? patient.patientNumber,
              docType: patient.docType,
              docNumber: patient.docNumber,
            },
            entries: (assessment.entries ?? []) as SheetEntry[],
            standard: assessment.standard,
            purpose,
            at: new Date(assessment.createdAt),
            specifications: assessment.specifications,
            observations: assessment.observations,
            signer: {
              name: assessment.examinerName,
              title: assessment.examinerTitle || null,
              registration: assessment.registrationNumber || null,
              strokes: data.signerStrokes,
            },
          },
          { ...context, clinic: clinicAtSigning(context.clinic, data.establishment) },
        ),
    },
    storage,
    options,
  )
  return {
    bytes,
    assessment,
    label: signedOdontogramLabel(purpose),
    // Neutro, como los demás papeles: el momento no dice nada clínico.
    filename: `Odontograma-firmado-${new Date(assessment.createdAt).toISOString().slice(0, 10)}.pdf`,
    signer: [assessment.examinerName, assessment.examinerTitle, assessment.registrationNumber]
      .filter(Boolean)
      .join(" · "),
    short: SIGNED_ODONTOGRAM_PURPOSE_SHORT[purpose],
  }
}

/** Cuánto espera quien firma a que el archivo se guarde, como `keepIssuedPaper`. */
const KEEP_PAPER_WAIT_MS = 5000

/**
 * Deja guardado el odontograma recién firmado, ya confirmada la firma. Si falla no deshace
 * nada: se guarda la primera vez que alguien lo abra. Si el almacenamiento tarda, se
 * responde igual y sigue guardándose (la misma regla que `keepIssuedPaper`).
 */
export async function keepSignedOdontogramPaper(input: {
  run: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>
  storage: PaperStorage
  orgId: string
  patientId: string
  assessmentId: string
  waitMs?: number
}): Promise<void> {
  const work = input
    .run((tx) =>
      signedOdontogramPaper(tx, input.orgId, input.patientId, input.assessmentId, input.storage),
    )
    .then(
      () => undefined,
      (error: unknown) => console.error("No se guardó el odontograma firmado", error),
    )
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    work,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, input.waitMs ?? KEEP_PAPER_WAIT_MS)
    }),
  ])
  clearTimeout(timer)
}

/**
 * El odontograma de hoy, sin firmar y sin guardar: lo vigente ahora. En Perú, con el
 * gráfico de la norma; fuera, la hoja neutra. Sin hallazgos es null, salvo con `always`
 * (hay firmados antes): entonces el gráfico vacío dice que hoy ya no queda nada.
 */
export async function todayOdontogramPaper(
  tx: Db,
  orgId: string,
  patientId: string,
  options: { always?: boolean; at?: Date } = {},
) {
  const at = options.at ?? new Date()
  const print = await getOdontogramPrint(tx, orgId, patientId)
  const official = (await orgDentalProfile(tx, orgId)).odontogram
  const entries = print.entries as NeutralEntry[]
  if (entries.length === 0 && !options.always) return null
  const person = {
    name: print.patient.displayName,
    patientNumber: print.patient.patientNumber,
    docType: print.patient.docType,
    docNumber: print.patient.docNumber,
  }
  const context: PaperContext = { clinic: await loadDocumentClinic(tx, orgId), checkUrl: null }
  const bytes = official
    ? await renderNormOdontogramPdf(
        { person, entries, standard: official.standard, purpose: null, at, signer: null },
        context,
      )
    : await renderNeutralOdontogramPdf({ person, entries, at }, context)
  return {
    bytes,
    at,
    /** «18 de noviembre de 2026» y «2026-11-18», en el día de la clínica. */
    dayWords: dayWords(at, context.clinic),
    isoDay: new Intl.DateTimeFormat("en-CA", { timeZone: context.clinic.timezone }).format(at),
  }
}
