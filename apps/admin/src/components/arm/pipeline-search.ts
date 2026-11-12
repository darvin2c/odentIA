import { type ClinicalProduct, isClinicalProduct } from "@odentia/clinical"
import { CLIENT_ORIGINS, type ClientOrigin } from "./sale-words"

/**
 * Lo que el Embudo lee de la dirección (`/pipeline`): producto, responsable,
 * origen y la vista. Cada clave va siempre, con `undefined` si su valor no
 * sirve (la trampa de `lib/list-search.ts`: el router junta la búsqueda cruda
 * con la de la ruta y una clave omitida dejaría pasar «?origen=xyz» a la API).
 */
export interface PipelineSearch {
  producto: ClinicalProduct | undefined
  /** «mio», «sin» o el id de una persona del equipo. */
  responsable: string | undefined
  origen: ClientOrigin | undefined
  /** Sin vista: el tablero. */
  vista: "lista" | undefined
}

const OWNER = /^[A-Za-z0-9_-]{1,120}$/

export function pipelineSearchOf(search: Record<string, unknown>): PipelineSearch {
  const owner = typeof search.responsable === "string" ? search.responsable : undefined
  return {
    producto: isClinicalProduct(search.producto) ? search.producto : undefined,
    responsable: owner && OWNER.test(owner) ? owner : undefined,
    origen:
      typeof search.origen === "string" &&
      (CLIENT_ORIGINS as readonly string[]).includes(search.origen)
        ? (search.origen as ClientOrigin)
        : undefined,
    vista: search.vista === "lista" ? "lista" : undefined,
  }
}

/** Lo que va a la API: el producto se filtra en la pantalla para poder contar cuántas hay de cada uno. */
export function pipelineQueryOf(search: PipelineSearch): string {
  const params = new URLSearchParams()
  if (search.responsable) params.set("owner", search.responsable)
  if (search.origen) params.set("origin", search.origen)
  const query = params.toString()
  return `/api/admin/clients/pipeline${query ? `?${query}` : ""}`
}
