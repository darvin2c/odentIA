import { inspectSignupToken, type MetaPlatformApp, refreshSignupToken, type SignupTokenState } from "@odentia/channels"
import { type Db, withOrgContext } from "@odentia/db"
import {
  listSignupTokensDue,
  noteSignupTokenProblem,
  noteSignupTokenState,
  SIGNUP_TOKEN_RENEW_DAYS,
  saveRenewedSignupToken,
  signupTokenOf,
  signupTokenProblem,
} from "@odentia/services"

export interface SignupTokenTickOptions {
  app: MetaPlatformApp
  secretsKey: Buffer
  fetch: typeof fetch
  now?: Date
}

export interface SignupTokenTickResult {
  /** Claves cuyo vencimiento se le preguntó a Meta. */
  checked: number
  renewed: number
  errors: string[]
}

/**
 * La clave que da Meta al «Conectar con Facebook» vence a los 60 días
 * (darvin2c/odentIA#121). Esta vuelta la renueva sola, sin la clínica:
 * - si no se sabe cuándo vence, se lo pregunta a Meta;
 * - 15 días antes de que venza, pide otra con la vigente y la guarda.
 *
 * Meta no respondió: se reintenta en la vuelta siguiente. Meta dijo que no: el
 * motivo queda en la conexión y se reintenta mientras la clave siga vigente.
 * Pedir otra dos veces no rompe nada (la anterior sirve hasta que vence), así
 * que repetir una renovación incierta es seguro.
 *
 * Lee las conexiones de todas las clínicas con el rol owner; lo que guarda,
 * con `appDb` en el contexto de cada clínica.
 */
export async function runSignupTokenTick(
  ownerDb: Db,
  appDb: Db,
  opts: SignupTokenTickOptions,
): Promise<SignupTokenTickResult> {
  const now = opts.now ?? new Date()
  const result: SignupTokenTickResult = { checked: 0, renewed: 0, errors: [] }
  const meta = { fetch: opts.fetch }
  for (const due of await listSignupTokensDue(ownerDb, now)) {
    const { orgId, connectionId } = due
    let token: string
    try {
      token = await withOrgContext(appDb, orgId, (tx) => signupTokenOf(tx, orgId, connectionId, opts.secretsKey))
    } catch (error) {
      result.errors.push(`Conexión ${connectionId}: ${messageOf(error)}`)
      continue
    }
    const note = (problem: string) =>
      withOrgContext(appDb, orgId, (tx) =>
        noteSignupTokenProblem(tx, orgId, connectionId, opts.secretsKey, token, problem),
      )
    let renew = due.action === "renovar"
    if (due.action === "revisar") {
      try {
        const state = await inspectSignupToken(opts.app, token, meta)
        await withOrgContext(appDb, orgId, (tx) =>
          noteSignupTokenState(tx, orgId, connectionId, opts.secretsKey, token, state),
        )
        result.checked += 1
        // Recién se supo que vence pronto: se renueva en esta misma vuelta.
        renew = state.valid && state.expiresAt !== null && dueSoon(state.expiresAt, now)
      } catch (error) {
        const problem = signupTokenProblem(error)
        if (problem) await note(problem)
        result.errors.push(`Revisar clave ${connectionId}: ${messageOf(error)}`)
        continue
      }
    }
    if (!renew) continue
    try {
      const fresh = await refreshSignupToken(opts.app, token, meta)
      const state: SignupTokenState | null = fresh.expiresInSeconds
        ? { valid: true, expiresAt: new Date(now.getTime() + fresh.expiresInSeconds * 1000) }
        : await inspectSignupToken(opts.app, fresh.token, meta).catch(() => null)
      const saved = await withOrgContext(appDb, orgId, (tx) =>
        saveRenewedSignupToken(tx, orgId, connectionId, opts.secretsKey, { previous: token, token: fresh.token, state }),
      )
      if (saved) result.renewed += 1
    } catch (error) {
      const problem = signupTokenProblem(error)
      if (problem) await note(problem).catch(() => {})
      result.errors.push(`Renovar clave ${connectionId}: ${messageOf(error)}`)
    }
  }
  return result
}

/** Igual que `signupTokenAction`: se renueva cuando faltan 15 días o menos. */
function dueSoon(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() - now.getTime() <= SIGNUP_TOKEN_RENEW_DAYS * 86_400_000
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "error desconocido"
}
