import { createHmac, timingSafeEqual } from "node:crypto"
import { roleLabel } from "@odentia/auth/permissions"
import { isClinicalProduct } from "@odentia/clinical"
import { type Db, runOutsideReadOnly, runReadOnly, withOrgContext } from "@odentia/db"
import { supportAccessAudit } from "@odentia/db/schema/admin-support"
import { member, organization, user } from "@odentia/db/schema/auth"
import { orgProfile } from "@odentia/db/schema/org"
import {
  endSupportSession,
  redeemSupportPass,
  resolveSupportSession,
  resolveSupportSessionById,
  runWithFileProxy,
  type Storage,
  type SupportSessionContext,
  supportPassStaff,
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
export async function supportSessionGate(
  c: Context,
  ownerDb: Db,
): Promise<Response | null | undefined> {
  if (supportSessionOf(c)) return null
  const token = cookieOf(c)
  if (!token) return undefined
  const session = await resolveSupportSession(ownerDb, token)
  if (!session)
    return c.json(errorBody(c, "SUPPORT_ACCESS_ENDED", "El acceso de soporte terminó"), 401)
  c.set("supportSession", session)
  c.set("userId", session.staffUserId)
  c.set("userImage", null)
  c.set("sessionId", `soporte:${session.sessionId}`)
  c.set("activeOrganizationId", session.organizationId)
  return null
}

/**
 * Un intento frenado (escribir, otra clínica, descargar, una pantalla vedada): queda en la
 * auditoría del permiso, como promete el contrato. Lo anota el sistema, fuera del solo lectura.
 */
export async function auditDenied(db: Db, session: SupportSessionContext, orgScope?: string): Promise<void> {
  const row = {
    grantId: session.grantId,
    caseId: session.caseId,
    organizationId: session.organizationId,
    staffUserId: session.staffUserId,
    action: "denegado_solo_lectura",
  }
  // Con el rol de la app, dentro del contexto de la clínica (RLS); con el dueño, directo.
  await runOutsideReadOnly(() =>
    orgScope
      ? withOrgContext(db, orgScope, (tx) => tx.insert(supportAccessAudit).values(row))
      : db.insert(supportAccessAudit).values(row),
  ).catch((error: unknown) => {
    console.error("No se pudo anotar un intento frenado de soporte", {
      grantId: session.grantId,
      error: error instanceof Error ? error.message : String(error),
    })
  })
}

/** El contexto de organización de soporte: la clínica del permiso, con el rol de lectura elegido. */
export async function supportOrgContext(
  c: Context,
  db: Db,
  session: SupportSessionContext,
  ownerDb: Db = db,
): Promise<Response | null> {
  const slug = c.req.header("x-odentia-org") ?? c.req.query("org") ?? null
  if (slug) {
    const [org] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.slug, slug))
      .limit(1)
    if (!org || org.id !== session.organizationId) {
      await auditDenied(ownerDb, session)
      return c.json(errorBody(c, "FORBIDDEN", "Este acceso de soporte es de otra clínica"), 403)
    }
  }
  c.set("orgId", session.organizationId)
  c.set("memberRole", session.viewRole)
  return null
}

/** Lo que se descarga en vez de verse: soporte no se lleva nada. */
const DOWNLOAD_TYPES = [
  "application/pdf",
  "text/csv",
  "application/zip",
  "application/vnd.",
  "application/octet-stream",
]
function isDownload(response: Response): boolean {
  const disposition = response.headers.get("content-disposition") ?? ""
  if (/attachment/i.test(disposition)) return true
  const type = (response.headers.get("content-type") ?? "").toLowerCase()
  return DOWNLOAD_TYPES.some((prefix) => type.startsWith(prefix))
}

/** El origen público de esta API, para nombrar los archivos de soporte. */
function apiOriginOf(c: Context): string {
  const url = new URL(c.req.url)
  const proto =
    c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "")
  const host =
    c.req.header("x-forwarded-host")?.split(",")[0]?.trim() || c.req.header("host") || url.host
  return `${proto}://${host}`
}

/**
 * Firma de la dirección de un archivo para una sesión. Vale diez minutos (una imagen se
 * vuelve a pintar desde lo ya cargado), y en cada pedido se revisa que la sesión siga.
 */
const FILE_TOKEN_MS = 10 * 60_000
function signFile(secret: Buffer, sessionId: string, objectKey: string, expires: number): string {
  const payload = Buffer.from(JSON.stringify({ s: sessionId, k: objectKey, e: expires })).toString(
    "base64url",
  )
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
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      s?: unknown
      k?: unknown
      e?: unknown
    }
    if (
      typeof parsed.s !== "string" ||
      typeof parsed.k !== "string" ||
      typeof parsed.e !== "number"
    )
      return null
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
/** Lecturas que muestran un secreto de la configuración: no son para soporte aunque su rol las vea. */
const SUPPORT_DENIED_GET = [/\/api\/connections\/[^/]+\/setup$/]

export function supportGuard(secret: Buffer, ownerDb: Db) {
  return async (c: Context, next: Next) => {
    const session = supportSessionOf(c)
    if (!session) return next()
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      await auditDenied(ownerDb, session)
      return c.json(
        errorBody(c, "SUPPORT_READ_ONLY", "Soporte solo mira: no puede cambiar nada"),
        403,
      )
    }
    if (SUPPORT_DENIED_GET.some((pattern) => pattern.test(c.req.path))) {
      await auditDenied(ownerDb, session)
      return c.json(errorBody(c, "FORBIDDEN", "Soporte no ve las claves de la clínica"), 403)
    }
    const origin = apiOriginOf(c)
    const proxy = (objectKey: string) =>
      `${origin}/api/support-session/file?t=${encodeURIComponent(signFile(secret, session.sessionId, objectKey, Date.now() + FILE_TOKEN_MS))}`
    await runReadOnly(() => runWithFileProxy(proxy, () => next()))
    if (isDownload(c.res)) {
      await auditDenied(ownerDb, session)
      c.res = c.json(
        errorBody(c, "SUPPORT_NO_DOWNLOAD", "Soporte solo mira: no descarga ni imprime"),
        403,
      )
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
  /** La persona con sesión normal en este navegador, si hay. */
  sessionUserOf: (c: Context) => Promise<string | null>
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
    if (!deps.isClinicOrigin(origin))
      return c.json(errorBody(c, "FORBIDDEN", "Origen no permitido"), 403)
    const body = (await c.req.json().catch(() => null)) as { pass?: unknown } | null
    const pass = typeof body?.pass === "string" ? body.pass : ""
    // Un pase no se canjea en el navegador de otra persona (alguien del equipo de la clínica
    // a quien le llegó el enlace): su navegador quedaría en modo soporte.
    const owner = await supportPassStaff(deps.ownerDb, pass)
    const current = await deps.sessionUserOf(c).catch(() => null)
    if (owner && current && current !== owner)
      return c.json(
        errorBody(c, "SUPPORT_PASS_INVALID", "Este pase es de otra persona: ábrelo en tu navegador"),
        403,
      )
    try {
      const redeemed = await redeemSupportPass(deps.ownerDb, pass)
      setCookie(c, redeemed.sessionToken, (redeemed.expiresAt.getTime() - Date.now()) / 1000)
      return c.json({ data: { expiresAt: redeemed.expiresAt.toISOString() } })
    } catch {
      return c.json(
        errorBody(c, "SUPPORT_PASS_INVALID", "El pase no sirve: pide otro desde la administración"),
        403,
      )
    }
  })

  app.get("/me", async (c) => {
    const token = cookieOf(c)
    const session = token ? await resolveSupportSession(deps.ownerDb, token) : null
    if (!session)
      return c.json(errorBody(c, "SUPPORT_ACCESS_ENDED", "El acceso de soporte terminó"), 401)
    const [org] = await deps.ownerDb
      .select({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        logo: organization.logo,
        product: orgProfile.product,
      })
      .from(organization)
      .leftJoin(orgProfile, eq(orgProfile.organizationId, organization.id))
      .where(eq(organization.id, session.organizationId))
      .limit(1)
    if (!org)
      return c.json(errorBody(c, "SUPPORT_ACCESS_ENDED", "El acceso de soporte terminó"), 401)
    const product = isClinicalProduct(org.product) ? org.product : "dental"
    // El equipo, como lo ve cualquiera de la clínica (nombres y roles; sin correos).
    const team = await deps.ownerDb
      .select({
        id: member.id,
        userId: member.userId,
        role: member.role,
        createdAt: member.createdAt,
        name: user.name,
        image: user.image,
      })
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
    if (!deps.isClinicOrigin(origin))
      return c.json(errorBody(c, "FORBIDDEN", "Origen no permitido"), 403)
    const token = cookieOf(c)
    if (token) await endSupportSession(deps.ownerDb, token)
    // La cookie se queda (ya no sirve): «El acceso terminó» la lee para decir «saliste».
    return c.json({ data: { ok: true } })
  })

  app.get("/ended", async (c) => {
    const token = cookieOf(c)
    const ending = token ? await supportSessionEnding(deps.ownerDb, token) : null
    return c.json({ data: ending })
  })

  // La firma liga el archivo a la sesión: sirve aunque el visor lo pida sin la cookie
  // (las tomografías lo piden con `fetch`), y la sesión se revisa en cada pedido.
  app.get("/file", async (c) => {
    const file = readFileToken(deps.secret, c.req.query("t") ?? "")
    const session =
      file && file.e >= Date.now() ? await resolveSupportSessionById(deps.ownerDb, file.s) : null
    if (!session || !file)
      return c.json(errorBody(c, "SUPPORT_ACCESS_ENDED", "El acceso de soporte terminó"), 401)
    // El archivo tiene que ser de esta clínica: su carpeta la nombra.
    if (!file.k.split("/").includes(session.organizationId))
      return c.json(errorBody(c, "FORBIDDEN", "Archivo de otra clínica"), 403)
    if (!deps.storage.streamAttachment)
      return c.json(errorBody(c, "UNAVAILABLE", "No disponible"), 503)
    // Solo lo que se mira: imágenes, PDF y los cortes de una tomografía, que el visor arma en
    // la pantalla. Lo demás (audio, adjuntos sueltos) se descargaría: no se sirve.
    const ext = file.k.split(".").at(-1)?.toLowerCase() ?? ""
    const VIEWABLE: Record<string, string> = {
      pdf: "application/pdf",
      png: "image/png",
      webp: "image/webp",
      gif: "image/gif",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      dcm: "application/dicom",
    }
    const type = VIEWABLE[ext] ?? (file.k.includes("/imaging/") ? "application/dicom" : undefined)
    if (!type)
      return c.json(
        errorBody(c, "SUPPORT_NO_DOWNLOAD", "Soporte solo mira: este archivo no se abre aquí"),
        403,
      )
    const stream = await deps.storage.streamAttachment(file.k)
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
