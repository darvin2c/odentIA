import type { Db } from "@odentia/db"
import { sql } from "drizzle-orm"

/** ¿La clínica ya aceptó esta versión del Contrato de encargo de tratamiento? */
export async function clinicAgreementAccepted(
  tx: Db,
  orgId: string,
  version: string,
): Promise<boolean> {
  const [row] = await tx.execute<{ ok: boolean }>(sql`
    select exists(select 1 from processing_agreement_acceptance
      where organization_id = ${orgId} and version = ${version}) as ok`)
  return row?.ok ?? false
}

/** Quien administra la clínica acepta el contrato en su nombre; aceptar dos veces no cambia nada. */
export async function acceptClinicAgreement(
  tx: Db,
  orgId: string,
  userId: string,
  version: string,
): Promise<void> {
  await tx.execute(sql`
    insert into processing_agreement_acceptance (organization_id, version, accepted_by)
    values (${orgId}, ${version}, ${userId})
    on conflict (organization_id, version) do nothing`)
}

export interface LegalNoticeRecipient {
  userId: string
  email: string
  firstName: string
}

/**
 * Reserva el aviso de una versión nueva de los términos para quienes aceptaron
 * una anterior y aún no lo recibieron, antes de enviar: si el envío falla no se
 * repite (no se manda dos veces un correo que quizá salió). Quien nunca aceptó
 * no recibe aviso: al entrar ve «Un paso antes de seguir».
 */
export async function claimLegalNotices(
  ownerDb: Db,
  version: string,
  limit = 50,
): Promise<LegalNoticeRecipient[]> {
  const rows = await ownerDb.execute<{
    id: string
    email: string
    first_name: string
    name: string
  }>(sql`
    with picked as (
      select u.id from "user" u
      where u.email_verified and u.terms_version is not null and u.terms_version <> ${version}
        and not exists (select 1 from legal_notice n where n.user_id = u.id and n.version = ${version})
      order by u.id
      limit ${limit}
    ), claimed as (
      insert into legal_notice (user_id, version)
      select id, ${version} from picked
      on conflict (user_id, version) do nothing
      returning user_id
    )
    select u.id, u.email, u.first_name, u.name from claimed c join "user" u on u.id = c.user_id`)
  return rows.map((r) => ({
    userId: r.id,
    email: r.email,
    firstName: r.first_name || r.name.split(" ")[0] || "",
  }))
}
