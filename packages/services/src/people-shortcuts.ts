/**
 * Los atajos de «Pacientes» (decisión 6 del lienzo): cuántos y quiénes necesitan
 * algo ahora. No inventan reglas:
 * - «Por agendar» y «Control vencido» son las reglas de `to-schedule.ts`, las
 *   mismas de Inicio y de las líneas de Argos: el número es el mismo en las tres.
 * - Los presupuestos salen de la lista de «Qué sigue» (`planStepListsOf`, la
 *   regla de `getPlanNextSteps`): quien tiene ese paso en cualquier fila.
 * - «Por invitar a volver» es `lapsedToInvite`, lo que falta de su ficha es
 *   `patientsMissingData` y «Deben», sus cobros (`getDebts`).
 * Así la lista y su atajo no pueden contradecirse.
 */
import type { Db } from "@odentia/db"
import { sql } from "drizzle-orm"
import { getDebts } from "./finance.js"
import { patientsMissingData } from "./patient-registration.js"
import { type PlanNextKind, planStepListsOf } from "./plan-next.js"
import { lapsedToInvite } from "./return-invites.js"
import { patientsToSchedule, patientsWithOverdueControl } from "./to-schedule.js"

export const PEOPLE_SHORTCUTS = [
  "por_agendar",
  "presupuesto_sin_enviar",
  "presupuesto_sin_respuesta",
  "control_por_reservar",
  "faltan_datos",
  "por_invitar_a_volver",
  "deben",
] as const
export type PeopleShortcut = (typeof PEOPLE_SHORTCUTS)[number]

/**
 * Los pasos de «Qué sigue» que son un atajo. Agendar, continuar y el control no:
 * esos atajos son su regla (`to-schedule.ts`), aunque antes toque otro paso.
 */
const SHORTCUT_OF_PLAN: Record<PlanNextKind, PeopleShortcut | null> = {
  enviar: "presupuesto_sin_enviar",
  agendar: null,
  continuar: null,
  respuesta: "presupuesto_sin_respuesta",
  control: null,
  cerrar: null,
  ninguno: null,
}

/** Lo que puede ver quien mira: un atajo sin permiso no se cuenta. */
export type ShortcutCan = (permission: string) => boolean

/** Los pacientes de cada atajo que quien mira puede ver, por id de paciente. */
export type PeopleShortcutMembers = Partial<Record<PeopleShortcut, string[]>>

/** Pacientes con algo en su plan: solo a ellos se les pregunta «Qué sigue». */
async function plannedPatientIds(tx: Db, orgId: string): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    select p.id from patient p
    join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id and pp.is_active
    where p.organization_id = ${orgId}
      and (exists (select 1 from treatment_budget b where b.organization_id = p.organization_id and b.patient_id = p.id)
        or exists (select 1 from treatment_plan_item i where i.organization_id = p.organization_id and i.patient_id = p.id)
        or exists (select 1 from clinical_follow_up f where f.organization_id = p.organization_id and f.patient_id = p.id))
  `)
  return rows.map((row) => row.id)
}

/** Los atajos que salen de «Qué sigue»: recorren a los pacientes con plan. */
const PLAN_SHORTCUTS = ["presupuesto_sin_enviar", "presupuesto_sin_respuesta"] as const

/** De esos pacientes, a cuáles todavía les falta algo en su ficha: lo que marca cada fila de la página. */
export async function missingDataAmong(tx: Db, orgId: string, patientIds: string[]): Promise<Set<string>> {
  return patientsMissingData(tx, orgId, patientIds)
}

/** Quienes tocan invitar a volver: una sola consulta para toda la clínica, sin recorrer pacientes. */
export async function patientsToInvite(tx: Db, orgId: string, timezone: string, now: Date): Promise<Set<string>> {
  return new Set((await lapsedToInvite(tx, orgId, timezone, now)).map((row) => row.patientId))
}

/**
 * Los atajos que quien mira puede ver, con sus pacientes. Recorre solo a los que
 * tienen plan, así que el costo crece con los tratamientos y no con toda la
 * clínica; «Faltan datos» recorre a los activos, en lote. La lista no lo llama
 * para pintar una página, solo para filtrar por un atajo (`only`, solo ese) y
 * para contarlos aparte (`countPeopleShortcuts`).
 */
export async function peopleShortcutMembers(
  tx: Db,
  orgId: string,
  can: ShortcutCan,
  timezone: string,
  now: Date,
  only?: PeopleShortcut,
): Promise<PeopleShortcutMembers> {
  const members: PeopleShortcutMembers = {}
  const wanted = (shortcut: PeopleShortcut) => only === undefined || only === shortcut
  const planAllowed = ["clinical.read", "budgets.read", "appointments.read"].some((permission) => can(permission))
  // Las dos reglas de lo que falta agendar: las mismas de Inicio y de Argos, sin recorrer paciente por paciente.
  if (planAllowed && wanted("por_agendar")) members.por_agendar = await patientsToSchedule(tx, orgId)
  if (planAllowed && wanted("control_por_reservar"))
    members.control_por_reservar = await patientsWithOverdueControl(tx, orgId, timezone)
  if (planAllowed && PLAN_SHORTCUTS.some(wanted)) {
    for (const shortcut of PLAN_SHORTCUTS) members[shortcut] = []
    // Todos de una vez, con la misma lista de «Qué sigue» (`planStepListsOf`): el paso en cualquier fila.
    const lists = await planStepListsOf(tx, orgId, await plannedPatientIds(tx, orgId), () => true)
    for (const [patientId, steps] of lists) {
      const shortcuts = new Set(steps.map((step) => SHORTCUT_OF_PLAN[step.kind]))
      for (const shortcut of shortcuts) if (shortcut && members[shortcut]) members[shortcut]?.push(patientId)
    }
  }
  if (can("patients.read") && wanted("faltan_datos")) members.faltan_datos = [...(await patientsMissingData(tx, orgId))]
  if (can("crm.read") && wanted("por_invitar_a_volver"))
    members.por_invitar_a_volver = (await lapsedToInvite(tx, orgId, timezone, now)).map((row) => row.patientId)
  if (can("finance.read") && wanted("deben")) {
    // Debe quien, en una moneda, debe más de lo que tiene a favor (decisión 22, como Reportes y Deudas).
    const debts = await getDebts(tx, orgId)
    const owed = new Map<string, { total: number; credit: number }>()
    for (const debt of debts) {
      const key = `${debt.patientId}|${debt.currency}`
      const sum = owed.get(key) ?? { total: 0, credit: debt.creditCents }
      sum.total += debt.totalCents
      owed.set(key, sum)
    }
    members.deben = [
      ...new Set([...owed].filter(([, sum]) => sum.total > sum.credit).map(([key]) => key.split("|")[0]!)),
    ]
  }
  return members
}

/** Cuántos hay en cada atajo que quien mira ve; nulo, el que no ve. */
export async function countPeopleShortcuts(
  tx: Db,
  orgId: string,
  can: ShortcutCan,
  timezone: string,
  now: Date,
): Promise<Record<PeopleShortcut, number | null>> {
  const members = await peopleShortcutMembers(tx, orgId, can, timezone, now)
  return Object.fromEntries(PEOPLE_SHORTCUTS.map((name) => [name, members[name]?.length ?? null])) as Record<
    PeopleShortcut,
    number | null
  >
}
