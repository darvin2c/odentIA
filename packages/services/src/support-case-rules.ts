import { supportAccessGrant, supportAttachment, supportCase, supportMessage } from "@odentia/db/schema/admin-support"
import { member } from "@odentia/db/schema/auth"
import { type AnyColumn, type SQL, sql } from "drizzle-orm"

/*
 * Reglas de un caso de soporte que comparten la cola, Inicio, el menú y los
 * avisos por correo. Son fragmentos sobre `support_case` sin alias: se usan
 * dentro de un `from support_case`. La migración que desatascó los casos
 * (0099_administracion_hoy_reglas.sql) repite a mano `clinicActsSinceSql`.
 */

/**
 * Lo que hizo la clínica en el caso después de `since`, un hecho por fila
 * (`at`): escribió en público, adjuntó (quien abrió el caso o alguien de la
 * clínica; un archivo del equipo no cuenta) o autorizó el acceso.
 */
export const clinicActsSinceSql = (since: AnyColumn | SQL) => sql`
    select m.created_at as at from ${supportMessage} m
      where m.case_id = ${supportCase.id} and m.author_kind = 'cliente' and m.is_internal = false
        and m.created_at > ${since}
    union all
    select a.created_at from ${supportAttachment} a
      where a.case_id = ${supportCase.id} and a.created_at > ${since}
        and (a.created_by = ${supportCase.openedBy} or exists (select 1 from ${member} mm
          where mm.user_id = a.created_by and mm.organization_id = ${supportCase.organizationId}))
    union all
    select g.created_at from ${supportAccessGrant} g
      where g.case_id = ${supportCase.id} and g.created_at > ${since}`

/** Pedido de acceso vigente: soporte lo pidió y la clínica no hizo nada después. */
export const accessRequestPendingSql = sql<boolean>`(${supportCase.accessRequestedAt} is not null
  and not exists (${clinicActsSinceSql(supportCase.accessRequestedAt)}))`

/**
 * Se espera a quienes autorizan el acceso (la propietaria y los
 * administradores): el caso espera a la clínica por el pedido de acceso, ese
 * pedido es lo último que le dijimos (`requestSupportAccess` pone las dos
 * fechas con el mismo instante) y sigue vigente. Lo que soporte pida después,
 * o una espera nueva tras la respuesta de la clínica, es de quien preguntó.
 */
export const awaitingGrantersSql = sql<boolean>`(${supportCase.status} = 'esperando_clinica'
  and ${supportCase.accessRequestedAt} >= ${supportCase.lastPublicMessageAt}
  and ${accessRequestPendingSql})`
