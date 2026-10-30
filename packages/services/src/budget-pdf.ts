/**
 * La hoja del presupuesto (ADR 0112): lo que encontramos, lo que le proponemos, cómo
 * se haría, lo que debe saber antes de decidir y su decisión. Una opción, o la tabla
 * comparativa de dos o tres; en odentIA por etapas, en latidIA sin ellas. El flujo pasa
 * de página con su encabezado corto: nunca se corta un contenido por ajustarlo.
 *
 * Un borrador lleva marca BORRADOR, sin QR ni firma: generar la vista previa nunca lo
 * presenta como entregado. Entregar es un cambio explícito (`deliverBudget`).
 */

import { canAccess } from "@odentia/auth/permissions"
import { budgetAnswerText, formatMoney, type PatientGuide } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  type BudgetPrintLine,
  type BudgetPrintOption,
  type BudgetPrintPayload,
  getBudgetPrintPayload,
} from "./budgets.js"
import { credentialOf } from "./clinical-papers.js"
import {
  ageWords,
  type Block,
  type Cell,
  chartNumber,
  type DocumentClinic,
  DocumentKit,
  dayTimeWords,
  dayWords,
  documentFormat,
  SIZE,
} from "./document-kit.js"
import { listDecisionRecipients } from "./responsibilities.js"

export { documentFormat as budgetFormat } from "./document-kit.js"

export interface BudgetSnapshot extends BudgetPrintPayload {
  kind: "budget"
  sourceId: string
  numberLabel: string
  org: DocumentClinic
}

/**
 * La hoja desde su contenido (`getBudgetPrintPayload`). `actor` aplica la misma frontera
 * que la pantalla: un odontólogo solo obtiene la hoja de sus planes. Lo clínico va si
 * quien imprime lee lo clínico, o si el destinatario es la propia persona o su
 * representante legal; si no, se omite.
 */
export async function buildBudgetSnapshot(
  tx: Db,
  orgId: string,
  patientId: string,
  budgetId: string,
  actor: { actorUserId?: string; memberRole?: string; recipientContactId?: string | null } = {},
): Promise<BudgetSnapshot> {
  const toAuthorized = actor.recipientContactId
    ? (await listDecisionRecipients(tx, orgId, patientId)).some(
        (row) => row.contactId === actor.recipientContactId,
      )
    : false
  const clinicalAccess =
    toAuthorized || (!!actor.memberRole && canAccess(actor.memberRole, "clinical.read"))
  const payload = await getBudgetPrintPayload(tx, orgId, patientId, budgetId, {
    ...(actor.actorUserId ? { actorUserId: actor.actorUserId } : {}),
    ...(actor.memberRole ? { memberRole: actor.memberRole } : {}),
    clinicalAccess,
  })
  return {
    ...payload,
    kind: "budget",
    sourceId: budgetId,
    numberLabel: `N.º ${String(payload.budgetNumber).padStart(4, "0")}${
      payload.revisionNumber > 1 ? ` · revisión ${payload.revisionNumber}` : ""
    }`,
    org: payload.documentClinic,
  }
}

/**
 * Las sesiones del plan cuando no lo dice la explicación. Con explicación, una sola sesión
 * prevista es el valor por defecto del plan, no un dato: no se promete «1 visita».
 */
function plannedVisits(line: BudgetPrintLine): number | null {
  const planned = line.plannedSessions ?? line.sessionsPlanned
  if (!planned) return null
  return line.guide && planned <= 1 ? null : planned
}

/** Visitas de una línea: las de su explicación o las del plan. */
function visitRange(line: BudgetPrintLine): { min: number; max: number } | null {
  const match = line.guide?.visits?.match(/(\d+)(?:\s*(?:a|-|–)\s*(\d+))?/)
  if (match) {
    const min = Number(match[1])
    return { min, max: match[2] ? Number(match[2]) : min }
  }
  const planned = plannedVisits(line)
  return planned ? { min: planned, max: planned } : null
}

function rangeWords(range: { min: number; max: number } | null): string {
  if (!range) return ""
  return range.min === range.max ? String(range.min) : `${range.min} a ${range.max}`
}

function addRanges(lines: BudgetPrintLine[]): { min: number; max: number } | null {
  const ranges = lines
    .map(visitRange)
    .filter((range): range is { min: number; max: number } => range !== null)
  if (ranges.length === 0) return null
  return ranges.reduce((sum, range) => ({ min: sum.min + range.min, max: sum.max + range.max }))
}

function upperFirstWord(text: string): string {
  return text.charAt(0).toLocaleUpperCase("es") + text.slice(1)
}

/** «Pieza 46 · 1 a 2 visitas de 60 a 90 minutos». */
function lineMeta(line: BudgetPrintLine): string {
  const planned = plannedVisits(line)
  const visits = line.guide?.visits ?? (planned ? String(planned) : null)
  const length =
    line.guide?.visitLength ?? (line.durationMin ? `${line.durationMin} minutos` : null)
  const plural = visits && !/^1$/.test(visits.trim()) ? "visitas" : "visita"
  const visitWords = visits ? `${visits} ${plural}${length ? ` de ${length}` : ""}` : length
  return [line.detail ? upperFirstWord(line.detail) : null, visitWords].filter(Boolean).join(" · ")
}

/** Lo que dice una línea en su detalle: cómo se hace, qué incluye y qué sigue. */
function guideBlocks(guide: PatientGuide | null): Block[] {
  if (!guide) return []
  const small = { size: SIZE.second, tone: "soft" as const, leading: 1.4 }
  return [
    ...(guide.how ? [{ inlines: guide.how, size: SIZE.dense, leading: 1.42, gapBefore: 2.5 }] : []),
    ...(guide.includes
      ? [
          {
            inlines: [{ text: "Incluye: ", face: "sansSemi" as const }, guide.includes],
            ...small,
            gapBefore: 1.5,
          },
        ]
      : []),
    ...(guide.aftercare
      ? [{ inlines: [{ text: "Después: ", face: "sansSemi" as const }, guide.aftercare], ...small }]
      : []),
  ]
}

const unique = (items: string[]) => [...new Set(items.map((item) => item.trim()).filter(Boolean))]

/** Lo que hay que pesar y lo que cierra el papel: igual con una opción o con varias. */
function beforeDeciding(kit: DocumentKit, snap: BudgetSnapshot, lines: BudgetPrintLine[]) {
  const words = snap.words
  const excludes = unique(lines.flatMap((line) => line.guide?.excludes?.split(/\n+/) ?? []))
  const consequences = unique(snap.consents.map((consent) => consent.consequences))
  const alternatives = unique(snap.consents.flatMap((consent) => consent.alternatives))
  const risks = unique(snap.consents.flatMap((consent) => consent.risks))
  const cells: Array<{ title: string; body: string | string[] }> = []
  if (consequences.length > 0) cells.push({ title: words.noCare, body: consequences.join(" ") })
  if (alternatives.length > 0) cells.push({ title: "Otra alternativa", body: alternatives })
  if (risks.length > 0) {
    const titles = unique(snap.consents.map((consent) => consent.title))
    cells.push({
      title: "Riesgos principales",
      body: [
        ...risks,
        `Antes de empezar los verá con su profesional y firmará su consentimiento: ${titles.join(", ")}.`,
      ],
    })
  }
  if (excludes.length > 0) cells.push({ title: "Qué no incluye", body: excludes })
  if (snap.terms.change) cells.push({ title: words.change, body: snap.terms.change })
  if (snap.terms.payment) {
    const methods =
      snap.paymentMethods.length > 0 ? ` Aceptamos ${listWords(snap.paymentMethods)}.` : ""
    cells.push({ title: "Cómo se paga", body: `${snap.terms.payment}${methods}` })
  }
  const schedule = lines.flatMap((line) => line.guide?.schedule ?? [])
  const warnings = unique(lines.flatMap((line) => line.guide?.warnings?.split(/\n+/) ?? []))
  if (schedule.length > 0) {
    kit.heading("Su calendario", { size: SIZE.h2, before: 14, after: 6, keep: 60 })
    kit.table({
      columns: [{ label: "Cuándo", width: 120 }, { label: "Qué" }],
      size: SIZE.dense,
      rowPad: 4.5,
      rows: schedule.map((step) => [
        [{ inlines: step.when, face: "sansSemi" as const }],
        step.what,
      ]),
    })
  }
  if (cells.length > 0) {
    kit.heading("Lo que debe saber antes de decidir", {
      size: SIZE.h2,
      before: 16,
      after: 8,
      keep: 60,
    })
    kit.grid(cells)
  }
  if (warnings.length > 0) {
    kit.gap(4)
    kit.panel({
      title: "Vaya a emergencia o llámenos si tiene",
      body: warnings.join(" "),
      thickness: 1.5,
      size: SIZE.dense,
    })
  }
  if (snap.notes) {
    kit.gap(6)
    kit.subheading("Notas", { size: SIZE.dense })
    kit.text(snap.notes, { size: SIZE.dense })
  }
}

function listWords(items: string[]): string {
  if (items.length < 2) return items.join("")
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`
}

/** «Su decisión»: el QR de su enlace, las casillas y las firmas; o lo que ya respondió. */
function yourDecision(
  kit: DocumentKit,
  snap: BudgetSnapshot,
  lines: BudgetPrintLine[],
  money: (cents: number | null) => string,
) {
  const zone = snap.org
  const hasOptions = snap.options.length > 1
  // El teléfono no se parte en dos líneas.
  const phone = snap.org.phone
    ? ` ¿Dudas? Llámenos al ${snap.org.phone.replaceAll(" ", "\u00a0")}.`
    : ""
  // La decisión va entera en una página si cabe: casillas y firma no se separan.
  const needed = 190 + (hasOptions ? 40 : lines.length * 24) + (snap.personalLinkUrl ? 76 : 0)
  if (kit.room() < needed && needed <= kit.freshPageRoom()) kit.newPage()
  kit.ensure(150)
  // Arriba de una página ya hay una regla: la del encabezado corto.
  if (!kit.atPageTop) {
    kit.gap(14)
    kit.rule({ tone: "ink", thickness: 1.5, gapAfter: 10 })
  }
  kit.heading("Su decisión", { size: SIZE.h2small, before: 0, after: 6 })

  if (snap.decisionWords) {
    const { text, by, at } = snap.decisionWords
    kit.panel({
      body: [text, by, at ? dayTimeWords(at, zone) : null].filter(Boolean).join(" · "),
      size: SIZE.table,
    })
    kit.gap(8)
    kit.table({
      columns: [
        { label: snap.words.item },
        { label: "Importe", width: 80, align: "right" },
        { label: "Su respuesta", width: 110, align: "right" },
      ],
      size: SIZE.dense,
      rows: lines.map((line) => [
        lineLabel(line),
        money(line.totalCents),
        budgetAnswerText(line.decision),
      ]),
    })
    return
  }

  const canAnswer = !snap.isDraft && snap.status === "presentado"
  if (canAnswer && snap.personalLinkUrl) {
    kit.qrPanel({
      url: snap.personalLinkUrl,
      title: hasOptions
        ? "Elija desde su celular, sin imprimir"
        : "Responda desde su celular, sin imprimir",
      body: hasOptions
        ? `Escanee el código, revise las opciones y elija una.${phone}`
        : `Escanee el código, revise el presupuesto y responda.${phone}`,
    })
    kit.gap(9)
  }
  if (hasOptions) {
    kit.text([{ text: "O hágalo aquí: ", face: "sansSemi" }, "marque una casilla y firme."], {
      size: SIZE.second,
      tone: "soft",
    })
    kit.gap(7)
    kit.choiceRow("Elijo la opción", [
      ...snap.options.map((option) => option.label.replace(/^Opción\s*/, "")),
      "Lo voy a pensar",
    ])
  } else {
    kit.text(
      [
        { text: "O hágalo aquí: ", face: "sansSemi" },
        `marque una casilla por ${snap.words.itemLower} y firme. Puede aceptar solo una parte y retomar lo demás cuando quiera.`,
      ],
      { size: SIZE.second, tone: "soft" },
    )
    kit.gap(6)
    const box: Block[] = [{ checkbox: true }]
    kit.table({
      columns: [
        { label: snap.words.item },
        { label: "Importe", width: 76, align: "right" },
        { label: "Acepto", width: 42, align: "center", pad: 0 },
        { label: "Después", width: 48, align: "center", pad: 0 },
        { label: "No", width: 36, align: "center", pad: 0 },
      ],
      size: SIZE.dense,
      rowPad: 3.75,
      rows: lines.map((line) => [lineLabel(line), money(line.totalCents), box, box, box]),
    })
  }
  // La firma de quien emite no va en un borrador: aún no se entrega.
  const signer = !snap.isDraft && snap.professional ? snap.professional : null
  kit.ensure(70)
  kit.gap(signer ? 12 : 30)
  const top = kit.y
  const half = (kit.width - 21) / 2
  const captionY = top - (signer ? 36 : 0)
  kit.page.drawLine({
    start: { x: kit.left, y: captionY },
    end: { x: kit.left + half, y: captionY },
    thickness: 0.75,
    color: kit.color("ink"),
  })
  kit.y = captionY - 3
  kit.text("Nombre y firma del paciente o su representante, y fecha", {
    size: SIZE.second,
    tone: "gray",
    width: half,
    leading: 1.4,
  })
  const bottom = kit.y
  if (signer) {
    const x = half + 21
    kit.y = top
    const credential = credentialOf(signer.title, signer.registration)
    kit.text(`Firmado electrónicamente, ${dayWords(snap.issuedAt, zone)}`, {
      size: SIZE.label,
      face: "sansSemi",
      tone: "gray",
      indent: x,
      width: half,
      leading: 1.35,
    })
    kit.text(signer.name, {
      size: SIZE.dense,
      face: "sansSemi",
      indent: x,
      width: half,
      leading: 1.4,
    })
    if (credential)
      kit.text(credential, {
        size: SIZE.second,
        tone: "gray",
        indent: x,
        width: half,
        leading: 1.4,
      })
    kit.y = Math.min(kit.y, bottom)
  }
}

/** «Endodoncia posterior vital, pieza 46». */
function lineLabel(line: BudgetPrintLine): string {
  return line.detail ? `${line.title}, ${line.detail}` : line.title
}

/** Lo que dice el precio de una línea, con su forma si se cobra por visita. */
function linePrice(line: BudgetPrintLine, money: (cents: number | null) => string): string {
  if (line.totalCents === 0) return "Incluido"
  if (line.units > 1) return `${line.units} × ${money(line.unitCents)} = ${money(line.totalCents)}`
  return money(line.totalCents)
}

function paymentNotes(line: BudgetPrintLine, money: (cents: number | null) => string): Block[] {
  const notes: Block[] = []
  const small = { size: SIZE.second, tone: "gray" as const, leading: 1.4 }
  if (line.billingMode === "session") {
    // Lo que se cobra por sesión: el paciente ve el total, pero la deuda nace visita a visita.
    notes.push({
      inlines: `Se cobra por sesión: ${money(line.unitCents)} en cada visita · ${line.units} ${line.units === 1 ? "visita prevista" : "visitas previstas"}`,
      ...small,
    })
  }
  if ((line.discountCents ?? 0) > 0) {
    const reason = line.promotionName ? `Promoción ${line.promotionName}` : "Descuento"
    notes.push({
      inlines: `${reason}: − ${money(line.discountCents)} (de ${money(line.listTotalCents)})`,
      ...small,
    })
  }
  return notes
}

/** Una línea con todo lo que explica: nombre e importe, sitio y visitas, cómo se hace. */
function lineDetailRow(line: BudgetPrintLine, money: (cents: number | null) => string): Cell[] {
  const meta = lineMeta(line)
  return [
    [
      { inlines: line.title, size: SIZE.table, face: "sansSemi" },
      ...(meta ? [{ inlines: meta, size: SIZE.second, tone: "gray" as const, leading: 1.4 }] : []),
      ...paymentNotes(line, money),
      ...guideBlocks(line.guide),
    ],
    [{ inlines: linePrice(line, money), size: SIZE.dense, face: "sansSemi", align: "right" }],
  ]
}

/** Las columnas del detalle: el importe ocupa solo lo que necesita, y el texto, lo demás. */
function detailColumns(
  kit: DocumentKit,
  lines: BudgetPrintLine[],
  money: (cents: number | null) => string,
) {
  const width =
    Math.max(
      ...lines.map((line) => kit.textWidth(linePrice(line, money), "sansSemi", SIZE.dense)),
    ) + 14
  return [{ label: "" }, { label: "", width, align: "right" as const, pad: 0 }]
}

/** Lo que encontramos: la grilla del producto, el texto y el diagnóstico por línea. */
function findingsSection(kit: DocumentKit, snap: BudgetSnapshot, lines: BudgetPrintLine[]) {
  const hasOptions = snap.options.length > 1
  const withDiagnosis = lines.filter((line) => line.diagnosis)
  // Sin texto del profesional, el nombre del diagnóstico.
  const fallback = unique(withDiagnosis.map((line) => line.diagnosis?.title ?? "")).join(". ")
  const codes = unique(
    withDiagnosis.map((line) =>
      line.diagnosis?.title
        ? `${line.diagnosis.label} · ${line.diagnosis.title}`
        : (line.diagnosis?.label ?? ""),
    ),
  )
  const text = hasOptions
    ? [
        snap.findings ?? fallback,
        snap.findings && codes.some((code) => !snap.findings?.includes(code))
          ? `(${codes.join("; ")})`
          : null,
      ]
        .filter(Boolean)
        .join(" ") || null
    : (snap.findings ?? (snap.chart ? null : fallback || null))
  if (!text && withDiagnosis.length === 0 && !snap.chart && snap.allergies.length === 0) return
  kit.heading(snap.words.findings, { size: SIZE.h2small, before: 15, after: 6, keep: 40 })
  if (snap.chart && !hasOptions) {
    kit.siteChart(snap.chart.rows)
    kit.gap(6)
  }
  if (text) {
    kit.text(text, { size: SIZE.dense, leading: 1.42 })
    kit.gap(6)
  }
  if (withDiagnosis.length > 0 && !hasOptions) {
    const sited = withDiagnosis.some((line) => line.detail)
    kit.table({
      columns: [
        ...(sited ? [{ label: snap.chart?.label ?? "Dónde", width: 96 }] : []),
        { label: "Diagnóstico" },
      ],
      size: SIZE.dense,
      rowPad: 4,
      closed: false,
      rows: dedupeRows(withDiagnosis).map((line) => {
        const code = line.diagnosis?.title
          ? `${line.diagnosis.label} · ${line.diagnosis.title}`
          : (line.diagnosis?.label ?? "")
        return sited
          ? [[{ inlines: upperFirstWord(line.detail ?? "—"), face: "sansBold" as const }], code]
          : [code]
      }),
    })
    kit.gap(6)
  }
  if (snap.allergies.length > 0) {
    kit.text(
      [
        { text: "A tener en cuenta: ", face: "sansSemi" },
        `tiene alergia registrada a ${listWords(snap.allergies)}.`,
      ],
      { size: SIZE.dense },
    )
  }
}

/** El mismo sitio y el mismo diagnóstico, una sola vez. */
function dedupeRows(lines: BudgetPrintLine[]): BudgetPrintLine[] {
  const seen = new Set<string>()
  return lines.filter((line) => {
    const key = `${line.detail}|${line.diagnosis?.label}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Una opción: por etapas si el producto las tiene, si no, «Qué se haría». */
function singleOption(
  kit: DocumentKit,
  snap: BudgetSnapshot,
  money: (cents: number | null) => string,
) {
  const lines = snap.lines
  const staged = snap.phases.length > 0
  const proposal = () => {
    if (!snap.proposal) return
    kit.heading("Lo que le proponemos", { size: SIZE.h2small, before: 13, after: 3, keep: 30 })
    kit.text(snap.proposal, { size: SIZE.table })
  }
  findingsSection(kit, snap, lines)
  proposal()
  const visits = addRanges(lines)
  const visitsWords = visits
    ? ` · unas ${rangeWords(visits)} ${visits.max === 1 ? "visita" : "visitas"}`
    : ""
  const totalLine = () => {
    kit.total([{ text: "Total", face: "sansSemi" }, visitsWords], money(snap.totalCents))
  }
  if (!staged) {
    // Sin etapas: lo que se haría va de una vez, con su explicación.
    kit.heading(snap.words.steps, { size: SIZE.h2small, before: 14, after: 3, keep: 60 })
    kit.rule({ tone: "ink" })
    kit.table({
      columns: detailColumns(kit, lines, money),
      size: SIZE.dense,
      rowPad: 6.5,
      rows: lines.map((line) => lineDetailRow(line, money)),
    })
    totalLine()
    return
  }
  // El resumen por etapa con el total, y el detalle después.
  const stages = snap.phases.flatMap((phase) => {
    const inPhase = lines.filter((line) => line.phase === phase.key)
    return inPhase.length > 0 ? [{ ...phase, lines: inPhase }] : []
  })
  const others = lines.filter((line) => !snap.phases.some((phase) => phase.key === line.phase))
  if (others.length > 0) stages.push({ key: "", label: "Otros", lines: others })
  kit.gap(10)
  kit.table({
    columns: [
      { label: "Etapa" },
      { label: "Visitas", width: 50 },
      { label: "Importe", width: 82, align: "right", pad: 0 },
    ],
    size: SIZE.dense,
    rowPad: 4.5,
    rows: stages.map((stage, index) => {
      const total = stage.lines.reduce((sum, line) => sum + (line.totalCents ?? 0), 0)
      const names = stage.lines.map(lineLabel).join("; ")
      return [
        [
          {
            inlines: [{ text: `${index + 1}. ${stage.label}: `, face: "sansSemi" as const }, names],
          },
        ],
        rangeWords(addRanges(stage.lines)),
        total === 0 ? "Incluido" : money(total),
      ]
    }),
  })
  totalLine()
  // El paso a paso abre página si queda poco espacio para arrancarlo.
  if (kit.room() < kit.format.height * 0.4) kit.newPage()
  else kit.gap(10)
  kit.heading(snap.words.steps, { size: SIZE.h2, before: 6, after: 2, keep: 60 })
  stages.forEach((stage, index) => {
    kit.heading(`${index + 1}. ${stage.label}`, {
      face: "sansBold",
      size: SIZE.dense,
      leading: 1.4,
      before: 10,
      after: 2,
      keep: 30,
    })
    kit.rule({ tone: "ink" })
    kit.table({
      columns: detailColumns(kit, lines, money),
      size: SIZE.dense,
      rowPad: 6,
      closed: false,
      rows: stage.lines.map((line) => lineDetailRow(line, money)),
    })
  })
}

/** Con 2 o 3 opciones: la tabla para comparar, y qué incluye cada una. */
function manyOptions(
  kit: DocumentKit,
  snap: BudgetSnapshot,
  money: (cents: number | null) => string,
) {
  const options = snap.options
  const all = options.flatMap((option) => option.lines)
  findingsSection(kit, snap, all)
  const count = options.length === 2 ? "Hay dos caminos" : "Hay tres caminos"
  kit.gap(6)
  kit.text(
    [
      `${count}: `,
      { text: "elija uno", face: "sansSemi" },
      ". Cada uno tiene su propio total; no se suman.",
    ],
    { size: SIZE.dense },
  )
  if (snap.proposal) {
    kit.gap(4)
    kit.text(snap.proposal, { size: SIZE.dense })
  }
  kit.gap(10)
  const labelWidth = 66
  const columnWidth = (kit.width - labelWidth) / options.length
  const heads = () => {
    const height = 37
    kit.ensure(height + 20)
    const top = kit.y
    options.forEach((option, index) => {
      const x = kit.left + labelWidth + index * columnWidth
      if (option.isRecommended) {
        kit.page.drawRectangle({
          x,
          y: top - height,
          width: columnWidth,
          height,
          color: kit.color("ink"),
        })
      } else {
        kit.page.drawRectangle({
          x,
          y: top - height,
          width: columnWidth,
          height,
          borderColor: kit.color("gray"),
          borderWidth: 0.5,
        })
      }
      const tone = option.isRecommended ? ("white" as const) : ("ink" as const)
      kit.y = top - 5
      kit.text(option.label, {
        face: "serif",
        size: 12.75,
        tone,
        indent: labelWidth + index * columnWidth + 6,
        width: columnWidth - 12,
        leading: 1.25,
      })
      const state =
        option.decision === "elegida"
          ? "Elegida"
          : option.decision === "no_elegida"
            ? "No elegida"
            : option.isRecommended
              ? "Recomendada"
              : ""
      if (state)
        kit.text(state, {
          size: SIZE.label,
          face: "sansSemi",
          tone,
          indent: labelWidth + index * columnWidth + 6,
          width: columnWidth - 12,
          leading: 1.25,
        })
    })
    kit.y = top - height
  }
  const row = (label: string, values: Array<string | null>, strong = false): Cell[] => [
    [{ inlines: label, size: SIZE.label, face: "sansSemi", tone: "gray" }],
    ...values.map(
      (value): Cell => [
        {
          inlines: value ?? "—",
          size: SIZE.second,
          leading: 1.4,
          face: strong ? "sansSemi" : "sans",
        },
      ],
    ),
  ]
  const rows: Cell[][] = []
  if (options.some((option) => option.name))
    rows.push(
      row(
        "Nombre",
        options.map((option) => option.name),
        true,
      ),
    )
  rows.push(
    row(
      "Qué se hace",
      options.map((option) => option.lines.map(lineLabel).join("; ")),
    ),
  )
  rows.push(
    row(
      "Visitas",
      options.map((option) => rangeWords(addRanges(option.lines)) || null),
    ),
  )
  if (options.some((option) => option.pros))
    rows.push(
      row(
        "A favor",
        options.map((option) => option.pros),
      ),
    )
  if (options.some((option) => option.cons))
    rows.push(
      row(
        "A considerar",
        options.map((option) => option.cons),
      ),
    )
  rows.push([
    [{ inlines: "Total", size: SIZE.dense, face: "sansBold" }],
    ...options.map(
      (option): Cell => [
        { inlines: money(option.totalCents), face: "serif", size: SIZE.h2small, leading: 1.25 },
      ],
    ),
  ])
  kit.table({
    columns: [
      { label: "", width: labelWidth, pad: 6 },
      ...options.map(() => ({ label: "", width: columnWidth, pad: 6 })),
    ],
    head: heads,
    rowPad: 5.5,
    size: SIZE.second,
    rows,
  })
  if (kit.room() < kit.format.height * 0.35) kit.newPage()
  else kit.gap(8)
  kit.heading("Qué incluye cada opción", { size: SIZE.h2, before: 8, after: 4, keep: 60 })
  for (const option of options) {
    const title =
      [option.label, option.name].filter(Boolean).join(" · ") +
      (option.isRecommended ? " (recomendada)" : "")
    kit.heading(title, {
      face: "sansBold",
      size: SIZE.table,
      leading: 1.4,
      before: 9,
      after: 2,
      keep: 30,
    })
    kit.rule({ tone: "ink" })
    kit.table({
      columns: [{ label: "" }, { label: "", width: 130, align: "right", pad: 0 }],
      size: SIZE.dense,
      rowPad: 3.75,
      closed: false,
      rows: option.lines.map((line) => [
        [{ inlines: lineLabel(line) }, ...paymentNotes(line, money)],
        [{ inlines: linePrice(line, money), align: "right" as const }],
      ]),
    })
    kit.spread(
      { text: `Total ${option.label.replace(/^Opción/, "opción")}`, face: "sansBold" },
      { text: money(option.totalCents), face: "sansBold" },
      { size: SIZE.dense, leading: 1.6 },
    )
  }
}

function linesOfDecision(snap: BudgetSnapshot): BudgetPrintLine[] {
  if (snap.options.length <= 1) return snap.lines
  const chosen: BudgetPrintOption | undefined = snap.options.find(
    (option) => option.decision === "elegida",
  )
  return chosen?.lines ?? snap.lines
}

export async function renderBudgetPdf(
  snap: BudgetSnapshot,
  paper?: string | null,
): Promise<Uint8Array> {
  const org = snap.org
  const money = (cents: number | null) =>
    cents == null ? "por definir" : formatMoney(cents, snap.currency, org.locale)
  const docLabel = `Presupuesto ${snap.numberLabel}`
  const kit = await DocumentKit.open(org, documentFormat(org, paper), {
    title: snap.words.title,
    docLabel,
    patientLabel: snap.patient.displayName,
    legalNote: "Este presupuesto no es un documento fiscal.",
    createdAt: new Date(snap.issuedAt),
  })
  kit.gap(16)
  kit.text(snap.words.title, { face: "serif", size: SIZE.titleBudget, leading: 1.15 })
  kit.gap(3)
  kit.spread(
    [
      { text: snap.numberLabel, size: SIZE.table, face: "sansSemi" },
      { text: ` · ${dayWords(snap.issuedAt, org)}`, tone: "gray" },
    ],
    snap.validUntil && !snap.isDraft
      ? { text: `Vigente hasta el ${dayWords(snap.validUntil, org)}`, face: "sansSemi" }
      : "",
    { size: SIZE.second, leading: 1.45 },
  )
  if (snap.isDraft) {
    kit.gap(8)
    kit.stateBox({ kind: "draft", title: "BORRADOR", detail: "Documento no entregado." })
  } else if (snap.status === "cancelado") {
    kit.gap(8)
    kit.stateBox({ kind: "alert", title: "ANULADO", detail: null })
  } else if (snap.status === "sustituido") {
    kit.gap(8)
    kit.stateBox({
      kind: "note",
      title: "Sustituido por una revisión",
      detail: "Este presupuesto ya no vale: vale su revisión.",
    })
  }
  kit.gap(10)
  const person = snap.patient
  const personSub = [
    person.docNumber ? `${person.docType ?? "Doc."} ${person.docNumber}` : null,
    ageWords(person.birthDate, org),
    chartNumber(person.patientNumber),
  ]
    .filter(Boolean)
    .join(" · ")
  const professionalSub = snap.professional
    ? credentialOf(snap.professional.title, snap.professional.registration)
    : null
  kit.facts(
    [
      { label: "Paciente", value: person.displayName, sub: personSub, strong: true },
      ...(snap.professional
        ? [
            {
              label: "Le atiende",
              value: snap.professional.name,
              strong: true,
              ...(professionalSub ? { sub: professionalSub } : {}),
            },
          ]
        : []),
    ],
    2,
    { pad: 7.5 },
  )
  const lines =
    snap.options.length > 1 ? snap.options.flatMap((option) => option.lines) : snap.lines
  if (snap.options.length > 1) manyOptions(kit, snap, money)
  else singleOption(kit, snap, money)
  // Lo que debe saber abre página si queda poco espacio.
  if (kit.room() < kit.format.height * 0.3) kit.newPage()
  beforeDeciding(kit, snap, lines)
  yourDecision(kit, snap, linesOfDecision(snap), money)
  return kit.finish()
}
