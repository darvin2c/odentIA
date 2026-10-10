import type { Locator, Page } from "@playwright/test"

type RoleOptions = Parameters<Page["getByRole"]>[1]

/**
 * Superficie lateral por su nombre, esté donde esté: en ventana ancha un
 * formulario va a la columna del layout (región no modal) y en estrecha, o con
 * la columna ocupada, a un cajón (diálogo). Los recorridos describen qué se
 * abre, no en qué contenedor.
 */
export function surface(page: Page, options?: RoleOptions): Locator {
  return page.getByRole("dialog", options).or(page.getByRole("region", options))
}
