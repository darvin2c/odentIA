import { isClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import { mailboxOauthState } from "@odentia/db/schema/mailbox"
import { orgProfile } from "@odentia/db/schema/org"
import { clinicOrigin, parseOauthStateParam } from "@odentia/services"
import { eq } from "drizzle-orm"

/**
 * A dónde vuelve una conexión por OAuth (correo, Facebook, Instagram): a la
 * dirección de la clínica, en el dominio de su producto. El panel (`WEB_URL`) no
 * tiene las páginas de Configuración: volver ahí da «Not Found». Sin clínica
 * conocida, al panel, donde se elige.
 */
export async function clinicReturnBase(ownerDb: Db, webBase: string, orgId: string | null): Promise<string> {
  if (!orgId) return webBase
  const [org] = await ownerDb
    .select({ slug: organization.slug, product: orgProfile.product })
    .from(organization)
    .leftJoin(orgProfile, eq(orgProfile.organizationId, organization.id))
    .where(eq(organization.id, orgId))
    .limit(1)
    .catch(() => [])
  if (!org) return webBase
  return clinicOrigin(org.slug, isClinicalProduct(org.product) ? org.product : "dental") ?? webBase
}

/**
 * La clínica de un `state` firmado, sin consumirlo: para volver a ella también
 * cuando la persona canceló o la vuelta falló. Un `state` forjado no da clínica.
 */
export async function orgOfOauthState(ownerDb: Db, secretsKey: Buffer, state: string): Promise<string | null> {
  if (!state) return null
  const nonce = parseOauthStateParam(secretsKey, state)
  if (!nonce) return null
  const [row] = await ownerDb
    .select({ organizationId: mailboxOauthState.organizationId })
    .from(mailboxOauthState)
    .where(eq(mailboxOauthState.nonce, nonce))
    .limit(1)
    .catch(() => [])
  return row?.organizationId ?? null
}
