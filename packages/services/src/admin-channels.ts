/**
 * Las cuentas de Meta de la administración (la app propia de Sallca, no la de
 * «Conectar con Facebook» de las clínicas): el número de WhatsApp, la página
 * de Facebook (Messenger) y la cuenta de Instagram ligada a esa página. Cada
 * canal se prende solo cuando están sus variables y las dos comunes (la clave
 * secreta de la app y el token del reto de su dirección). Sin ninguno, la
 * dirección `/api/webhooks/meta/admin` no existe y «Escribir» sigue con wa.me.
 */

export interface AdminChannelsEnv {
  ADMIN_META_APP_SECRET: string
  ADMIN_META_VERIFY_TOKEN: string
  ADMIN_WA_PHONE_NUMBER_ID: string
  ADMIN_WA_ACCESS_TOKEN: string
  ADMIN_META_PAGE_ID: string
  ADMIN_META_PAGE_ACCESS_TOKEN: string
  ADMIN_IG_ACCOUNT_ID: string
}

export interface AdminChannels {
  /** Firma los avisos de la app de la administración (`x-hub-signature-256`). */
  appSecret: string
  /** Con él Meta verifica la dirección de avisos. */
  verifyToken: string
  whatsapp?: { phoneNumberId: string; accessToken: string }
  messenger?: { pageId: string; accessToken: string }
  /**
   * Instagram por la página (Messenger Platform para Instagram): se envía con
   * el token de la página a `/{page-id}/messages`, y los avisos traen el id de
   * la cuenta de Instagram.
   */
  instagram?: { accountId: string; pageId: string; accessToken: string }
}

export const ADMIN_CHANNELS_ENV = [
  "ADMIN_META_APP_SECRET",
  "ADMIN_META_VERIFY_TOKEN",
  "ADMIN_WA_PHONE_NUMBER_ID",
  "ADMIN_WA_ACCESS_TOKEN",
  "ADMIN_META_PAGE_ID",
  "ADMIN_META_PAGE_ACCESS_TOKEN",
  "ADMIN_IG_ACCOUNT_ID",
] as const satisfies readonly (keyof AdminChannelsEnv)[]

/** Lo configurado, o nada si no hay ningún canal completo. Puro: no avisa. */
export function adminChannelsFromEnv(env: AdminChannelsEnv): AdminChannels | undefined {
  const v = (key: keyof AdminChannelsEnv) => env[key]?.trim() ?? ""
  const appSecret = v("ADMIN_META_APP_SECRET")
  const verifyToken = v("ADMIN_META_VERIFY_TOKEN")
  if (!appSecret || !verifyToken) return undefined
  const channels: AdminChannels = { appSecret, verifyToken }
  if (v("ADMIN_WA_PHONE_NUMBER_ID") && v("ADMIN_WA_ACCESS_TOKEN"))
    channels.whatsapp = {
      phoneNumberId: v("ADMIN_WA_PHONE_NUMBER_ID"),
      accessToken: v("ADMIN_WA_ACCESS_TOKEN"),
    }
  if (v("ADMIN_META_PAGE_ID") && v("ADMIN_META_PAGE_ACCESS_TOKEN")) {
    channels.messenger = {
      pageId: v("ADMIN_META_PAGE_ID"),
      accessToken: v("ADMIN_META_PAGE_ACCESS_TOKEN"),
    }
    if (v("ADMIN_IG_ACCOUNT_ID"))
      channels.instagram = {
        accountId: v("ADMIN_IG_ACCOUNT_ID"),
        pageId: v("ADMIN_META_PAGE_ID"),
        accessToken: v("ADMIN_META_PAGE_ACCESS_TOKEN"),
      }
  }
  if (!channels.whatsapp && !channels.messenger) return undefined
  return channels
}

/**
 * Lo que queda a medias, para avisarlo al arrancar: variables puestas que no
 * prenden su canal (falta su pareja o las comunes). Nulo si todo está completo
 * o vacío a propósito.
 */
export function adminChannelsWarning(env: AdminChannelsEnv): string | null {
  const set = ADMIN_CHANNELS_ENV.filter((key) => env[key]?.trim())
  if (set.length === 0) return null
  const missing = new Set<string>()
  const has = (key: keyof AdminChannelsEnv) => Boolean(env[key]?.trim())
  const need = (keys: (keyof AdminChannelsEnv)[]) => {
    for (const key of keys) if (!has(key)) missing.add(key)
  }
  need(["ADMIN_META_APP_SECRET", "ADMIN_META_VERIFY_TOKEN"])
  if (has("ADMIN_WA_PHONE_NUMBER_ID") || has("ADMIN_WA_ACCESS_TOKEN"))
    need(["ADMIN_WA_PHONE_NUMBER_ID", "ADMIN_WA_ACCESS_TOKEN"])
  if (
    has("ADMIN_META_PAGE_ID") ||
    has("ADMIN_META_PAGE_ACCESS_TOKEN") ||
    has("ADMIN_IG_ACCOUNT_ID")
  )
    need(["ADMIN_META_PAGE_ID", "ADMIN_META_PAGE_ACCESS_TOKEN"])
  const hasChannel =
    (has("ADMIN_WA_PHONE_NUMBER_ID") && has("ADMIN_WA_ACCESS_TOKEN")) ||
    (has("ADMIN_META_PAGE_ID") && has("ADMIN_META_PAGE_ACCESS_TOKEN"))
  if (!hasChannel && missing.size === 0)
    return "Los canales de la administración quedan apagados: falta el número de WhatsApp o la página de Facebook."
  if (missing.size === 0) return null
  return `Los canales de la administración quedan a medias: faltan ${[...missing].join(", ")}. Lo que no está completo sigue apagado.`
}
