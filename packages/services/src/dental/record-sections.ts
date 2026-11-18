/**
 * Lo dental de la copia de la historia (mesa del 18 nov): el odontograma de hoy por pieza, con lo
 * anulado y su motivo, y cada periodontograma como tabla, sitio por sitio, con su clasificación.
 * En FHIR R4, una Observation por pieza (la pieza en `ex-tooth`, la numeración FDI de ISO 3950, y
 * el hallazgo con su código CIE si lo tiene) y una por periodontograma con su clasificación y sus
 * índices. El papel firmado del odontograma va aparte, en su PDF (`recordPapers`).
 */
import { DIAGNOSIS_SYSTEM_INFO, FHIR_UCUM_SYSTEM, isDiagnosisSystem } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  attachmentLoss,
  conditionLabel,
  type PeriodontalClassification,
  type PeriodontalToothRecord,
  periodontalClassificationShort,
  PERI_IMPLANT_WORDS,
  PERIODONTAL_SITE_WORDS,
  PERIODONTAL_SITES,
} from "@odentia/dental"
import { dayWords } from "../document-kit.js"
import { findOrgLocale } from "../locale.js"
import type { RecordSection, RecordSectionBlock } from "../product-hooks.js"
import { getOdontogram } from "./odontogram.js"
import {
  comparePeriodontalCharts,
  getPeriodontalChart,
  listPeriodontalCharts,
  type PeriodontalChartView,
} from "./periodontal.js"
import { fhirSurfaceCoding, fhirToothCoding, surfaceWords } from "./site.js"

type Resource = Record<string, unknown> & { resourceType: string; id: string }

const CATEGORY_EXAM = {
  coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "exam" }],
}

function codeable(system: string | null, code: string | null, text: string) {
  const uri = system && isDiagnosisSystem(system) ? DIAGNOSIS_SYSTEM_INFO[system].uri : null
  return { ...(code && uri ? { coding: [{ system: uri, code }] } : {}), text }
}

/** «3 2 4»: los tres sitios de una cara, en mm; «·» lo que no se midió. */
function three(values: ReadonlyArray<number | null>, indexes: readonly number[]): string {
  return indexes
    .map((index) =>
      values[index] === null || values[index] === undefined ? "·" : String(values[index]),
    )
    .join(" ")
}

const BUCCAL = [0, 1, 2]
const LINGUAL = [3, 4, 5]

/** La tabla de un periodontograma: por pieza, sondaje, margen y nivel de inserción por cara. */
function chartTable(view: PeriodontalChartView): NonNullable<RecordSectionBlock["table"]> {
  const rows = view.teeth.map((tooth: PeriodontalToothRecord) => {
    const implant = view.implantTeeth.includes(tooth.toothNumber)
    const name = `${tooth.toothNumber}${implant ? " (implante)" : ""}`
    if (tooth.skipped) return [name, "no se midió", "", "", "", "", "", "", "", ""]
    const cal = tooth.probingDepth.map((depth, index) =>
      attachmentLoss(depth, tooth.recession[index] ?? null),
    )
    const bleeding = tooth.bleeding.filter(Boolean).length
    const furcation = Object.entries(tooth.furcation ?? {})
      .map(([entry, grade]) => `${entry.slice(0, 1).toUpperCase()}${grade}`)
      .join(" ")
    const plaque = tooth.plaque
      ? `${tooth.plaque.filter(Boolean).length}/${tooth.plaque.length}`
      : ""
    return [
      name,
      three(tooth.probingDepth, BUCCAL),
      three(tooth.probingDepth, LINGUAL),
      three(tooth.recession, BUCCAL),
      three(tooth.recession, LINGUAL),
      three(cal, BUCCAL),
      three(cal, LINGUAL),
      `${bleeding}${tooth.suppuration.some(Boolean) ? " · supura" : ""}`,
      tooth.mobility === null ? "" : `M${tooth.mobility}`,
      [
        furcation,
        plaque ? `placa ${plaque}` : "",
        implant && tooth.periImplant ? PERI_IMPLANT_WORDS[tooth.periImplant] : "",
      ]
        .filter(Boolean)
        .join(" · "),
    ]
  })
  return {
    columns: [
      "Pieza",
      "Sondaje V",
      "Sondaje L/P",
      "Margen V",
      "Margen L/P",
      "NIC V",
      "NIC L/P",
      "Sangra",
      "Mov.",
      "Furca, placa",
    ],
    rows,
  }
}

export async function dentalRecordSections(
  tx: Db,
  orgId: string,
  patientId: string,
): Promise<RecordSection[]> {
  const patientRef = { reference: `Patient/${patientId}` }
  const odontogram = await getOdontogram(tx, orgId, patientId)
  const byId = new Map(odontogram.history.map((entry) => [entry.id, entry]))
  const teeth = Object.entries(odontogram.teeth)
    .map(([tooth, state]) => ({ tooth: Number(tooth), state }))
    .sort((a, b) => a.tooth - b.tooth)
  const lines = teeth.map(
    ({ tooth, state }) =>
      `Pieza ${tooth}: ${conditionLabel(state.condition)}${state.surfaces.length ? ` (${surfaceWords(state.surfaces)})` : ""}`,
  )
  // Lo anulado no se dibuja ni cuenta como de hoy, pero deja rastro con su motivo (NTS 139: nada se
  // elimina, la corrección es un registro nuevo con su motivo).
  const voided = odontogram.history
    .filter((entry) => entry.voidedAt)
    .map(
      (entry) =>
        `Pieza ${entry.toothNumber}: ${conditionLabel(entry.condition)}${entry.surface ? ` (${surfaceWords([entry.surface])})` : ""} · anulado por corrección${entry.voidReason ? `: ${entry.voidReason}` : ""}`,
    )
  const findings: Resource[] = teeth.map(({ tooth, state }) => {
    // El último hallazgo de esa pieza con esa condición: su diagnóstico va como su código.
    const entry = [...state.entries]
      .reverse()
      .map((id) => byId.get(id))
      .find((row) => row?.condition === state.condition)
    const label = conditionLabel(state.condition)
    const toothCoding = fhirToothCoding(tooth)
    return {
      resourceType: "Observation",
      id: `odontograma-${tooth}`,
      status: "final",
      category: [CATEGORY_EXAM],
      code: { text: "Hallazgo del odontograma" },
      subject: patientRef,
      ...(entry?.encounterId ? { encounter: { reference: `Encounter/${entry.encounterId}` } } : {}),
      effectiveDateTime: (entry?.createdAt ?? new Date()).toISOString(),
      valueCodeableConcept: codeable(
        entry?.diagnosisSystem ?? null,
        entry?.diagnosisCode ?? null,
        label,
      ),
      // La pieza: FDI (ISO 3950) en `ex-tooth` de HL7; una temporal, solo con su texto.
      bodySite: {
        ...(toothCoding ? { coding: [toothCoding] } : {}),
        text: `Pieza ${tooth} (FDI, ISO 3950)`,
      },
      // Las caras van como componentes: `bodySite` es 0..1 en R4 y no lleva dos conceptos.
      ...(state.surfaces.length
        ? {
            component: state.surfaces.map((surface) => {
              const coding = fhirSurfaceCoding(surface)
              return {
                code: { text: "Cara" },
                valueCodeableConcept: {
                  ...(coding ? { coding: [coding] } : {}),
                  text: surfaceWords([surface]),
                },
              }
            }),
          }
        : {}),
    }
  })

  const charts = (await listPeriodontalCharts(tx, orgId, patientId)).slice().reverse()
  const zone = charts.length ? await findOrgLocale(tx, orgId) : null
  const blocks: RecordSectionBlock[] = []
  const periodontal: Resource[] = []
  let previous: PeriodontalChartView | null = null
  for (const item of charts) {
    const view = await getPeriodontalChart(tx, orgId, patientId, item.id)
    const classification = view.classification
      ? periodontalClassificationShort(view.classification as PeriodontalClassification)
      : null
    const summary = view.summary
    const before = previous?.summary
    const versus = (now: number | null, then: number | null | undefined, unit: string) =>
      now === null
        ? null
        : `${now}${unit}${then !== undefined && then !== null && previous ? ` (antes ${then}${unit})` : ""}`
    const indices = [
      summary.bleedingPercent !== null
        ? `Sangrado ${versus(summary.bleedingPercent, before?.bleedingPercent, " %")}`
        : null,
      summary.plaque
        ? `Placa ${versus(summary.plaque.percent, before?.plaque?.percent ?? null, " %")}`
        : null,
      `Sitios de 4 mm o más: ${versus(summary.sitesFrom4mm, before?.sitesFrom4mm, "")}`,
      `de 6 mm o más: ${versus(summary.sitesFrom6mm, before?.sitesFrom6mm, "")}`,
    ].filter(Boolean)
    const worsened = previous
      ? (await comparePeriodontalCharts(tx, orgId, patientId, previous.id, view.id)).worsened.map(
          (change) =>
            `pieza ${change.toothNumber}, ${PERIODONTAL_SITE_WORDS[PERIODONTAL_SITES.indexOf(change.site)] ?? change.site}, de ${change.before} a ${change.after} mm`,
        )
      : []
    blocks.push({
      title: `Periodontograma del ${zone ? dayWords(view.date, zone) : view.date.toISOString().slice(0, 10)}${view.professionalName ? ` · ${view.professionalName}` : ""}${view.encounterStatus === "finalizada" ? "" : " · sin firmar"}`,
      lines: [
        classification
          ? `${classification} (clasificación AAP/EFP 2017)`
          : "Sin clasificación confirmada",
        indices.join(" · "),
        ...(view.pending ? [`Quedó sin medir: ${view.pending}`] : []),
        ...(worsened.length ? [`Empeoró desde el anterior: ${worsened.join("; ")}`] : []),
        "Sondaje, margen (recesión) y nivel de inserción (NIC) en mm, en el orden mesial · centro · distal; «·» sin medir.",
      ],
      table: chartTable(view),
    })
    periodontal.push({
      resourceType: "Observation",
      id: view.id,
      status: view.encounterStatus === "finalizada" ? "final" : "preliminary",
      category: [CATEGORY_EXAM],
      code: { text: "Periodontograma" },
      subject: patientRef,
      encounter: { reference: `Encounter/${view.encounterId}` },
      effectiveDateTime: view.date.toISOString(),
      // La clasificación de 2017 (AAP/EFP) en palabras: no tiene códigos propios; el código CIE de
      // la atención ya va como su Condition.
      ...(classification
        ? { valueString: `${classification} (AAP/EFP 2017)` }
        : { dataAbsentReason: { text: "Sin clasificación confirmada" } }),
      component: [
        ...(summary.bleedingPercent !== null
          ? [
              {
                code: { text: "Sangrado al sondaje" },
                valueQuantity: {
                  value: summary.bleedingPercent,
                  unit: "%",
                  system: FHIR_UCUM_SYSTEM,
                  code: "%",
                },
              },
            ]
          : []),
        ...(summary.plaque
          ? [
              {
                code: { text: "Índice de placa (O'Leary)" },
                valueQuantity: {
                  value: summary.plaque.percent,
                  unit: "%",
                  system: FHIR_UCUM_SYSTEM,
                  code: "%",
                },
              },
            ]
          : []),
        { code: { text: "Sitios con bolsa de 4 mm o más" }, valueInteger: summary.sitesFrom4mm },
        { code: { text: "Sitios con bolsa de 6 mm o más" }, valueInteger: summary.sitesFrom6mm },
        ...(summary.maxProbingDepth !== null
          ? [
              {
                code: { text: "Bolsa más profunda" },
                valueQuantity: {
                  value: summary.maxProbingDepth,
                  unit: "mm",
                  system: FHIR_UCUM_SYSTEM,
                  code: "mm",
                },
              },
            ]
          : []),
      ],
    })
    previous = view
  }
  return [
    {
      title: "Odontograma vigente",
      lines: [...lines, ...voided],
      empty: "Sin hallazgos registrados.",
      fhir: findings,
    },
    ...(blocks.length
      ? [
          {
            title: `Periodontogramas (${blocks.length})`,
            lines: [],
            empty: "",
            blocks: blocks.reverse(),
            fhir: periodontal,
          },
        ]
      : []),
  ]
}
