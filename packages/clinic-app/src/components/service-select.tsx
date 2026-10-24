import { Button } from "@odentia/ui"
import { ResourceSelect } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { useDeferredValue, useState } from "react"
import { fetchService, fetchServices, type ServiceCatalogItem } from "../lib/services"

/** Cuántos servicios trae cada búsqueda: el resto se encuentra escribiendo. */
export const SERVICE_SEARCH_LIMIT = 30

/**
 * Elegir un servicio del tarifario buscando en el servidor (topes B1–B4 de la
 * fase 4): nunca una lista cargada con un tope mudo. Lo que llega elegido se
 * muestra aunque no esté en la primera página, y si hay más de los que se
 * ven, se dice cuántos son.
 */
export function ServiceSelect({
  id,
  label,
  value,
  onChange,
  excludeId,
  noneLabel,
}: {
  id: string
  label: string
  /** Id del servicio elegido; vacío = ninguno. */
  value: string
  onChange: (service: ServiceCatalogItem | null) => void
  /** Un servicio que no se ofrece (p. ej. el propio, al elegir su evaluación). */
  excludeId?: string | null
  /** Con esto, la primera opción es «ninguno», con este texto. */
  noneLabel?: string
}) {
  const [query, setQuery] = useState("")
  const q = useDeferredValue(query.trim())
  const pageQuery = useQuery({
    queryKey: ["services", "select", q],
    queryFn: () => fetchServices({ q: q || undefined, state: "active", limit: SERVICE_SEARCH_LIMIT }),
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  })
  const page = pageQuery.data
  const inPage = Boolean(value) && (page?.data ?? []).some((item) => item.id === value)
  // El elegido que no llegó en la búsqueda (más allá de la primera página, o inactivo) se pide por id.
  const chosenQuery = useQuery({
    queryKey: ["services", "one", value],
    queryFn: () => fetchService(value),
    enabled: Boolean(value) && !inPage,
    staleTime: 60_000,
  })
  const services = [...(page?.data ?? [])]
  const chosen = chosenQuery.data?.data
  if (chosen && !services.some((item) => item.id === chosen.id)) services.unshift(chosen)
  const shown = services.filter((item) => item.id !== excludeId)
  const options = [
    ...(noneLabel ? [{ id: "", label: noneLabel }] : []),
    ...shown.map((item) => ({
      id: item.id,
      label: item.name,
      detail:
        [item.specialtyName, item.durationMin ? `${item.durationMin} min` : null, item.isActive ? null : "inactivo"]
          .filter(Boolean)
          .join(" · ") || undefined,
    })),
  ]
  const total = page?.total ?? 0
  const more = total > (page?.data.length ?? 0)
  return (
    <div className="grid gap-1.5">
      <ResourceSelect
        id={id}
        label={label}
        options={options}
        value={value}
        onChange={(next) => onChange(next ? (services.find((item) => item.id === next) ?? null) : null)}
        onQueryChange={setQuery}
        empty={
          pageQuery.isPending
            ? "Buscando servicios…"
            : q
              ? `Ningún servicio activo coincide con «${q}».`
              : "Aún no hay servicios activos."
        }
      />
      {pageQuery.isError && !page ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          No se pudieron cargar los servicios.
          <Button type="button" size="sm" variant="outline" onClick={() => void pageQuery.refetch()}>
            Reintentar
          </Button>
        </p>
      ) : more ? (
        <p className="text-xs text-muted-foreground">
          {q
            ? `${total} coinciden: se ven ${page?.data.length}. Escribe más para acotar.`
            : `La clínica tiene ${total} servicios: escribe para encontrar el que buscas.`}
        </p>
      ) : null}
    </div>
  )
}
