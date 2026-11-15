import { saasOpportunity } from "@odentia/db/schema/admin-arm"
import { saasDemo } from "@odentia/db/schema/admin-demos"
import { saasSubscription } from "@odentia/db/schema/saas-billing"
import { type SQL, sql } from "drizzle-orm"

/*
 * Fragmentos SQL que comparten el alta (`admin-onboarding.ts`) y los reportes
 * (`admin-reports.ts`). Viven aparte para que esos dos módulos no se importen entre sí.
 */

/** Una organización que no es demo para presentar (ni marcada en su suscripción). */
export function notDemoOrg(orgId: SQL): SQL {
  return sql`(not exists (select 1 from ${saasDemo} d where d.organization_id = ${orgId})
    and not exists (select 1 from ${saasSubscription} ds where ds.organization_id = ${orgId} and ds.is_demo))`
}

/**
 * Cuándo entró una clínica (el inicio de su alta): la venta cerrada como «Entró» más antigua y,
 * si no hay, cuando se creó su cuenta. La misma regla en el Embudo «Alta» y en los reportes.
 * `clientAlias` es el alias SQL de `saas_client`; `orgAlias`, el de su `organization`.
 */
export function enteredAtSql(clientAlias = "c", orgAlias = "org"): SQL {
  for (const alias of [clientAlias, orgAlias])
    if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error("Alias no válido")
  return sql`coalesce(
          (select min(o.decided_at) from ${saasOpportunity} o where o.client_id = ${sql.raw(`${clientAlias}.id`)} and o.decision = 'entro'),
          ${sql.raw(`${orgAlias}.created_at`)})`
}
