/**
 * Los atajos de «Pacientes» (decisión 6 del lienzo): cuántos y quiénes necesitan
 * algo ahora. No inventan reglas: cada paciente cae en el mismo paso que dice
 * «Qué sigue» (`getPlanNextStep`), en «no viene hace 6 meses» (`lapsedSql`, la
 * regla de Reportes), o en lo que falta de su ficha (`getPatientMissingData`) o
 * de sus cobros (`getDebts`). Así la lista y su atajo no pueden contradecirse.
 */
import type { Db } from "@odentia/db"
import { contact } from "@odentia/db/schema/crm"
import { patient } from "@odentia/db/schema/clinical"
import { and, eq, sql } from "drizzle-orm"
import { getDebts } from "./finance.js"
import { getPatientMissingData } from "./patient-registration.js"
import { getPlanNextStep, type PlanNextKind } from "./plan-next.js"
import { lapsedToInvite } from "./return-invites.js"

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

/** Cada paso de «Qué sigue» cae en un atajo; «ninguno» en ninguno. */
const SHORTCUT_OF_PLAN: Record<PlanNextKind, PeopleShortcut | null> = {
  enviar: "presupuesto_sin_enviar",
  agendar: "por_agendar",
  continuar: "por_agendar",
  respuesta: "presupuesto_sin_respuesta",
  control: "control_por_reservar",
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

/** Pacientes activos cuya ficha todavía le falta algo para atenderla (`missingData`). */
async function missingDataPatientIds(tx: Db, orgId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: patient.id })
    .from(patient)
    .innerJoin(contact, and(eq(contact.organizationId, patient.organizationId), eq(contact.id, patient.personId)))
    .where(and(eq(patient.organizationId, orgId), eq(contact.isActive, true)))
  const out: string[] = []
  for (const row of rows) {
    if ((await getPatientMissingData(tx, orgId, row.id)).length > 0) out.push(row.id)
  }
  return out
}

/**
 * Los atajos que quien mira puede ver, con sus pacientes. Recorre solo a los que
 * tienen plan, así que el costo crece con los tratamientos y no con toda la
 * clínica; «Faltan datos» recorre a los activos.
 */
export async function peopleShortcutMembers(
  tx: Db,
  orgId: string,
  can: ShortcutCan,
  timezone: string,
  now: Date,
): Promise<PeopleShortcutMembers> {
  const members: PeopleShortcutMembers = {}
  const planAllowed = ["clinical.read", "budgets.read", "appointments.read"].some((permission) => can(permission))
  if (planAllowed) {
    for (const shortcut of ["por_agendar", "presupuesto_sin_enviar", "presupuesto_sin_respuesta", "control_por_reservar"] as const)
      members[shortcut] = []
    for (const patientId of await plannedPatientIds(tx, orgId)) {
      const step = await getPlanNextStep(tx, orgId, patientId, () => true)
      const shortcut = SHORTCUT_OF_PLAN[step.kind]
      if (shortcut && members[shortcut]) members[shortcut]?.push(patientId)
    }
  }
  if (can("patients.read")) members.faltan_datos = await missingDataPatientIds(tx, orgId)
  if (can("crm.read")) members.por_invitar_a_volver = (await lapsedToInvite(tx, orgId, timezone, now)).map((row) => row.patientId)
  if (can("finance.read")) {
    const debts = await getDebts(tx, orgId)
    members.deben = [...new Set(debts.map((debt) => debt.patientId))]
  }
  return members
}
