import { type ClinicalProduct, productWords } from "@odentia/clinical"
import { ACCOUNT_APPS } from "@odentia/db/schema/auth"
import type { MailBrand } from "@odentia/mail"

export { ACCOUNT_APPS }

/**
 * Las apps del grupo que entran con la cuenta (ADR 0201, paso 2 del lienzo A): una sola
 * cuenta por persona para todas, y cada app con su pantalla de entrada, su dominio y su
 * marca. Lo que cada persona puede hacer dentro de una app lo decide esa app, nunca la
 * cuenta. Sumar una app es sumarla aquí: el compilador señala cada lugar que decide algo
 * por app (`Record<AccountApp, …>`).
 *
 * La clave de una app de clínicas es la marca de su producto (`productWords(p).brand`):
 * odentIA, latidIA y vistIA viven en esta misma base. gestorIA es otro sistema, con su
 * base y su servidor: conoce a la persona por la cuenta, nunca por las tablas de aquí.
 */
export type AccountApp = (typeof ACCOUNT_APPS)[number]

/** La app base: la de quien se registró antes de que la cuenta recordara su app. */
export const BASE_ACCOUNT_APP = "odentia" satisfies AccountApp

export interface AccountAppInfo {
  /** El nombre de la app como lo ve la persona. */
  name: string
  /**
   * El producto de sus clínicas, si sus datos viven en esta base. Nulo: la app es otro
   * sistema; se entera de lo que pasa con la cuenta por los avisos (`account-events.ts`).
   */
  product: ClinicalProduct | null
  /**
   * La marca de los correos de la cuenta en su entrada (verificar, entrar, cambiar el
   * correo). Nula: todavía no tiene correos con su marca y su entrada no se enciende
   * (`accountAppNotReady`): nunca le llega a nadie un correo con la marca de otra app.
   */
  mailBrand: MailBrand | null
}

function clinicApp(product: ClinicalProduct): AccountAppInfo {
  const words = productWords(product)
  return { name: words.name, product, mailBrand: words.brand }
}

export const ACCOUNT_APP_INFO: Record<AccountApp, AccountAppInfo> = {
  odentia: clinicApp("dental"),
  latidia: clinicApp("medical"),
  vistia: clinicApp("optical"),
  // La marca de sus correos va en `shared/packages/mail`, en un cambio aparte: hasta
  // entonces su entrada queda apagada aunque se configure su dominio.
  gestoria: { name: "gestorIA", product: null, mailBrand: null },
}

/** La app de las clínicas de un producto. */
export function appOfProduct(product: ClinicalProduct): AccountApp {
  return productWords(product).brand
}

export function isAccountApp(value: unknown): value is AccountApp {
  return typeof value === "string" && (ACCOUNT_APPS as readonly string[]).includes(value)
}

/**
 * Las apps que son otro sistema y se enteran por aviso de lo que pasa con la cuenta. Las
 * de clínicas no lo necesitan: cerrar una cuenta les quita a la persona de sus equipos en
 * la misma transacción.
 */
export const EXTERNAL_ACCOUNT_APPS: readonly AccountApp[] = ACCOUNT_APPS.filter(
  (app) => ACCOUNT_APP_INFO[app].product === null,
)

/**
 * Por qué la entrada de una app no se puede encender todavía; null si se puede. Una
 * entrada sin la marca de sus correos mandaría la verificación con la de otra app.
 */
export function accountAppNotReady(app: AccountApp): string | null {
  return ACCOUNT_APP_INFO[app].mailBrand
    ? null
    : `La entrada de ${ACCOUNT_APP_INFO[app].name} queda apagada: sus correos todavía no tienen su marca.`
}
