/**
 * Semilla del periodontograma (issue 49; lienzo «Periodontograma», tableros 4 y
 * 11): Carlos Paredes, 48 años, periodontitis estadio III, grado B,
 * generalizada. Dos visitas con la Dra. Ana: la inicial, hace 69 días, y la
 * reevaluación siete semanas después del último raspado, hace 6 días. Son las
 * mismas medidas del lienzo. Solo para `seed-dev`: las pruebas arman las suyas.
 */
import type { Db } from "@odentia/db"
import { encounter } from "@odentia/db/schema/clinical"
import type { FurcationRecord } from "@odentia/clinical"
import { eq } from "drizzle-orm"
import { addOdontogramEntries } from "./clinical.js"
import { createEncounter, finalizeEncounter, updateEncounterDraft } from "./encounters.js"
import { classifyPeriodontalChart, savePeriodontalTooth, startPeriodontalChart } from "./periodontal.js"

/** Pieza, profundidades, recesiones, sangrado y supuración por sitio (MV, V, DV, ML, L, DL). */
type Visit = Array<[number, number[], number[], string, string]>

const INITIAL: Visit = [
  [17, [6, 4, 5, 5, 3, 5], [0, 0, 1, 1, 0, 1], "110100", "100000"],
  [16, [6, 3, 5, 6, 3, 6], [0, 0, 1, 0, 0, 0], "001101", "000000"],
  [15, [2, 3, 3, 2, 2, 3], [-1, 0, 0, 0, 0, -1], "010000", "000000"],
  [14, [3, 3, 3, 3, 3, 3], [-1, 0, 0, 0, -1, 0], "000000", "000000"],
  [13, [3, 2, 4, 3, 3, 3], [0, 2, 0, 0, 0, 0], "000000", "000000"],
  [12, [3, 2, 3, 4, 2, 2], [-1, 0, -1, -1, 0, -1], "000100", "000000"],
  [11, [4, 2, 4, 4, 2, 4], [1, 0, 0, 0, 1, 0], "001001", "000000"],
  [21, [4, 2, 3, 4, 2, 4], [1, 1, 0, 0, 0, 0], "000001", "000000"],
  [22, [3, 2, 3, 2, 2, 3], [0, -1, -1, 0, 0, -1], "000001", "000000"],
  [23, [3, 2, 3, 2, 2, 2], [0, 2, 0, 0, 0, 0], "100010", "000000"],
  [24, [3, 2, 3, 3, 2, 3], [-1, -1, -1, -1, 0, -1], "000000", "000000"],
  [25, [4, 2, 4, 4, 3, 4], [0, 0, 0, 1, 0, 1], "101001", "000000"],
  [26, [5, 3, 6, 6, 3, 6], [0, 0, 0, 0, 1, 0], "001101", "000101"],
  [27, [5, 2, 4, 4, 2, 4], [0, 0, 0, 1, 1, 1], "101011", "000000"],
  [47, [6, 4, 5, 5, 3, 6], [0, 0, 1, 1, 0, 0], "100101", "100000"],
  [46, [4, 3, 4, 4, 3, 3], [0, 0, 0, 0, 0, 0], "101000", "000000"],
  [45, [3, 2, 2, 2, 2, 2], [0, -1, 0, 0, 0, -1], "100000", "000000"],
  [44, [3, 3, 3, 3, 2, 4], [-1, 0, -1, -1, 0, 0], "001101", "000000"],
  [43, [3, 2, 3, 2, 2, 2], [0, 0, 0, -1, 0, -1], "100000", "000000"],
  [42, [4, 2, 3, 4, 2, 4], [1, 2, 1, 1, 0, 1], "100100", "000000"],
  [41, [5, 2, 4, 4, 2, 4], [1, 2, 1, 0, 1, 0], "000100", "000000"],
  [31, [4, 2, 4, 3, 2, 4], [1, 2, 1, 1, 0, 1], "001000", "000000"],
  [32, [4, 2, 5, 4, 3, 4], [1, 2, 1, 1, 0, 1], "011110", "000000"],
  [33, [2, 2, 4, 3, 2, 3], [0, 0, -1, 0, -1, -1], "010000", "000000"],
  [34, [2, 2, 3, 3, 2, 3], [0, 0, 0, -1, 0, 0], "010010", "000000"],
  [35, [3, 3, 2, 3, 2, 2], [0, 0, 0, -1, 0, 0], "001000", "000000"],
  [36, [5, 3, 6, 5, 3, 6], [0, 0, 1, 1, 0, 0], "101101", "001000"],
  [37, [4, 3, 4, 4, 2, 5], [0, 1, 0, 0, 1, 0], "100001", "000000"],
]

const REEVALUATION: Visit = [
  [17, [3, 3, 3, 4, 3, 3], [1, 0, 2, 2, 0, 2], "110000", "000000"],
  [16, [4, 3, 3, 3, 3, 4], [1, 0, 1, 1, 0, 1], "000100", "000000"],
  [15, [2, 3, 3, 2, 2, 3], [-1, 0, 0, 0, 0, -1], "010000", "000000"],
  [14, [3, 3, 3, 3, 3, 3], [-1, 0, 0, 0, -1, 0], "000000", "000000"],
  [13, [3, 2, 3, 3, 3, 3], [0, 2, 0, 0, 0, 0], "000000", "000000"],
  [12, [3, 2, 3, 4, 2, 2], [-1, 0, -1, -1, 0, -1], "000000", "000000"],
  [11, [3, 2, 3, 3, 2, 3], [1, 0, 0, 0, 1, 0], "000000", "000000"],
  [21, [3, 2, 3, 3, 2, 3], [1, 1, 0, 0, 0, 0], "000000", "000000"],
  [22, [3, 2, 3, 2, 2, 3], [0, -1, -1, 0, 0, -1], "000000", "000000"],
  [23, [3, 2, 3, 2, 2, 2], [0, 2, 0, 0, 0, 0], "000000", "000000"],
  [24, [3, 2, 3, 3, 2, 3], [-1, -1, -1, -1, 0, -1], "000000", "000000"],
  [25, [3, 2, 3, 3, 3, 4], [0, 0, 0, 1, 0, 1], "100001", "000000"],
  [26, [4, 3, 4, 3, 3, 4], [1, 0, 1, 0, 1, 1], "000000", "000000"],
  [27, [3, 2, 3, 3, 2, 3], [0, 0, 0, 1, 1, 1], "000000", "000000"],
  [47, [3, 3, 4, 4, 3, 4], [1, 0, 1, 2, 0, 1], "100100", "000000"],
  [46, [3, 3, 3, 3, 3, 3], [0, 0, 0, 0, 0, 0], "000000", "000000"],
  [45, [3, 2, 2, 2, 2, 2], [0, -1, 0, 0, 0, -1], "100000", "000000"],
  [44, [3, 3, 3, 3, 2, 4], [-1, 0, -1, -1, 0, 0], "000000", "000000"],
  [43, [3, 2, 3, 2, 2, 2], [0, 0, 0, -1, 0, -1], "000000", "000000"],
  [42, [3, 2, 3, 4, 2, 3], [1, 2, 1, 1, 0, 1], "000100", "000000"],
  [41, [3, 2, 3, 3, 2, 3], [1, 2, 1, 0, 1, 0], "000100", "000000"],
  [31, [3, 2, 3, 3, 2, 3], [1, 2, 1, 1, 0, 1], "000000", "000000"],
  [32, [3, 2, 3, 3, 3, 3], [1, 2, 2, 1, 0, 1], "000110", "000000"],
  [33, [2, 2, 3, 3, 2, 3], [0, 0, -1, 0, -1, -1], "000000", "000000"],
  [34, [2, 2, 3, 3, 2, 3], [0, 0, 0, -1, 0, 0], "010000", "000000"],
  [35, [3, 3, 2, 3, 2, 2], [0, 0, 0, -1, 0, 0], "000000", "000000"],
  [36, [3, 3, 4, 3, 3, 4], [1, 0, 2, 1, 0, 1], "000001", "000000"],
  [37, [4, 3, 3, 3, 2, 7], [0, 1, 0, 0, 1, 0], "100001", "000000"],
]

/** Placa de O'Leary por cara: por fuera, por dentro, mesial y distal. */
const PLAQUE_INITIAL: Record<number, string> = {
  11: "1011", 12: "0011", 13: "0000", 14: "0101", 15: "1011", 16: "0101", 17: "0101",
  21: "0110", 22: "0001", 23: "0000", 24: "0101", 25: "0101", 26: "0000", 27: "0111",
  31: "1000", 32: "1011", 33: "1000", 34: "0011", 35: "1101", 36: "0010", 37: "0011",
  41: "1010", 42: "1111", 43: "1110", 44: "0011", 45: "0111", 47: "0110",
}
const PLAQUE_REEVALUATION: Record<number, string> = {
  11: "0101", 12: "0010", 13: "0000", 14: "0001", 15: "0100", 16: "0000", 17: "0000",
  21: "0000", 22: "0000", 23: "0001", 24: "0010", 25: "0000", 26: "0000", 27: "0000",
  31: "0110", 32: "0000", 33: "0001", 34: "1001", 35: "1000", 36: "1011", 37: "0000",
  41: "0000", 42: "0001", 43: "0000", 44: "0000", 45: "0001", 47: "0110",
}
const FURCATION: Record<number, FurcationRecord> = {
  16: { buccal: 1 },
  26: { buccal: 1, distopalatal: 1 },
  36: { buccal: 2, lingual: 1 },
  37: { buccal: 1 },
  47: { buccal: 1 },
}
const MOBILITY: Record<number, number> = { 31: 1, 41: 1 }
const IMPLANT = 46

const flags = (value: string) => [...value].map((c) => c === "1")

async function probe(
  db: Db,
  orgId: string,
  actor: string,
  patientId: string,
  chartId: string,
  visit: Visit,
  plaque: Record<number, string>,
): Promise<void> {
  for (const [toothNumber, probingDepth, recession, bleeding, suppuration] of visit) {
    const faces = plaque[toothNumber]
    await savePeriodontalTooth(db, orgId, actor, patientId, chartId, {
      toothNumber,
      probingDepth,
      recession,
      bleeding: flags(bleeding),
      suppuration: flags(suppuration),
      mobility: toothNumber === IMPLANT ? null : (MOBILITY[toothNumber] ?? 0),
      furcation: FURCATION[toothNumber] ?? {},
      plaque: faces ? flags(faces) : null,
    })
  }
}

export async function seedPeriodontalCase(
  db: Db,
  input: { orgId: string; professionalUserId: string; patientId: string; branchId: string; daysAgo: (days: number) => Date },
): Promise<void> {
  const { orgId, professionalUserId: actor, patientId, branchId, daysAgo } = input
  // Visita inicial: le sangran las encías. El odontograma registra las piezas
  // que faltan y el implante; el periodontograma las toma de ahí (decisión 4).
  const first = await createEncounter(db, orgId, actor, patientId, {
    reason: "Le sangran las encías al cepillarse",
    branchId,
  })
  await db.update(encounter).set({ startedAt: daysAgo(69) }).where(eq(encounter.id, first.id))
  for (const [tooth, variant] of [[18, "other_absence"], [28, "other_absence"], [38, "unerupted"], [48, "unerupted"]] as const) {
    await addOdontogramEntries(db, orgId, actor, patientId, {
      toothNumber: tooth,
      condition: "missing_tooth",
      details: { variant },
      encounterId: first.id,
    })
  }
  await addOdontogramEntries(db, orgId, actor, patientId, {
    toothNumber: IMPLANT,
    condition: "implant",
    details: { clinicallyObserved: true, quality: "good" },
    note: "Reemplaza la pieza perdida por la enfermedad",
    encounterId: first.id,
  })
  const initial = await startPeriodontalChart(db, orgId, actor, patientId, { encounterId: first.id })
  if (initial.expectedTeeth.length !== 28 || initial.implantTeeth.join() !== String(IMPLANT)) {
    throw new Error("El periodontograma de Carlos debía tomar 28 piezas y el implante de la 46 del odontograma")
  }
  await probe(db, orgId, actor, patientId, initial.id, INITIAL, PLAQUE_INITIAL)
  const classified = await classifyPeriodontalChart(db, orgId, actor, patientId, initial.id, {
    diagnosis: "periodontitis",
    stage: 3,
    grade: "B",
    extent: "generalized",
    boneLossPercent: 40,
    teethLostToPeriodontitis: 1,
    cigarettesPerDay: 6,
    diabetes: false,
    implants: [{ toothNumber: IMPLANT, condition: "mucositis" }],
  })
  // La propuesta de odentIA y lo confirmado coinciden, como en el tablero 9. Al
  // confirmar queda también el diagnóstico de la atención (K05.3 con su nota).
  if (classified.proposal.stage !== 3 || classified.proposal.grade !== "B" || classified.summary.bleedingPercent !== 31) {
    throw new Error("La propuesta del periodontograma de Carlos no coincide con el lienzo")
  }
  await updateEncounterDraft(db, orgId, actor, patientId, first.id, {
    evolution:
      "Periodontitis estadio III, grado B, generalizada (AAP/EFP 2017). Mucositis en el implante de la 46. Se indica raspado y alisado radicular por cuadrantes e higiene con cepillo interdental.",
  })
  await finalizeEncounter(db, orgId, actor, patientId, first.id)

  // Reevaluación a las siete semanas del último raspado.
  const second = await createEncounter(db, orgId, actor, patientId, { reason: "Reevaluación periodontal", branchId })
  await db.update(encounter).set({ startedAt: daysAgo(6) }).where(eq(encounter.id, second.id))
  const reevaluation = await startPeriodontalChart(db, orgId, actor, patientId, { encounterId: second.id })
  await probe(db, orgId, actor, patientId, reevaluation.id, REEVALUATION, PLAQUE_REEVALUATION)
  // Parte del diagnóstico del 10 ago y propone cómo está hoy: inestable por la 37.
  const reevaluated = await classifyPeriodontalChart(db, orgId, actor, patientId, reevaluation.id, {
    diagnosis: "periodontitis",
    stage: 3,
    grade: "B",
    extent: "generalized",
    status: "unstable",
    implants: [{ toothNumber: IMPLANT, condition: "health" }],
  })
  if (reevaluated.proposal.stage !== 3 || reevaluated.proposal.status !== "unstable") {
    throw new Error("La reevaluación de Carlos debía partir del estadio III y proponer «inestable»")
  }
  await updateEncounterDraft(db, orgId, actor, patientId, second.id, {
    evolution:
      "Reevaluación: el sangrado bajó del 31 % al 10 % y la placa del 49 % al 19 %. La 37 por dentro, distal, empeoró de 5 a 7 mm: se pide radiografía.",
  })
  await finalizeEncounter(db, orgId, actor, patientId, second.id)
}
