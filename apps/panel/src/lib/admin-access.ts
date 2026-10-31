import { queryOptions, useQuery } from "@tanstack/react-query"
import { z } from "zod"
import { apiFetch } from "./api"

// `registered` con valor por defecto: el panel puede llegar antes que la API que ya lo entrega.
const accessSchema = z.object({ data: z.object({ staff: z.boolean(), registered: z.boolean().default(false) }) })
export const adminAccessQuery = queryOptions({
  queryKey: ["account", "admin-access"],
  queryFn: async () => accessSchema.parse(await apiFetch<unknown>("/api/account/admin-access")).data,
  staleTime: 60_000,
})

/**
 * Si ya se sabe que es del personal, sin otro pedido: la consulta la hace el
 * layout `_app` y esto solo la lee. Mientras no se sabe, responde que no.
 */
export function useKnownStaff(): boolean {
  return useQuery({ ...adminAccessQuery, enabled: false }).data?.staff === true
}

/** Lo mismo, contando a quien se desactivó: su verificación tampoco se maneja en Mi perfil. */
export function useKnownStaffRecord(): boolean {
  return useQuery({ ...adminAccessQuery, enabled: false }).data?.registered === true
}
