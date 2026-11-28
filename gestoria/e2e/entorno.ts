/** Lo que comparten el entorno (`servidor.ts`), la configuración y los recorridos de gestorIA. */
import type { Locator, Page } from "@playwright/test"

export const API_PORT = 4710
export const ACCOUNT_PORT = 4711
export const WEB_PORT = 4712
export const WEB = `http://127.0.0.1:${WEB_PORT}`
export const ACCOUNT = `http://127.0.0.1:${ACCOUNT_PORT}`

/** La tienda que abre la administración para su clienta. */
export const STORE_ID = "4f9a3c2e-8b1d-4e6f-9a7c-2d5b8e1f3a60"

export const PEOPLE = {
  rosa: { id: "e2e-rosa", email: "rosa@calzados.test", name: "Rosa Quispe" },
  ana: { id: "e2e-ana", email: "ana@soporte.test", name: "Ana de Soporte" },
  /** Atiende la tienda con el rol de Ventas. */
  lucia: { id: "e2e-lucia", email: "lucia@calzados.test", name: "Lucía Torres" },
  /** Todavía sin tienda: crea la suya en el recorrido de los primeros pasos. */
  carmen: { id: "e2e-carmen", email: "carmen@tortas.test", name: "Carmen Huanca" },
} as const
export type Who = keyof typeof PEOPLE

/** La contraseña de todas en la cuenta de mentira. */
export const CLAVE = "clave-de-prueba"

/** El código de la app de autenticación que acepta la cuenta de mentira al activar los dos pasos. */
export const CODIGO_TOTP = "246810"

/**
 * Un formulario o un detalle lateral por su título, como en los recorridos de las clínicas
 * (`e2e/admin.ts`): abierto desde una página, en ventana ancha va en la columna lateral (una
 * región); abierto desde lo que ya está en la columna, o en el teléfono, en cajón (un diálogo).
 */
export function surface(page: Page, name: string | RegExp): Locator {
  const exact = typeof name === "string"
  return page.getByRole("dialog", { name, exact }).or(page.getByRole("region", { name, exact }))
}

/**
 * Elige en el `Select` común (`field.SelectField`, `Select` de `@odentia/ui`) por el texto de la
 * opción, como `chooseOption` de los recorridos de las clínicas (`e2e/fixtures.ts`).
 */
export async function choose(trigger: Locator, option: string | RegExp) {
  await trigger.click()
  await trigger
    .page()
    .getByRole("option", { name: option, exact: typeof option === "string" })
    .click()
}
