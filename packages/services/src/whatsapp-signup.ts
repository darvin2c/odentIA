import {
  channelAdapters,
  exchangeSignupCode,
  type MetaPlatformApp,
  MetaSignupError,
  newRegistrationPin,
  type ProviderAccount,
  registerPhoneNumber,
  subscribeAppToAccount,
} from "@odentia/channels"
import type { Db } from "@odentia/db"
import { channelConnection, type ConnectionSignup } from "@odentia/db/schema/crm"
import { and, eq } from "drizzle-orm"
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
  try {
    token = await exchangeSignupCode(app, code, { fetch: deps.fetch })
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
  return { token, wabaId, phoneNumberId, checked }
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
  const origin: SignupOrigin = { checked: grant.checked, accountId: grant.wabaId, at: new Date() }
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
