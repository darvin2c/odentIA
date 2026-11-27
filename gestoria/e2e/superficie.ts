import type { Locator, Page } from "@playwright/test"

type RoleOptions = Parameters<Page["getByRole"]>[1]

/**
 * Lo que se abre al lado, por su nombre, esté donde esté (como en las clínicas): en una ventana
 * ancha va a la columna lateral del armazón (una región, no modal); en una estrecha, o con la
 * columna ocupada, a un cajón (un diálogo). El recorrido dice qué se abre, no en qué contenedor.
 */
export function surface(page: Page, options?: RoleOptions): Locator {
  return page.getByRole("dialog", options).or(page.getByRole("region", options))
}
