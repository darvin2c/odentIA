/**
 * Las lecturas de la ficha del cliente que comparten la cabecera y sus
 * pestañas (Resumen, Contactos): una sola petición por ficha, con su clave
 * bajo `["admin", "client", id]`, que toda mutación del cliente invalida.
 */
import { useQuery } from "@tanstack/react-query"
import { z } from "zod"
import { api } from "../../lib/api"
import { clientDetailSchema, clientKey, contactRowSchema, kairosItemsSchema } from "./client-model"

const enc = encodeURIComponent

export const clientQueryKeys = {
  detail: (clientId: string) => [...clientKey(clientId), "detalle"] as const,
  contacts: (clientId: string) => [...clientKey(clientId), "contactos"] as const,
  history: (clientId: string, filter: string) =>
    [...clientKey(clientId), "historial", filter] as const,
  kairos: (clientId: string) => ["admin", "kairos", "items", "espera", clientId] as const,
}

/** La ficha: cabecera, datos, personas, tareas abiertas, últimas actividades y señales. */
export function useClientDetail(clientId: string) {
  return useQuery({
    queryKey: clientQueryKeys.detail(clientId),
    queryFn: async () =>
      clientDetailSchema.parse(await api<unknown>(`/api/admin/clients/${enc(clientId)}`)),
  })
}

/** Las personas del cliente y, con cuenta, los miembros de su equipo que aún no son una persona ligada. */
export function useClientContacts(clientId: string) {
  return useQuery({
    queryKey: clientQueryKeys.contacts(clientId),
    queryFn: async () =>
      z
        .array(contactRowSchema)
        .parse(await api<unknown>(`/api/admin/clients/${enc(clientId)}/contacts`)),
  })
}

/** Lo que Kairós dejó para este cliente esperando el sí de una persona (lo de Soporte, filtrado por el servidor). */
export function useClientKairosItems(clientId: string) {
  return useQuery({
    queryKey: clientQueryKeys.kairos(clientId),
    queryFn: async () =>
      kairosItemsSchema.parse(
        await api<unknown>(
          `/api/admin/kairos/items?status=espera&clientId=${enc(clientId)}&limit=5`,
        ),
      ),
  })
}
