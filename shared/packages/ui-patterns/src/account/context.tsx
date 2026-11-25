import { createContext, type ReactNode, useContext } from "react"
import type { ApiErrorShape } from "../error-state.js"

/**
 * Las pantallas de la cuenta (Mi perfil, dos pasos, sesiones, soporte y cerrar la cuenta) son
 * las mismas en todas las apps del grupo (lienzo «Una cuenta, todas las apps», decisión 7): cada
 * app las sirve en su dominio y con su marca, y les pasa con qué hablar con la cuenta. Nada de
 * aquí sabe de clínicas ni de tiendas: lo propio de cada app entra por sus ranuras.
 */

/** El rechazo de la cuenta tal como lo devuelve el cliente de Better Auth. */
export interface AccountClientError {
  status?: number
  code?: string
  message?: string
  error?: unknown
}

type Result<T> = Promise<{ data?: T | null; error?: AccountClientError | null }>

/** Una sesión de la lista de «Sesiones activas». */
export interface AccountSessionRow {
  token: string
  userAgent?: string | null
  ipAddress?: string | null
  updatedAt: string | Date
}

/**
 * Lo mínimo del cliente de Better Auth (`createAuthClient` con `twoFactorClient`) que usan estas
 * pantallas. Cada app pasa el suyo: con su dirección y sus cookies.
 */
export interface AccountClient {
  useSession: () => {
    data?: {
      user: {
        name: string
        email: string
        image?: string | null
        firstName?: string | null
        lastName?: string | null
      }
      session: { token: string }
    } | null
  }
  updateUser: (input: {
    name?: string
    firstName?: string
    lastName?: string
    image?: string | null
  }) => Result<unknown>
  changePassword: (input: {
    currentPassword: string
    newPassword: string
    revokeOtherSessions?: boolean
  }) => Result<unknown>
  changeEmail: (input: { newEmail: string; callbackURL?: string }) => Result<unknown>
  listSessions: () => Result<AccountSessionRow[]>
  revokeSession: (input: { token: string }) => Result<unknown>
  revokeOtherSessions: () => Result<unknown>
  twoFactor: {
    enable: (input: {
      password: string
      method?: "totp" | "otp"
    }) => Result<{ method: "otp" } | { method: "totp"; totpURI: string; backupCodes: string[] }>
    verifyTotp: (input: { code: string }) => Result<unknown>
    getTotpUri: (input: { password: string }) => Result<{ totpURI: string }>
    generateBackupCodes: (input: { password: string }) => Result<{ backupCodes: string[] }>
    disable: (input: { password: string }) => Result<unknown>
  }
}

/** El rechazo de una ruta propia de la cuenta (`/api/account/*`), en la forma que leen los formularios. */
export class AccountRequestError extends Error {
  constructor(
    readonly status: number,
    readonly shape: ApiErrorShape,
  ) {
    super(shape.message ?? `Error ${status}`)
  }
}

export interface AccountServices {
  client: AccountClient
  /** La API de la cuenta de esta app (`https://api.<su dominio>`), sin la barra final. */
  apiUrl: string
  /** El nombre de la app en los textos («Códigos de respaldo de gestorIA»). */
  appName: string
  /** Dónde vive Mi perfil en esta app (`/profile`, `/cuenta`): los cajones se abren con `?edit=`. */
  profilePath: string
  /** El ejemplo de correo de los avisos («nombre@clinica.com»). */
  emailExample: string
  /** «La pide» cuando ningún lugar de la persona la pide (por omisión, el de las clínicas). */
  twoFactorSelf?: string
  /** El personal de la administración maneja sus dos pasos allí. */
  knownStaff?: boolean
  /** Tras cambiar el nombre o la foto: la app pone al día lo que muestra de la persona. */
  onPersonChanged?: () => void
}

const AccountContext = createContext<AccountServices | null>(null)

export function AccountProvider({
  value,
  children,
}: {
  value: AccountServices
  children: ReactNode
}) {
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>
}

export function useAccount(): AccountServices {
  const value = useContext(AccountContext)
  if (!value) throw new Error("Las pantallas de la cuenta van dentro de <AccountProvider>")
  return value
}

/** Fetch a la API de la cuenta con las cookies de la sesión; el rechazo llega como `AccountRequestError`. */
export async function accountFetch<T>(
  apiUrl: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  // Un archivo va como multipart (lo arma el navegador); lo demás, JSON. `init` primero: sus
  // cabeceras se suman a las de siempre.
  const file = typeof FormData !== "undefined" && init?.body instanceof FormData
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    credentials: "include",
    headers: { ...(file ? {} : { "content-type": "application/json" }), ...init?.headers },
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: ApiErrorShape } | null
    throw new AccountRequestError(response.status, body?.error ?? {})
  }
  return (await response.json()) as T
}

/** `accountFetch` con la API de la app. */
export function useAccountFetch() {
  const { apiUrl } = useAccount()
  return <T,>(path: string, init?: RequestInit) => accountFetch<T>(apiUrl, path, init)
}
