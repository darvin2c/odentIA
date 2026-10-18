import { createHash } from "node:crypto"
import type { BetterAuthPlugin } from "better-auth"
import { APIError, createAuthMiddleware } from "better-auth/api"

/**
 * Decisión 4 del lienzo de acceso: no se aceptan contraseñas que aparecen en
 * filtraciones conocidas (Have I Been Pwned, NIST SP 800-63B §3.1.1.2). Solo
 * viajan los 5 primeros caracteres del SHA-1 (k-anonimato).
 *
 * Si el servicio no responde, la contraseña se acepta: un tercero caído no
 * deja a nadie sin entrar. Por eso no se usa el `haveIBeenPwned` de Better
 * Auth, que en ese caso rechaza.
 */

const PATHS = new Set([
  "/sign-up/email",
  "/change-password",
  "/reset-password",
  "/access-link/set-password",
])
const TIMEOUT_MS = 3000

export type BreachLookup = (prefix: string) => Promise<string>

const pwnedRange: BreachLookup = async (prefix) => {
  const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
    headers: { "Add-Padding": "true", "User-Agent": "odentIA" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HIBP ${res.status}`)
  return res.text()
}

/** true si aparece en filtraciones; false si no aparece o si no se pudo comprobar. */
export async function isPasswordBreached(
  password: string,
  lookup: BreachLookup = pwnedRange,
): Promise<boolean> {
  const hash = createHash("sha1").update(password).digest("hex").toUpperCase()
  const prefix = hash.slice(0, 5)
  const suffix = hash.slice(5)
  let body: string
  try {
    body = await lookup(prefix)
  } catch {
    return false
  }
  for (const line of body.split(/\r?\n/)) {
    const [rest, count] = line.trim().split(":")
    if (rest?.toUpperCase() === suffix && Number(count) > 0) return true
  }
  return false
}

export const passwordBreachCheck = (options: { enabled: boolean; lookup?: BreachLookup }) =>
  ({
    id: "password-breach-check",
    hooks: {
      before: [
        {
          matcher: (ctx) => options.enabled && !!ctx.path && PATHS.has(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            const body = ctx.body as { password?: unknown; newPassword?: unknown } | undefined
            const password = ctx.path === "/sign-up/email" ? body?.password : body?.newPassword
            if (typeof password !== "string" || !password) return
            if (await isPasswordBreached(password, options.lookup)) {
              throw APIError.from("BAD_REQUEST", {
                code: "PASSWORD_COMPROMISED",
                message: "Esta contraseña aparece en filtraciones conocidas. Elige otra.",
              })
            }
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin
