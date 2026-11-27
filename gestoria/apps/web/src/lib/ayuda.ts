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
