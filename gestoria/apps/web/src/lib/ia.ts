import { toast } from "@odentia/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "./api"
import type { Sheet } from "./ficha"

/**
 * La IA de fotos en la pantalla (lienzo «La ficha del producto», decisiones 3, 7, 9 y 10): mira
 * las fotos y propone; nada se guarda hasta que una persona lo usa (✦ Usar, Cambiar, Descartar,
 * «Aplicar todos»). La pantalla no decide nada: muestra lo que dice el servidor (`propuestas.ts`)
 * y le pide usar o descartar.
 */

export type ProposalKind =
  | "nombre"
  | "categoria"
  | "rubro"
  | "descripcion"
  | "palabras"
  | "color"
  | "juntar"
  | "dato"
  | "pregunta"

export interface ColorValue {
  name: string
  hex: string
  hex2: string | null
  photos: string[]
}

export interface Proposal {
  id: string
  /** `nombre`, `dato:material`, `pregunta:horma`… */
  field: string
  kind: ProposalKind
  value: unknown
  reason: string
  state: "propuesta" | "usada" | "cambiada" | "descartada"
  productId: string | null
  itemId: string | null
  loadId: string | null
  /** En un producto de una carga: se usa en la ficha, al crear el producto. */
  waitsForProduct: boolean
  createdBy: string | null
  createdAt: string
}

export type CapReason = "sin_ia" | "tope" | "saldo" | "sin_acceso"

/** Si la IA puede mirar ahora y, si no, qué decirle a la persona (sigue a mano). */
export interface Cap {
  available: boolean
  reason: CapReason | null
  used: number
  cap: number
  left: number
  message: string | null
}

export interface LastLook {
  id: string
  state: "mirando" | "lista" | "fallo"
  failure: string | null
  notice: string | null
  photos: number
  requestedAt: string
}

export interface ProductProposals {
  proposals: Proposal[]
  decided: Proposal[]
  look: LastLook | null
  cap: Cap
  canDecide: boolean
}

export interface LoadProposals {
  proposals: Proposal[]
  look: LastLook | null
  cap: Cap
}

export const PROPOSALS_KEY = (storeId: string, productId: string) => [
  "propuestas",
  storeId,
  productId,
]
export const LOAD_PROPOSALS_KEY = (storeId: string, loadId: string) => [
  "propuestas-carga",
  storeId,
  loadId,
]

/** La clave del dato de `dato:material` o `pregunta:material`. */
export const keyOf = (field: string) => field.slice(field.indexOf(":") + 1)

export function useProductProposals(storeId: string, productId: string) {
  return useQuery({
    queryKey: PROPOSALS_KEY(storeId, productId),
    queryFn: () => api<ProductProposals>(`/api/tiendas/${storeId}/productos/${productId}/ia`),
  })
}

export function useLoadProposals(storeId: string, loadId: string | null) {
  return useQuery({
    queryKey: LOAD_PROPOSALS_KEY(storeId, loadId ?? ""),
    queryFn: () => api<LoadProposals>(`/api/tiendas/${storeId}/cargas/${loadId}/ia`),
    enabled: !!loadId,
  })
}

export function useCap(storeId: string) {
  return useQuery({
    queryKey: ["ia-tope", storeId],
    queryFn: () => api<{ cap: Cap }>(`/api/tiendas/${storeId}/ia`).then((r) => r.cap),
  })
}

/** Usar (o cambiar, con `value`) una propuesta: devuelve la ficha o el producto de la carga. */
export function applyProposal(storeId: string, id: string, value?: unknown) {
  return api<{ result: unknown }>(`/api/tiendas/${storeId}/ia/propuestas/${id}/usar`, {
    method: "POST",
    body: value === undefined ? {} : { value },
  }).then((r) => r.result)
}

export function discardProposal(storeId: string, id: string) {
  return api(`/api/tiendas/${storeId}/ia/propuestas/${id}/descartar`, { method: "POST" })
}

export function improveText(storeId: string, text: string) {
  return api<{ text: string | null; unchanged: boolean; why: string | null }>(
    `/api/tiendas/${storeId}/ia/mejorar-texto`,
    { method: "POST", body: { text } },
  )
}

/**
 * Lo de la ficha: mirar las fotos, usar, descartar y «Aplicar todos». Cada uso devuelve la ficha
 * como quedó, que reemplaza la de la pantalla (y su borrador, que ya se guardó antes).
 */
export function useFichaProposals(
  storeId: string,
  productId: string,
  options: { beforeUse: () => Promise<void>; onSheet: (sheet: Sheet) => void },
) {
  const queryClient = useQueryClient()
  const key = PROPOSALS_KEY(storeId, productId)
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: key })
    void queryClient.invalidateQueries({ queryKey: ["ia-tope", storeId] })
    void queryClient.invalidateQueries({ queryKey: ["historial", storeId, productId] })
  }
  const look = useMutation({
    mutationFn: () =>
      api<ProductProposals>(`/api/tiendas/${storeId}/productos/${productId}/ia`, {
        method: "POST",
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(key, data)
      void queryClient.invalidateQueries({ queryKey: ["ia-tope", storeId] })
      const n = data.proposals.length
      toast.success(
        n ? `La IA propone ${n} ${n === 1 ? "cosa" : "cosas"}` : "La IA no tiene nada que proponer",
      )
    },
    onError: (error) => {
      refresh()
      toast.error(error.message)
    },
  })
  const use = useMutation({
    mutationFn: async ({ id, value }: { id: string; value?: unknown }) => {
      await options.beforeUse()
      return api<{ result: Sheet }>(`/api/tiendas/${storeId}/ia/propuestas/${id}/usar`, {
        method: "POST",
        body: value === undefined ? {} : { value },
      })
    },
    onSuccess: ({ result }) => {
      options.onSheet(result)
      refresh()
    },
    onError: (error) => {
      refresh()
      toast.error(error.message)
    },
  })
  const discard = useMutation({
    mutationFn: (id: string) => discardProposal(storeId, id),
    onSuccess: refresh,
    onError: (error) => {
      refresh()
      toast.error(error.message)
    },
  })
  const all = useMutation({
    mutationFn: async () => {
      await options.beforeUse()
      return api<{
        applied: number
        skipped: { id: string; field: string; message: string }[]
        product: Sheet
      }>(`/api/tiendas/${storeId}/productos/${productId}/ia/aplicar-todos`, { method: "POST" })
    },
    onSuccess: (data) => {
      options.onSheet(data.product)
      refresh()
      if (data.skipped.length)
        toast.warning(
          `Usé ${data.applied}. ${data.skipped.length === 1 ? "Una no se pudo" : `${data.skipped.length} no se pudieron`}: ${data.skipped[0]!.message}`,
        )
      else toast.success(data.applied === 1 ? "Usé 1 propuesta" : `Usé ${data.applied} propuestas`)
    },
    onError: (error) => {
      refresh()
      toast.error(error.message)
    },
  })
  return { look, use, discard, all }
}
