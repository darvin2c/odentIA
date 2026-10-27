import {
  inspectOwnAppToken,
  MetaSignupError,
  metaGraphVersion,
  newRegistrationPin,
  OwnAppTokenError,
  readOwnAppNumber,
  registerPhoneNumber,
  subscribeAppToAccount,
} from "@odentia/channels"
import type { Db } from "@odentia/db"
import { member } from "@odentia/db/schema/auth"
import { channelConnection, type ConnectionOwnApp } from "@odentia/db/schema/crm"
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm"
import { ServiceError } from "./errors.js"
import { getOrgLocale } from "./locale.js"
import { encryptJson } from "./secrets.js"
import { upsertWorkspaceNotification } from "./workspace.js"

/**
 * WhatsApp con la app propia de la clínica: lo que odentIA hace en Meta por
 * ella y lo que comprueba de sus claves. Meta solo deja registrar un número
 * por la API, no desde su página, y sin suscribir la app a la cuenta los avisos
 * de un número real no llegan: una clínica sin técnico no podría hacerlo sola.
 * Es el mismo registro y la misma suscripción que hace «Conectar con Facebook»,
 * con la clave de la clínica (ADR 0091).
 *
 * Sin probar contra una cuenta real de Meta: las respuestas son las que publica Meta.
 */

type ConnectionRow = typeof channelConnection.$inferSelect

/** Permisos sin los que la clave no puede enviar ni pedir mensajes. */
const REQUIRED_SCOPES: [string, string][] = [
  ["whatsapp_business_messaging", "enviar mensajes"],
  ["whatsapp_business_management", "administrar mensajes"],
]

/** Una clave que vence antes de esto es la temporal: mañana dejaría de funcionar. */
const TEMPORARY_KEY_MS = 2 * 86_400_000

/** Días antes del vencimiento de la clave en que se avisa. */
export const OWN_APP_TOKEN_WARN_DAYS = 7

/** Meta admite 10 intentos de registro por número cada 72 horas. */
const REGISTER_LIMIT = 10
const REGISTER_WINDOW_MS = 72 * 3_600_000

/** Códigos de Meta de un PIN que no es el del número. */
const WRONG_PIN = new Set([133005, 131031])

export interface OwnAppDeps {
  fetch: typeof fetch
}

/** Lo que salió de revisar las claves antes de guardarlas. */
export interface OwnAppKeysChecked {
  /** Meta respondió por la clave y la clave secreta; falso si no se pudo preguntar. */
  checked: boolean
  tokenExpiresAt: Date | null
}

const graphApp = () => ({ graphVersion: metaGraphVersion() })

const config = (value: Record<string, unknown>, key: string): string => {
  const found = value[key]
  return typeof found === "string" ? found.trim() : ""
}

/**
 * Revisa la clave de acceso y la clave secreta antes de guardarlas. Rechaza,
 * con la frase que dice qué hacer, la clave temporal de 24 horas, una clave
 * sin los permisos de mensajes y una clave secreta que no es de la misma app.
 * Si Meta no responde, o no dice de qué app es la clave, no se bloquea: la
 * conexión sigue y la firma de cada aviso lo comprueba después.
 */
export async function checkOwnAppKeys(
  value: Record<string, unknown>,
  deps: OwnAppDeps,
  now = new Date(),
): Promise<OwnAppKeysChecked> {
  let token: Awaited<ReturnType<typeof inspectOwnAppToken>>
  try {
    token = await inspectOwnAppToken(graphApp(), config(value, "accessToken"), config(value, "appSecret"), { fetch: deps.fetch })
  } catch (error) {
    if (error instanceof OwnAppTokenError && error.problem === "clave-secreta") {
      throw new ServiceError(
        "WHATSAPP_APP_SECRET_REJECTED",
        400,
        "La clave secreta no es de la misma app que la clave de acceso. Cópiala de esa app, en Configuración › Básica › «Clave secreta de la app».",
      )
    }
    return { checked: false, tokenExpiresAt: null }
  }
  if (token.type === "USER" || (token.expiresAt && token.expiresAt.getTime() - now.getTime() < TEMPORARY_KEY_MS)) {
    throw new ServiceError(
      "WHATSAPP_TEMPORARY_KEY",
      400,
      "Esa es la clave temporal de 24 horas: mañana dejaría de funcionar. Genera la permanente en Usuarios del sistema, con caducidad «Nunca» (paso 5 de la guía).",
    )
  }
  // Meta no siempre lista los permisos; solo se rechaza lo que dice que falta.
  const missing = token.scopes.length > 0 ? REQUIRED_SCOPES.filter(([scope]) => !token.scopes.includes(scope)) : []
  if (missing.length > 0) {
    throw new ServiceError(
      "WHATSAPP_KEY_SCOPES",
      400,
      `A la clave le falta el permiso para ${missing.map(([, words]) => words).join(" y ")}. Genérala de nuevo marcando los tres permisos: business_management, whatsapp_business_management y whatsapp_business_messaging.`,
    )
  }
  return { checked: true, tokenExpiresAt: token.expiresAt }
}

/** Lo nuevo de una conexión recién revisada, sin pasos hechos todavía. */
export function freshOwnApp(keys: OwnAppKeysChecked, previous?: ConnectionOwnApp | null, now = new Date()): ConnectionOwnApp {
  return {
    registeredAt: previous?.registeredAt ?? null,
    subscribedAt: previous?.subscribedAt ?? null,
    problems: previous?.problems ?? {},
    ...(previous?.pinNeeded ? { pinNeeded: true } : {}),
    ...(previous?.registerAttempts ? { registerAttempts: previous.registerAttempts } : {}),
    tokenExpiresAt: keys.tokenExpiresAt?.toISOString() ?? null,
    keysCheckedAt: keys.checked ? now.toISOString() : null,
    signatureRejectedAt: null,
  }
}

function transientWords(): string {
  return "Meta no respondió. Vuelve a comprobar en un momento."
}

/** Qué decirle a la clínica cuando Meta no registró el número. */
function registerProblem(error: unknown, attemptsLeft: number): { text: string; pinNeeded: boolean } {
  if (!(error instanceof MetaSignupError)) return { text: "No pudimos registrar el número. Vuelve a comprobar.", pinNeeded: false }
  if (error.transient) return { text: transientWords(), pinNeeded: false }
  const left =
    attemptsLeft < REGISTER_LIMIT - 2
      ? ` Meta permite ${REGISTER_LIMIT} intentos cada 3 días; ${attemptsLeft === 1 ? "queda 1" : `quedan ${attemptsLeft}`}.`
      : ""
  if (error.code !== null && WRONG_PIN.has(error.code)) {
    return {
      text: `Este número ya tiene un PIN de verificación en dos pasos. Escríbelo para registrarlo; si no lo recuerdas, cámbialo en WhatsApp Manager › tu número › «Verificación en dos pasos».${left}`,
      pinNeeded: true,
    }
  }
  switch (error.code) {
    case 133006:
      return {
        text: "Meta aún no verificó el número: confírmalo con el código por SMS o llamada en tu app de Meta (WhatsApp › Configuración de la API) y vuelve a comprobar.",
        pinNeeded: false,
      }
    case 133008:
    case 133009:
      return { text: `Meta frenó los intentos de PIN por un rato («${error.detail}»). Espera y vuelve a comprobar.`, pinNeeded: false }
    case 133015:
      return { text: "Ese número se borró hace poco y Meta aún no termina: espera 5 minutos y vuelve a comprobar.", pinNeeded: false }
    case 133016:
      return {
        text: `Meta permite ${REGISTER_LIMIT} intentos de registro cada 3 días y este número ya los usó. Vuelve a intentarlo en 3 días.`,
        pinNeeded: false,
      }
    default:
      return {
        text: `Meta no registró el número («${error.detail}»). Si el número sigue en la aplicación WhatsApp de un teléfono, bórralo ahí (Ajustes › Cuenta › Eliminar cuenta) y vuelve a comprobar.${left}`,
        pinNeeded: false,
      }
  }
}

function subscribeProblem(error: unknown): string {
  if (error instanceof MetaSignupError && error.transient) return transientWords()
  const detail = error instanceof MetaSignupError ? error.detail : "sin detalle"
  return `Meta no dejó que tu app reciba los avisos de la cuenta («${detail}»). Revisa que el usuario del sistema tenga control total de la cuenta de WhatsApp (paso 5 de la guía).`
}

/**
 * Hace en Meta lo que falta de una conexión con la app propia: suscribir la app
 * a la cuenta y registrar el número. Lo ya hecho no se repite. Un número ya
 * registrado no se registra de nuevo; si no lo está, el PIN se inventa (o es el
 * que escribió la clínica) y se guarda cifrado antes de llamar a Meta, como en
 * «Conectar con Facebook». Un PIN que Meta no aceptó se olvida: repetirlo
 * gastaría los intentos del número. Lo que falló queda en `ownApp.problems`.
 */
export async function settleOwnApp(
  tx: Db,
  row: ConnectionRow,
  value: Record<string, unknown>,
  secretsKey: Buffer,
  deps: OwnAppDeps,
  options: { pin?: string; now?: Date } = {},
): Promise<ConnectionRow> {
  const current = row.ownApp
  if (!current || row.provider !== "whatsapp_cloud_api" || row.signup) return row
  const now = options.now ?? new Date()
  const app = graphApp()
  const meta = { fetch: deps.fetch }
  const token = config(value, "accessToken")
  const next: ConnectionOwnApp = { ...current, problems: { ...current.problems } }
  let nextConfig = value

  if (!next.subscribedAt) {
    try {
      await subscribeAppToAccount(app, config(value, "wabaId"), token, meta)
      next.subscribedAt = now.toISOString()
      delete next.problems.suscribir
    } catch (error) {
      next.problems.suscribir = subscribeProblem(error)
    }
  }

  if (!next.registeredAt) {
    const phoneNumberId = config(value, "phoneNumberId")
    let registered = false
    try {
      registered = (await readOwnAppNumber(app, phoneNumberId, token, meta)).platformType === "CLOUD_API"
    } catch {
      // Sin saberlo se intenta registrar: Meta responde si el PIN no es el suyo.
    }
    const stored = config(value, "pin")
    const pin = options.pin ?? (stored || null)
    if (registered) {
      next.registeredAt = now.toISOString()
      next.pinNeeded = false
      delete next.problems.registrar
    } else if (next.pinNeeded && !options.pin) {
      // Ya se sabe que el número tiene otro PIN: no se gasta un intento sin el suyo.
    } else {
      const attempts = (next.registerAttempts ?? []).filter((at) => now.getTime() - Date.parse(at) < REGISTER_WINDOW_MS)
      const usePin = pin ?? newRegistrationPin()
      if (usePin !== stored) {
        nextConfig = { ...value, pin: usePin }
        await saveConfig(tx, row, nextConfig, secretsKey)
      }
      try {
        await registerPhoneNumber(app, phoneNumberId, token, usePin, meta)
        next.registeredAt = now.toISOString()
        next.pinNeeded = false
        delete next.problems.registrar
        delete next.registerAttempts
      } catch (error) {
        const transient = error instanceof MetaSignupError && error.transient
        if (!transient) attempts.push(now.toISOString())
        next.registerAttempts = attempts
        const problem = registerProblem(error, Math.max(0, REGISTER_LIMIT - attempts.length))
        next.problems.registrar = problem.text
        if (problem.pinNeeded) {
          next.pinNeeded = true
          const { pin: _forgotten, ...withoutPin } = nextConfig
          nextConfig = withoutPin
          await saveConfig(tx, row, nextConfig, secretsKey)
        }
      }
    }
  }

  const [updated] = await tx
    .update(channelConnection)
    .set({ ownApp: next, updatedAt: now })
    .where(and(eq(channelConnection.id, row.id), eq(channelConnection.organizationId, row.organizationId)))
    .returning()
  return updated ?? row
}

async function saveConfig(tx: Db, row: ConnectionRow, value: Record<string, unknown>, secretsKey: Buffer): Promise<void> {
  await tx
    .update(channelConnection)
    .set({ configEncrypted: encryptJson(secretsKey, value) })
    .where(and(eq(channelConnection.id, row.id), eq(channelConnection.organizationId, row.organizationId)))
}

/* ---------- Avisos de la campana ---------- */

const signatureSubject = (connectionId: string) => `firma-meta:${connectionId}`
const expirySubject = (connectionId: string) => `vence-clave-meta:${connectionId}`
const WHATSAPP_SETTINGS_HREF = "/settings/integrations/whatsapp"

/** Avisos que se retiran solos cuando se resuelven (`settleWorkspaceNotifications`). */
async function notifyAdmins(
  tx: Db,
  orgId: string,
  subject: string,
  notice: { title: string; body: string },
): Promise<void> {
  const admins = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, orgId), inArray(member.role, ["owner", "admin"])))
    .limit(20)
  for (const { userId } of admins) {
    await upsertWorkspaceNotification(tx, orgId, {
      userId,
      dedupeKey: `${subject}:${userId}`,
      ...notice,
      href: WHATSAPP_SETTINGS_HREF,
      permission: "settings.write",
      subject,
    })
  }
}

/**
 * Llegó un aviso a la dirección de una conexión con la app propia y su firma no
 * es de la clave secreta guardada: casi siempre es una clave secreta de otra
 * app o una que se cambió en Meta. Se anota (sin el aviso) para decirlo en
 * pantalla; Meta lo reintenta durante 7 días, así que al corregir la clave
 * llega solo. Se anota como mucho cada 5 minutos, y la campana avisa una vez.
 */
export async function noteOwnAppSignatureRejected(tx: Db, orgId: string, connectionId: string, now = new Date()): Promise<void> {
  const [updated] = await tx
    .update(channelConnection)
    .set({ ownApp: sql`jsonb_set(${channelConnection.ownApp}, '{signatureRejectedAt}', to_jsonb(${now.toISOString()}::text))` })
    .where(
      and(
        eq(channelConnection.id, connectionId),
        eq(channelConnection.organizationId, orgId),
        isNotNull(channelConnection.ownApp),
        isNull(channelConnection.signup),
        sql`coalesce((${channelConnection.ownApp}->>'signatureRejectedAt')::timestamptz, '-infinity') < ${new Date(now.getTime() - 5 * 60_000).toISOString()}::timestamptz`,
      ),
    )
    .returning({ id: channelConnection.id })
  if (!updated) return
  await notifyAdmins(tx, orgId, signatureSubject(connectionId), {
    title: "WhatsApp: llegó un mensaje que no pudimos leer",
    body: "Meta lo firmó con otra clave secreta. Pega la «Clave secreta de la app» de la misma app en Configuración › Integraciones › WhatsApp › Cambiar la clave.",
  })
}

/** Llegó un aviso bien firmado: lo anterior ya no vale. */
export async function clearOwnAppSignatureRejected(tx: Db, orgId: string, connectionId: string): Promise<void> {
  await tx
    .update(channelConnection)
    .set({ ownApp: sql`${channelConnection.ownApp} - 'signatureRejectedAt'` })
    .where(
      and(
        eq(channelConnection.id, connectionId),
        eq(channelConnection.organizationId, orgId),
        sql`${channelConnection.ownApp}->>'signatureRejectedAt' is not null`,
      ),
    )
}

/** Conexiones con la app propia cuya clave vence en los próximos días: de todas las clínicas (rol owner). */
export async function listOwnAppTokensExpiring(ownerDb: Db, now: Date): Promise<{ orgId: string; connectionId: string; expiresAt: string }[]> {
  const limit = new Date(now.getTime() + OWN_APP_TOKEN_WARN_DAYS * 86_400_000).toISOString()
  const rows = await ownerDb
    .select({ orgId: channelConnection.organizationId, id: channelConnection.id, ownApp: channelConnection.ownApp })
    .from(channelConnection)
    .where(
      and(
        eq(channelConnection.provider, "whatsapp_cloud_api"),
        eq(channelConnection.status, "active"),
        sql`(${channelConnection.ownApp}->>'tokenExpiresAt')::timestamptz <= ${limit}::timestamptz`,
      ),
    )
  return rows.flatMap((row) =>
    row.ownApp?.tokenExpiresAt ? [{ orgId: row.orgId, connectionId: row.id, expiresAt: row.ownApp.tokenExpiresAt }] : [],
  )
}

/**
 * Avisa en la campana que la clave de la app propia vence pronto o ya venció.
 * odentIA no puede renovarla sola en este camino: la genera la clínica en Meta.
 */
export async function notifyOwnAppTokenExpiring(tx: Db, orgId: string, connectionId: string, expiresAt: string, now = new Date()): Promise<void> {
  const zone = await getOrgLocale(tx, orgId)
  const day = new Date(expiresAt).toLocaleDateString(zone.locale, { timeZone: zone.timezone, day: "numeric", month: "long" })
  const expired = Date.parse(expiresAt) <= now.getTime()
  await notifyAdmins(tx, orgId, expirySubject(connectionId), {
    title: expired ? "La clave de WhatsApp venció" : `La clave de WhatsApp vence el ${day}`,
    body: `${expired ? "Los mensajes de WhatsApp ya no pueden salir." : "Ese día los mensajes de WhatsApp dejarán de salir."} Genera en Meta una clave con caducidad «Nunca» y pégala en Configuración › Integraciones › WhatsApp › Cambiar la clave.`,
  })
}
