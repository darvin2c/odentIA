import {
  channelAdapters,
  exchangeSignupCode,
  type MetaPlatformApp,
  MetaSignupError,
  newRegistrationPin,
  type ProviderAccount,
  registerPhoneNumber,
  type SignupTokenState,
  subscribeAppToAccount,
} from "@odentia/channels"
import type { Db } from "@odentia/db"
import { member } from "@odentia/db/schema/auth"
import { channelConnection, type ConnectionSignup } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { and, eq, inArray, isNotNull } from "drizzle-orm"
import {
  changeConnectionCredentials,
  completeConnectionAccount,
  type ConnectionChecked,
  type ConnectionDeps,
  createConnection,
  getConnectionSecrets,
  type ProviderCheck,
  SIGNUP_STEPS,
  type SignupOrigin,
  type SignupStep,
} from "./connections.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { getOrgLocale } from "./locale.js"
import { reportAutomaticCase } from "./model-outage.js"
import { decryptConfig, encryptJson } from "./secrets.js"
import { settleWorkspaceNotifications, upsertWorkspaceNotification } from "./workspace.js"

/**
 * «Conectar con Facebook» (Embedded Signup de Meta, versión 4): la clínica entra
 * con su Facebook en la ventana de Meta y vuelve con un código. Con él odentIA
 * obtiene el permiso de su cuenta, guarda la conexión, suscribe su app a los
 * avisos de esa cuenta y registra el número. Motivos en
 * `docs/decisions/0020-conectar-whatsapp-con-facebook.md`.
 *
 * El recorrido alterna pasos sin base (solo llaman a Meta) y pasos con base
 * (cortos, sin red), para no dejar una transacción abierta esperando a Meta:
 *
 *   1. `redeemWhatsAppSignup`   sin base   canjea el código y comprueba el número
 *   2. `openWhatsAppSignup`     con base   crea la conexión, o le cambia el permiso
 *   3. `runSignupSteps`         sin base   suscribe la app y registra el número
 *   4. `closeWhatsAppSignup`    con base   anota cómo quedó cada paso, lee la salud
 *                                          y pide los mensajes (como al conectar a mano)
 *
 * Desde el paso 2 la conexión existe y no se deshace: el código ya se gastó y
 * el PIN del número ya está guardado. Si un paso de Meta falla, la conexión dice
 * cuál falta y por qué (`signup.pending`) y se reintenta con el permiso guardado
 * (`pendingSignupWork` → pasos 3 y 4), sin abrir otra vez la ventana de Meta.
 *
 * NADA DE ESTO SE HA PROBADO CONTRA META: la app de odentIA todavía no existe.
 * Las pruebas usan un `fetch` que responde con la forma que publica Meta.
 */

/** Lo que la pantalla trae de la ventana de Meta. */
export interface SignupInput {
  /** Código de un solo uso; vive 30 segundos. */
  code: string
  /** Cuenta de WhatsApp Business que eligió la clínica. */
  wabaId: string
  /** Número que eligió la clínica. */
  phoneNumberId: string
}

/** El permiso recién canjeado y lo que Meta respondió por el número con él. */
export interface SignupGrant {
  token: string
  /** Cuándo vence `token`; nulo si Meta no lo dijo. */
  expiresAt: Date | null
  wabaId: string
  phoneNumberId: string
  checked: ProviderCheck
}

/** Lo que falta hacer en Meta por una conexión, con lo necesario para hacerlo. */
export interface SignupWork {
  connectionId: string
  token: string
  wabaId: string
  phoneNumberId: string
  pin: string
  steps: SignupStep[]
  /** Lo que Meta dijo de la cuenta en este recorrido; nulo en un reintento. */
  account: ProviderAccount | null
}

export interface SignupStepResult {
  step: SignupStep
  ok: boolean
  /** Qué pasó y qué hacer, cuando no salió. */
  problem: string | null
}

const WHATSAPP = { channel: "whatsapp", provider: "whatsapp_cloud_api" } as const

/** Códigos del Graph API que significan «falta permiso». */
function lacksPermission(code: number | null): boolean {
  return code === 3 || code === 10 || (code !== null && code >= 200 && code <= 299)
}

/**
 * Por qué no se pudo canjear el código, con lo que puede hacer quien conecta.
 * En este punto todavía no se guardó nada.
 */
function redeemFailure(error: unknown): ServiceError {
  if (!(error instanceof MetaSignupError) || error.transient) {
    return new ServiceError(
      "META_UNAVAILABLE",
      502,
      "Meta no respondió, y el permiso que diste dura 30 segundos. No se conectó nada: vuelve a pulsar «Conectar con Facebook».",
    )
  }
  // La clave de la app es de odentIA: quien conecta no puede corregirla.
  if (error.code === 101 || /client[ _]secret|app(lication)?[ _]secret/i.test(error.detail)) {
    return new ServiceError(
      "SIGNUP_MISCONFIGURED",
      502,
      "Meta no reconoció la app de odentIA. No es algo que puedas corregir tú: avísanos. No se conectó nada.",
    )
  }
  return new ServiceError(
    "SIGNUP_CODE_EXPIRED",
    400,
    `El permiso de Facebook ya no sirve: dura 30 segundos y se usa una sola vez. No se conectó nada: vuelve a pulsar «Conectar con Facebook». Meta dijo: «${error.detail}».`,
  )
}

/** Por qué no salió un paso de una conexión que ya existe, y qué hacer. */
function stepProblem(step: SignupStep, error: unknown): string {
  if (!(error instanceof MetaSignupError)) {
    return "odentIA no pudo completar este paso. Reintenta en un momento."
  }
  if (error.transient) return "Meta no respondió. Reintenta en un momento."
  const { code } = error
  if (code === 0 || code === 190) {
    return "El permiso que diste con Facebook venció o fue retirado. Vuelve a conectar con Facebook."
  }
  if (step === "registrar") {
    // https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes
    if (code === 133005) {
      return "Ese número ya tiene un PIN de verificación en dos pasos que odentIA no conoce. Desactiva la verificación en dos pasos del número en el Administrador de WhatsApp de la clínica y reintenta."
    }
    if (code === 133006) {
      return "El número todavía no está verificado. Vuelve a conectar con Facebook y, en la ventana de Meta, confírmalo con el código que llega al teléfono."
    }
    if (code === 133008 || code === 133009) {
      return "WhatsApp bloqueó por un rato los intentos con el PIN de ese número. Espera y reintenta."
    }
    if (code === 133015) {
      return "Ese número se eliminó hace poco de WhatsApp y Meta todavía lo procesa. Espera unos minutos y reintenta."
    }
    if (code === 133016) {
      return "WhatsApp bloqueó el registro de ese número por demasiados intentos. Dura 72 horas: reintenta cuando pasen."
    }
    if (code === 133000 || code === 133004) {
      return "WhatsApp no pudo registrar el número por un problema de su lado. Reintenta en un momento."
    }
  }
  if (lacksPermission(code)) {
    return "A odentIA le falta permiso sobre esa cuenta de WhatsApp. Vuelve a conectar con Facebook y acepta todos los permisos que pide la ventana de Meta."
  }
  if (code === 368 || code === 131031) {
    return "WhatsApp restringió esa cuenta por sus políticas. Revísalo en el Administrador de WhatsApp de la clínica y reintenta."
  }
  if (code === 4 || code === 80007) {
    return "Meta está limitando las llamadas por ahora. Reintenta en unos minutos."
  }
  return `Meta no aceptó este paso: ${error.detail}. Reintenta; si sigue igual, vuelve a conectar con Facebook.`
}

/**
 * Paso 1, sin base: canjea el código (lo primero, porque vive 30 segundos) y
 * comprueba con el permiso recién dado que el número existe y se puede leer.
 * Si algo falla aquí no se guardó nada.
 */
export async function redeemWhatsAppSignup(
  app: MetaPlatformApp,
  input: SignupInput,
  deps: Pick<ConnectionDeps, "fetch">,
): Promise<SignupGrant> {
  const code = input.code.trim()
  const wabaId = input.wabaId.trim()
  const phoneNumberId = input.phoneNumberId.trim()
  if (!code) throw validation("Falta el permiso que devuelve la ventana de Meta.")
  if (!wabaId || !phoneNumberId) {
    throw validation("La ventana de Meta no dijo qué cuenta y qué número se eligieron.")
  }
  let token: string
  let expiresAt: Date | null
  try {
    const exchanged = await exchangeSignupCode(app, code, { fetch: deps.fetch })
    token = exchanged.token
    expiresAt = exchanged.expiresInSeconds ? new Date(Date.now() + exchanged.expiresInSeconds * 1000) : null
  } catch (error) {
    throw redeemFailure(error)
  }
  const adapter = channelAdapters[WHATSAPP.provider]
  if (!adapter) throw validation(`Proveedor desconocido o no registrado: ${WHATSAPP.provider}`)
  let checked: ProviderCheck
  try {
    checked = await adapter.validateConnection(
      { phoneNumberId, wabaId, accessToken: token },
      { fetch: deps.fetch },
    )
  } catch (error) {
    // El adaptador lanza con este texto cuando Meta responde que no; lo demás es la red.
    const refused = error instanceof Error && error.message.startsWith("WhatsApp validate falló")
    throw refused
      ? new ServiceError(
          "CONNECTION_REJECTED",
          400,
          "Meta no dejó leer ese número con el permiso recién dado. No se conectó nada: vuelve a pulsar «Conectar con Facebook» y, en la ventana de Meta, elige la cuenta de WhatsApp y el número de la clínica.",
        )
      : redeemFailure(error)
  }
  return { token, expiresAt, wabaId, phoneNumberId, checked }
}

/**
 * Paso 2, con base y sin red: guarda la conexión con sus pasos pendientes, o
 * —con `reconnectConnectionId`— reemplaza el permiso de la que ya existe
 * (misma conexión, mismas conversaciones). El número que ya está conectado, aquí
 * o en otra clínica, responde el mismo `CONNECTION_EXISTS` que al conectar a mano.
 *
 * El PIN del registro se guarda cifrado con la conexión ANTES de usarlo: Meta lo
 * deja como PIN de verificación en dos pasos del número y lo exige después.
 */
export async function openWhatsAppSignup(
  tx: Db,
  orgId: string,
  secretsKey: Buffer,
  grant: SignupGrant,
  options: { reconnectConnectionId?: string | undefined },
  deps: ConnectionDeps,
): Promise<SignupWork> {
  const origin: SignupOrigin = {
    checked: grant.checked,
    accountId: grant.wabaId,
    at: new Date(),
    tokenExpiresAt: grant.expiresAt,
  }
  const account = grant.checked.account ?? null
  if (options.reconnectConnectionId) {
    const id = options.reconnectConnectionId
    await changeConnectionCredentials(
      tx,
      orgId,
      id,
      secretsKey,
      { config: { accessToken: grant.token, wabaId: grant.wabaId, phoneNumberId: grant.phoneNumberId } },
      deps,
      origin,
    )
    const work = await pendingSignupWork(tx, orgId, secretsKey, id)
    // Con un permiso nuevo la suscripción se pide de nuevo: repetirla no cambia nada.
    const steps = SIGNUP_STEPS.filter((step) => step === "suscribir" || work.steps.includes(step))
    return { ...work, steps, account }
  }
  const pin = newRegistrationPin()
  const created = await createConnection(
    tx,
    orgId,
    secretsKey,
    {
      ...WHATSAPP,
      config: {
        phoneNumberId: grant.phoneNumberId,
        wabaId: grant.wabaId,
        accessToken: grant.token,
        registrationPin: pin,
      },
    },
    deps,
    origin,
  )
  return {
    connectionId: created.id,
    token: grant.token,
    wabaId: grant.wabaId,
    phoneNumberId: grant.phoneNumberId,
    pin,
    steps: [...SIGNUP_STEPS],
    account,
  }
}

/**
 * Lo que falta de una conexión hecha con el botón, para reintentarlo con el
 * permiso que ya tiene. Con base y sin red.
 */
export async function pendingSignupWork(
  tx: Db,
  orgId: string,
  secretsKey: Buffer,
  connectionId: string,
): Promise<SignupWork> {
  const { row, config } = await getConnectionSecrets(tx, orgId, connectionId, secretsKey)
  if (!row.signup) {
    throw validation("Esta conexión no se hizo con «Conectar con Facebook»: no tiene pasos pendientes.")
  }
  const pick = (key: string): string => {
    const value = config[key]
    if (typeof value !== "string" || !value) {
      throw validation("A esta conexión le falta un dato del permiso. Vuelve a conectarla con Facebook.")
    }
    return value
  }
  const done: Record<SignupStep, string | null> = {
    suscribir: row.signup.subscribedAt,
    registrar: row.signup.registeredAt,
  }
  return {
    connectionId,
    token: pick("accessToken"),
    wabaId: pick("wabaId"),
    phoneNumberId: pick("phoneNumberId"),
    pin: pick("registrationPin"),
    steps: SIGNUP_STEPS.filter((step) => !done[step]),
    account: null,
  }
}

/**
 * Paso 3, sin base: hace en Meta lo que falta, en orden. Un paso que no sale no
 * impide intentar el siguiente: son independientes y cada uno dice lo suyo.
 */
export async function runSignupSteps(
  app: Pick<MetaPlatformApp, "graphVersion">,
  work: SignupWork,
  deps: Pick<ConnectionDeps, "fetch">,
): Promise<SignupStepResult[]> {
  const results: SignupStepResult[] = []
  for (const step of SIGNUP_STEPS) {
    if (!work.steps.includes(step)) continue
    try {
      if (step === "suscribir") {
        await subscribeAppToAccount(app, work.wabaId, work.token, { fetch: deps.fetch })
      } else {
        await registerPhoneNumber(app, work.phoneNumberId, work.token, work.pin, { fetch: deps.fetch })
      }
      results.push({ step, ok: true, problem: null })
    } catch (error) {
      results.push({ step, ok: false, problem: stepProblem(step, error) })
    }
  }
  return results
}

/**
 * Paso 4, con base: anota cómo quedó cada paso y deja la cuenta como al conectar
 * a mano (salud del número y sus mensajes pedidos). Devuelve lo mismo que
 * `createConnection`, con `signup.pending` diciendo lo que haya quedado sin hacer.
 */
export async function closeWhatsAppSignup(
  tx: Db,
  orgId: string,
  secretsKey: Buffer,
  work: Pick<SignupWork, "connectionId" | "account">,
  results: SignupStepResult[],
  deps: ConnectionDeps,
): Promise<ConnectionChecked> {
  const [row] = await tx
    .select({ signup: channelConnection.signup })
    .from(channelConnection)
    .where(and(eq(channelConnection.id, work.connectionId), eq(channelConnection.organizationId, orgId)))
    .for("update")
    .limit(1)
  if (!row?.signup) throw notFound("Conexión")
  const now = new Date().toISOString()
  const signup: ConnectionSignup = { ...row.signup, problems: { ...row.signup.problems } }
  for (const result of results) {
    const field = result.step === "suscribir" ? "subscribedAt" : "registeredAt"
    if (result.ok) {
      signup[field] = now
      delete signup.problems[result.step]
    } else {
      // Un paso repetido que ahora falla (la suscripción al volver a conectar) deja de darse por hecho.
      signup[field] = null
      signup.problems[result.step] = result.problem ?? "No se pudo completar."
    }
  }
  await tx
    .update(channelConnection)
    .set({ signup, updatedAt: new Date() })
    .where(and(eq(channelConnection.id, work.connectionId), eq(channelConnection.organizationId, orgId)))
  return completeConnectionAccount(tx, orgId, work.connectionId, secretsKey, work.account, deps)
}

/* ---------- La clave de Meta se renueva sola (darvin2c/odentIA#121) ---------- */

/**
 * Días antes del vencimiento en que se renueva la clave. Con la vuelta del
 * worker cada 12 horas quedan unos 30 intentos si Meta falla: la clínica no
 * tiene que volver a conectar mientras Meta siga renovándola.
 */
export const SIGNUP_TOKEN_RENEW_DAYS = 15

const DAY_MS = 86_400_000

/** Qué pide hoy la clave de una conexión hecha con el botón. */
export type SignupTokenAction = "revisar" | "renovar"

/**
 * - «revisar»: no se sabe cuándo vence (Meta no lo dijo al canjear, o la
 *   conexión es de antes de guardarlo): se le pregunta a Meta.
 * - «renovar»: vence en 15 días o menos.
 * - Nada: no vence, falta para renovarla, o ya no sirve y solo queda volver a
 *   conectar (su problema queda anotado).
 */
export function signupTokenAction(signup: ConnectionSignup, now: Date): SignupTokenAction | null {
  if (signup.tokenNeverExpires) return null
  if (!signup.tokenExpiresAt) return signup.tokenProblem ? null : "revisar"
  const left = Date.parse(signup.tokenExpiresAt) - now.getTime()
  if (left < 0 && signup.tokenProblem) return null
  return left <= SIGNUP_TOKEN_RENEW_DAYS * DAY_MS ? "renovar" : null
}

export interface SignupTokenDue {
  orgId: string
  connectionId: string
  action: SignupTokenAction
  /** Cuándo vence la clave, si se sabe. */
  expiresAt: string | null
}

/**
 * Las conexiones de WhatsApp activas hechas con «Conectar con Facebook» cuya
 * clave hay que revisar o renovar hoy. Recorre todas las clínicas: rol owner.
 */
export async function listSignupTokensDue(ownerDb: Db, now: Date): Promise<SignupTokenDue[]> {
  const rows = await ownerDb
    .select({ orgId: channelConnection.organizationId, id: channelConnection.id, signup: channelConnection.signup })
    .from(channelConnection)
    .where(
      and(
        eq(channelConnection.provider, WHATSAPP.provider),
        eq(channelConnection.status, "active"),
        isNotNull(channelConnection.signup),
      ),
    )
  const due: SignupTokenDue[] = []
  for (const row of rows) {
    const action = row.signup ? signupTokenAction(row.signup, now) : null
    if (action) due.push({ orgId: row.orgId, connectionId: row.id, action, expiresAt: row.signup?.tokenExpiresAt ?? null })
  }
  return due
}

/** La clave vigente de una conexión hecha con el botón. */
export async function signupTokenOf(tx: Db, orgId: string, connectionId: string, secretsKey: Buffer): Promise<string> {
  const { row, config } = await getConnectionSecrets(tx, orgId, connectionId, secretsKey)
  const token = config["accessToken"]
  if (!row.signup || typeof token !== "string" || !token) {
    throw validation("Esta conexión no tiene una clave dada con «Conectar con Facebook».")
  }
  return token
}

/**
 * La conexión con su registro del alta, bloqueada, solo si sigue con la clave
 * con que se habló con Meta. Si alguien volvió a conectar mientras tanto, manda
 * la clave de ese momento y lo de la anterior ya no se anota.
 */
async function lockSignupWithToken(
  tx: Db,
  orgId: string,
  connectionId: string,
  secretsKey: Buffer,
  token: string,
): Promise<{ signup: ConnectionSignup; config: Record<string, unknown> } | null> {
  const [row] = await tx
    .select({ signup: channelConnection.signup, configEncrypted: channelConnection.configEncrypted })
    .from(channelConnection)
    .where(and(eq(channelConnection.id, connectionId), eq(channelConnection.organizationId, orgId)))
    .for("update")
    .limit(1)
  if (!row?.signup) return null
  const config = decryptConfig(secretsKey, row.configEncrypted)
  return config["accessToken"] === token ? { signup: row.signup, config } : null
}

/** La clave ya no sirve: solo la repone volver a conectar. */
const SIGNUP_TOKEN_DEAD =
  "La clave que dio Meta ya no sirve: venció o la retiraron. Vuelve a conectar con Facebook para que los mensajes sigan saliendo."

/** Anota lo que Meta dijo de la clave: cuándo vence, que no vence o que ya no sirve. */
export async function noteSignupTokenState(
  tx: Db,
  orgId: string,
  connectionId: string,
  secretsKey: Buffer,
  token: string,
  state: SignupTokenState,
): Promise<void> {
  const locked = await lockSignupWithToken(tx, orgId, connectionId, secretsKey, token)
  if (!locked) return
  const signup: ConnectionSignup = state.valid
    ? {
        ...locked.signup,
        tokenExpiresAt: state.expiresAt?.toISOString() ?? null,
        tokenNeverExpires: state.expiresAt === null,
        tokenProblem: null,
      }
    : { ...locked.signup, tokenProblem: SIGNUP_TOKEN_DEAD }
  await tx
    .update(channelConnection)
    .set({ signup, updatedAt: new Date() })
    .where(and(eq(channelConnection.id, connectionId), eq(channelConnection.organizationId, orgId)))
  if (state.valid) await settleWorkspaceNotifications(tx, orgId, { subject: tokenSubject(connectionId) })
  else await notifySignupTokenProblem(tx, orgId, connectionId, signup)
}

/**
 * Guarda la clave renovada en lugar de la anterior y deja constancia en la
 * auditoría. `state` es lo que se sabe de la nueva; sin él, el worker le
 * pregunta a Meta cuándo vence en la vuelta siguiente. Devuelve si se guardó.
 */
export async function saveRenewedSignupToken(
  tx: Db,
  orgId: string,
  connectionId: string,
  secretsKey: Buffer,
  input: { previous: string; token: string; state: SignupTokenState | null },
): Promise<boolean> {
  const locked = await lockSignupWithToken(tx, orgId, connectionId, secretsKey, input.previous)
  if (!locked) return false
  const signup: ConnectionSignup = {
    ...locked.signup,
    tokenExpiresAt: input.state?.expiresAt?.toISOString() ?? null,
    tokenNeverExpires: input.state !== null && input.state.expiresAt === null,
    tokenProblem: null,
  }
  await tx
    .update(channelConnection)
    .set({
      configEncrypted: encryptJson(secretsKey, { ...locked.config, accessToken: input.token }),
      signup,
      updatedAt: new Date(),
    })
    .where(and(eq(channelConnection.id, connectionId), eq(channelConnection.organizationId, orgId)))
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    action: "whatsapp.token_renewed",
    entity: "channel_connection",
    entityId: connectionId,
    metadata: { expiresAt: signup.tokenExpiresAt ?? null, neverExpires: signup.tokenNeverExpires ?? false },
  })
  await settleWorkspaceNotifications(tx, orgId, { subject: tokenSubject(connectionId) })
  return true
}

/**
 * Por qué Meta no renovó o no dejó revisar la clave, en palabras; nulo si Meta
 * no respondió (se reintenta en la vuelta siguiente sin anotar nada).
 */
export function signupTokenProblem(error: unknown): string | null {
  if (!(error instanceof MetaSignupError)) {
    return "odentIA no pudo renovar la clave de Meta. Se reintenta en la próxima vuelta."
  }
  if (error.transient) return null
  if (error.code === 190) return SIGNUP_TOKEN_DEAD
  return `Meta no renovó la clave: «${error.detail}». Se reintenta cada 12 horas mientras siga vigente; si vence, vuelve a conectar con Facebook.`
}

/** Anota por qué no se pudo renovar o revisar la clave con que se intentó. */
export async function noteSignupTokenProblem(
  tx: Db,
  orgId: string,
  connectionId: string,
  secretsKey: Buffer,
  token: string,
  problem: string,
): Promise<void> {
  const locked = await lockSignupWithToken(tx, orgId, connectionId, secretsKey, token)
  if (!locked) return
  const signup: ConnectionSignup = { ...locked.signup, tokenProblem: problem }
  await tx
    .update(channelConnection)
    .set({ signup, updatedAt: new Date() })
    .where(and(eq(channelConnection.id, connectionId), eq(channelConnection.organizationId, orgId)))
  await notifySignupTokenProblem(tx, orgId, connectionId, signup)
}

/** Asunto del aviso de la campana: se retira solo cuando la clave ya no tiene problema. */
const tokenSubject = (connectionId: string) => `clave-meta:${connectionId}`

/** La pantalla donde se vuelve a conectar. */
const WHATSAPP_SETTINGS_HREF = "/settings/integrations/whatsapp"

/**
 * Avisa en la campana a quien administra las integraciones (dueño y
 * administradores: `settings.write`) que la clave no se pudo renovar. No
 * nombra claves ni lo que dijo Meta: eso va al caso de Soporte. Un aviso por
 * conexión, que se pone al día si cambia (de «no se pudo renovar» a «dejó de
 * servir») y se retira solo cuando se renueva o se vuelve a conectar.
 */
async function notifySignupTokenProblem(tx: Db, orgId: string, connectionId: string, signup: ConnectionSignup): Promise<void> {
  const admins = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, orgId), inArray(member.role, ["owner", "admin"])))
    .limit(20)
  if (admins.length === 0) return
  const dead = signup.tokenProblem === SIGNUP_TOKEN_DEAD
  const zone = await getOrgLocale(tx, orgId)
  const until = signup.tokenExpiresAt
    ? new Date(signup.tokenExpiresAt).toLocaleDateString(zone.locale, { timeZone: zone.timezone, day: "numeric", month: "long" })
    : null
  const notice = dead
    ? {
        title: "La conexión de WhatsApp con Meta dejó de servir",
        body: "Los mensajes de WhatsApp no pueden salir. Vuelve a conectar con Facebook en Configuración › Integraciones › WhatsApp. Ya avisamos a odentIA.",
      }
    : until
      ? {
          title: "WhatsApp no pudo renovar su conexión con Meta",
          body: `La conexión vence el ${until}. odentIA lo sigue intentando y ya está avisado. Si llega esa fecha sin renovarse, vuelve a conectar con Facebook en Configuración › Integraciones › WhatsApp.`,
        }
      : {
          title: "WhatsApp no pudo revisar su conexión con Meta",
          body: "odentIA no pudo comprobar cuándo vence la conexión y ya está avisado. Si los mensajes dejan de salir, vuelve a conectar con Facebook en Configuración › Integraciones › WhatsApp.",
        }
  for (const { userId } of admins) {
    await upsertWorkspaceNotification(tx, orgId, {
      userId,
      dedupeKey: `${tokenSubject(connectionId)}:${userId}`,
      ...notice,
      href: WHATSAPP_SETTINGS_HREF,
      permission: "settings.write",
      subject: tokenSubject(connectionId),
    })
  }
}

/** Lo que Soporte de odentIA necesita para ayudar: qué dijo Meta y cuándo vence. */
export interface SignupTokenFailure {
  orgId: string
  connectionId: string
  /** Código de Meta, o la clase del problema si Meta no dio uno. */
  code: string
  detail: string
  expiresAt: string | null
}

/**
 * Abre o amplía el caso automático «Clave de Meta sin renovar» en Soporte: uno
 * por motivo, con cada clínica afectada. Si Meta no acepta la renovación para
 * ninguna clínica, es un solo caso con todas.
 */
export async function reportSignupTokenFailure(ownerDb: Db, failure: SignupTokenFailure): Promise<{ caseId: string; created: boolean }> {
  return reportAutomaticCase(ownerDb, {
    dedupeKey: `clave-meta-sin-renovar:${failure.code}`,
    title: "Clave de Meta sin renovar",
    orgId: failure.orgId,
    note: `WhatsApp (conexión ${failure.connectionId}${failure.expiresAt ? `, vence ${failure.expiresAt}` : ""}): ${failure.detail}`,
    detail: `Meta (${failure.code}): ${failure.detail}`,
    screen: WHATSAPP_SETTINGS_HREF,
  })
}
