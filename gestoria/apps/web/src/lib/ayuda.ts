import { SUPPORT_STATUS_WORDS } from "./plan"

/**
 * «Tus casos con soporte» de la Ayuda: lo que la persona escribió al equipo de gestorIA, con sus
 * respuestas (`GET /api/tiendas/:id/ayuda/casos`). La guía y lo que responde Ariadna los arma el
 * servidor (`apps/api/src/ayuda.ts`).
 */

export interface HelpQuestion {
  /** El caso en la administración; null mientras no vuelve entre sus casos. */
  id: string | null
  question: string
  createdAt: string
  status: string
  replies: { body: string; at: string }[]
}

export const HELP_KEY = (storeId: string) => ["ayuda", storeId]

/** Cómo va una pregunta: por salir, enviada o lo que dice la administración de su caso. */
export function questionStatus(status: string): string {
  if (status === "por_enviar") return "Por enviar"
  if (status === "enviada") return "Enviada"
  return SUPPORT_STATUS_WORDS[status] ?? "Recibida"
}

/**
 * El panel abierto que la Ayuda tiene como pantalla propia (`panel` de `HELP_SCREENS`, como
 * «Probar como clienta» al lado de la ficha): no tiene ruta, así que la Ayuda lo manda como
 * `#<panel>` junto a la ruta. Lo pone el panel mientras está abierto.
 */
export const helpPanel: { current: string | null } = { current: null }

/** La ruta que va a la Ayuda, con el panel abierto si lo hay. */
export function withHelpPanel(path: string): string {
  return helpPanel.current && !path.includes("#") ? `${path}#${helpPanel.current}` : path
}

/** La llamada del panel de la Ayuda con el panel abierto en la ruta (`/screen?path=` o `screen`). */
export function helpRequestWithPanel(
  path: string,
  body: Record<string, unknown> | undefined,
): { path: string; body: Record<string, unknown> | undefined } {
  if (!helpPanel.current) return { path, body }
  const [base = path, query = ""] = path.split("?", 2)
  const params = new URLSearchParams(query)
  const screen = params.get("path")
  if (screen !== null) params.set("path", withHelpPanel(screen))
  return {
    path: query ? `${base}?${params.toString()}` : path,
    body:
      body && typeof body.screen === "string"
        ? { ...body, screen: withHelpPanel(body.screen) }
        : body,
  }
}
