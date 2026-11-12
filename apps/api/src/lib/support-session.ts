import { createHmac, timingSafeEqual } from "node:crypto"
import { roleLabel } from "@odentia/auth/permissions"
import { isClinicalProduct } from "@odentia/clinical"
import { type Db, runReadOnly } from "@odentia/db"
import { member, organization, user } from "@odentia/db/schema/auth"
import { orgProfile } from "@odentia/db/schema/org"
import {
  endSupportSession,
  redeemSupportPass,
  resolveSupportSession,
  runWithFileProxy,
  type Storage,
  type SupportSessionContext,
  supportSessionEnding,
} from "@odentia/services"
import { eq } from "drizzle-orm"
import type { Context, Next } from "hono"
import { Hono } from "hono"
import { errorBody } from "./error.js"

/**
 * Soporte mirando una clínica con su permiso (alcance `rol`): una sesión propia,
 * en su cookie, que no es la de Better Auth ni da membresía. La API la atiende
 * con el rol de lectura que eligió la clínica y tres frenos: solo lectura por
 * método, transacciones de solo lectura en la base y ninguna descarga. Lo que
 * abre de una ficha queda anotado antes de mostrarse (`patients.ts`).
 */
export const SUPPORT_COOKIE = "odentia_soporte"

/** El pedido es de soporte en solo lectura. */
export function isSupportRequest(c: Context): boolean {
  return Boolean(c.get("supportSession"))
}

export function supportSessionOf(c: Context): SupportSessionContext | null {
  return (c.get("supportSession") as SupportSessionContext | undefined) ?? null
}

function cookieOf(c: Context): string | null {
  const header = c.req.header("cookie")
  if (!header) return null
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=")
    if (name === SUPPORT_COOKIE) return decodeURIComponent(rest.join("="))
  }
  return null
}

/**
 * Antes de la sesión de Better Auth: con la cookie de soporte, el pedido es de
 * soporte o de nadie (nunca cae a otra sesión del mismo navegador, que podría ser
 * de una persona de soporte que además es miembro de alguna clínica).
 * `undefined`: no hay cookie de soporte, sigue el camino de siempre.
 */
export async function supportSessionGate(c: Context, ownerDb: Db): Promise<Response | null | undefined> {
  const token = cookieOf(c)
  if (!token) return undefined
  const session = await resolveSupportSession(ownerDb, token)
  if (!session) return c.json(errorBody(c, "SUPPORT_ACCESS_ENDED", "El acceso de soporte terminó"), 401)
  c.set("supportSession", session)
  c.set("userId", session.staffUserId)
  c.set("userImage", null)
  c.set("sessionId", `soporte:${session.sessionId}`)
  c.set("activeOrganizationId", session.organizationId)
  return null
}

/** El contexto de organización de soporte: la clínica del permiso, con el rol de lectura elegido. */
export async function supportOrgContext(c: Context, db: Db, session: SupportSessionContext): Promise<Response | null> {
  const slug = c.req.header("x-odentia-org") ?? c.req.query("org") ?? null
  if (slug) {
    const [org] = await db.select({ id: organization.id }).from(organization).where(eq(organization.slug, slug)).limit(1)
    if (!org || org.id !== session.organizationId)
      return c.json(errorBody(c, "FORBIDDEN", "Este acceso de soporte es de otra clínica"), 403)
  }
  c.set("orgId", session.organizationId)
  c.set("memberRole", session.viewRole)
  return null
}

/** Lo que se descarga en vez de verse: soporte no se lleva nada. */
const DOWNLOAD_TYPES = ["application/pdf", "text/csv", "application/zip", "application/vnd.", "application/octet-stream", "application/dicom"]
function isDownload(response: Response): boolean {
  const disposition = response.headers.get("content-disposition") ?? ""
  if (/attachment/i.test(disposition)) return true
  const type = (response.headers.get("content-type") ?? "").toLowerCase()
  return DOWNLOAD_TYPES.some((prefix) => type.startsWith(prefix))
}

/** El origen público de esta API, para nombrar los archivos de soporte. */
function apiOriginOf(c: Context): string {
  const url = new URL(c.req.url)
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "")
  const host = c.req.header("x-forwarded-host")?.split(",")[0]?.trim() || c.req.header("host") || url.host
  return `${proto}://${host}`
}

/** Firma de la dirección de un archivo para una sesión: vence con un minuto. */
function signFile(secret: Buffer, sessionId: string, objectKey: string, expires: number): string {
  const payload = Buffer.from(JSON.stringify({ s: sessionId, k: objectKey, e: expires })).toString("base64url")
  const mac = createHmac("sha256", secret).update(payload).digest("base64url")
  return `${payload}.${mac}`
}

function readFileToken(secret: Buffer, token: string): { s: string; k: string; e: number } | null {
  const [payload, mac] = token.split(".")
  if (!payload || !mac) return null
  const expected = createHmac("sha256", secret).update(payload).digest()
  const given = Buffer.from(mac, "base64url")
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { s?: unknown; k?: unknown; e?: unknown }
    if (typeof parsed.s !== "string" || typeof parsed.k !== "string" || typeof parsed.e !== "number") return null
    return { s: parsed.s, k: parsed.k, e: parsed.e }
  } catch {
    return null
  }
}

/**
 * El freno de soporte, después del contexto: solo GET y HEAD; todo corre con las
 * transacciones en solo lectura y los archivos por la API; una respuesta que
 * sería una descarga se cambia por un rechazo.
 */
export function supportGuard(secret: Buffer) {
  return async (c: Context, next: Next) => {
    const session = supportSessionOf(c)
    if (!session) return next()
    if (c.req.method !== "GET" && c.req.method !== "HEAD")
      return c.json(errorBody(c, "SUPPORT_READ_ONLY", "Soporte solo mira: no puede cambiar nada"), 403)
    const origin = apiOriginOf(c)
    const proxy = (objectKey: string) =>
      `${origin}/api/support-session/file?t=${encodeURIComponent(signFile(secret, session.sessionId, objectKey, Date.now() + 60_000))}`
    await runReadOnly(() => runWithFileProxy(proxy, () => next()))
    if (isDownload(c.res)) {
      c.res = c.json(errorBody(c, "SUPPORT_NO_DOWNLOAD", "Soporte solo mira: no descarga ni imprime"), 403)
    }
  }
}

/** La sesión de soporte a partir del secreto de la API (no es la clave de cifrado tal cual). */
export function supportFileSecret(secretsKey: Buffer): Buffer {
  return createHmac("sha256", secretsKey).update("support-session-file").digest()
}

/**
 * `/api/support-session`: canjear el pase, saber con qué se mira, salir, saber
 * por qué terminó y leer un archivo. Público (sin la sesión de Better Auth): cada
 * ruta comprueba la cookie de soporte.
 */
export function createSupportSessionRoute(deps: {
  ownerDb: Db
  storage: Storage
  secret: Buffer
  /** El dominio de la cookie para el producto de la petición. */
  cookieDomainOf: (c: Context) => string
  /** ¿Este origen es una app de clínica de confianza? (para el canje, que pone la cookie). */
  isClinicOrigin: (origin: string) => boolean
}) {
  const app = new Hono()

  const setCookie = (c: Context, value: string, maxAgeSeconds: number) => {
    const domain = deps.cookieDomainOf(c).replace(/^\./, "")
    c.header(
      "Set-Cookie",
      `${SUPPORT_COOKIE}=${encodeURIComponent(value)}; Domain=${domain}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; HttpOnly; Secure; SameSite=Lax`,
      { append: true },
    )
  }

  app.post("/redeem", async (c) => {
    const origin = c.req.header("origin") ?? ""
    if (!deps.isClinicOrigin(origin)) return c.json(errorBody(c, "FORBIDDEN", "Origen no permitido"), 403)
    const body = (await c.req.json().catch(() => null)) as { pass?: unknown } | null
    try {
      const redeemed = await redeemSupportPass(deps.ownerDb, typeof body?.pass === "string" ? body.pass : "")
      setCookie(c, redeemed.sessionToken, (redeemed.expiresAt.getTime() - Date.now()) / 1000)
      return c.json({ data: { expiresAt: redeemed.expiresAt.toISOString() } })
    } catch {
      return c.json(errorBody(c, "SUPPORT_PASS_INVALID", "El pase no sirve: pide otro desde la administración"), 403)
    }
  })

  app.get("/me", async (c) => {
    const token = cookieOf(c)
    const session = token ? await resolveSupportSession(deps.ownerDb, token) : null
    if (!session) return c.json(errorBody(c, "SUPPORT_ACCESS_ENDED", "El acceso de soporte terminó"), 401)
    const [org] = await deps.ownerDb
      .select({ id: organization.id, name: organization.name, slug: organization.slug, logo: organization.logo, product: orgProfile.product })
      .from(organization)
      .leftJoin(orgProfile, eq(orgProfile.organizationId, organization.id))
      .where(eq(organization.id, session.organizationId))
      .limit(1)
    if (!org) return c.json(errorBody(c, "SUPPORT_ACCESS_ENDED", "El acceso de soporte terminó"), 401)
    const product = isClinicalProduct(org.product) ? org.product : "dental"
    // El equipo, como lo ve cualquiera de la clínica (nombres y roles; sin correos).
    const team = await deps.ownerDb
      .select({ id: member.id, userId: member.userId, role: member.role, createdAt: member.createdAt, name: user.name, image: user.image })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, session.organizationId))
    return c.json({
      data: {
        staffUserId: session.staffUserId,
        staffName: session.staffName,
        viewRole: session.viewRole,
        viewRoleLabel: roleLabel(session.viewRole, product),
        expiresAt: session.expiresAt.toISOString(),
        caseId: session.caseId,
        organization: { id: org.id, name: org.name, slug: org.slug, logo: org.logo ?? null },
        members: team.map((row) => ({
          id: row.id,
          userId: row.userId,
          role: row.role,
          createdAt: row.createdAt.toISOString(),
          user: { id: row.userId, name: row.name, email: "", image: row.image ?? null },
        })),
      },
    })
  })

  app.post("/end", async (c) => {
    const origin = c.req.header("origin") ?? ""
    if (!deps.isClinicOrigin(origin)) return c.json(errorBody(c, "FORBIDDEN", "Origen no permitido"), 403)
    const token = cookieOf(c)
    if (token) await endSupportSession(deps.ownerDb, token)
    setCookie(c, "", 0)
    return c.json({ data: { ok: true } })
  })

  app.get("/ended", async (c) => {
    const token = cookieOf(c)
    const ending = token ? await supportSessionEnding(deps.ownerDb, token) : null
    return c.json({ data: ending })
  })

  app.get("/file", async (c) => {
    const token = cookieOf(c)
    const session = token ? await resolveSupportSession(deps.ownerDb, token) : null
    const file = readFileToken(deps.secret, c.req.query("t") ?? "")
    if (!session || !file || file.s !== session.sessionId || file.e < Date.now())
      return c.json(errorBody(c, "SUPPORT_ACCESS_ENDED", "El acceso de soporte terminó"), 401)
    // El archivo tiene que ser de esta clínica: su carpeta la nombra.
    if (!file.k.split("/").includes(session.organizationId))
      return c.json(errorBody(c, "FORBIDDEN", "Archivo de otra clínica"), 403)
    if (!deps.storage.streamAttachment) return c.json(errorBody(c, "UNAVAILABLE", "No disponible"), 503)
    const stream = await deps.storage.streamAttachment(file.k)
    const ext = file.k.split(".").at(-1)?.toLowerCase() ?? ""
    const type =
      ext === "pdf" ? "application/pdf" : ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "application/octet-stream"
    return new Response(stream, {
      headers: {
        "content-type": type,
        "content-disposition": "inline",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    })
  })

  return app
}
