/**
 * Sede activa de las pantallas que trabajan por sede (Agenda, Horarios y
 * bloqueos). Una sola regla para todas: manda la sede del enlace (`?branch=`);
 * si no la hay, la última que la persona eligió en este navegador; y si
 * tampoco, la primera activa, que resuelve el servidor.
 */
import { useListSearch } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import * as React from "react"
import { apiFetch } from "./api"

/** Cada organización vive en su propio origen: la clave no necesita su nombre. */
const STORAGE_KEY = "odentia:sede-activa"

export interface BranchOption {
  id: string
  name: string
}

function readStored(): string | undefined {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? undefined
  } catch {
    return undefined
  }
}

const listeners = new Set<() => void>()

function writeStored(id: string | undefined): void {
  try {
    if (id === undefined) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // Sin almacenamiento (modo privado): la sede sigue en el enlace.
  }
  for (const listener of listeners) listener()
}

/** Lo guardado cambia aquí o en otra pestaña. */
function subscribeStored(listener: () => void): () => void {
  listeners.add(listener)
  window.addEventListener("storage", listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", listener)
  }
}

/**
 * La primera sede activa: la más antigua y, con el mismo instante, la de menor id,
 * el mismo orden `created_at, id` del servidor (`workspace.ts`). Sin ese desempate,
 * la ficha y el inicio elegían sedes distintas al crearse en el mismo instante (QA NT).
 */
export function firstActiveBranchId(
  rows: ReadonlyArray<{ id: string; isActive: boolean; createdAt: string }>,
): string | undefined {
  return rows
    .filter((item) => item.isActive)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]?.id
}

export function useActiveBranch(): {
  /** Sedes activas de la organización. */
  branches: BranchOption[]
  /** Sede pedida; `undefined` deja que el servidor elija la primera activa. */
  branchId: string | undefined
  /**
   * La sede con la que se trabaja aunque nadie la haya elegido: la pedida o, si
   * no, la primera activa, la misma que muestra la Agenda. Cobrar y atender la
   * usan sin volver a preguntar; solo es `undefined` mientras llega la lista.
   */
  effectiveId: string | undefined
  /** Cambia de sede, la recuerda y la deja en el enlace. */
  choose: (id: string, extra?: Record<string, string | undefined>) => void
} {
  const { get, setParams } = useListSearch()
  const query = useQuery({
    queryKey: ["branches", "activas"],
    queryFn: () =>
      apiFetch<{ data: Array<{ id: string; name: string; isActive: boolean; createdAt: string }> }>("/api/branches"),
    staleTime: 60_000,
  })
  const branches = React.useMemo(
    () =>
      (query.data?.data ?? [])
        .filter((item) => item.isActive)
        .map(({ id, name }) => ({ id, name })),
    [query.data],
  )
  // `?branch=` vacío es «sin sede elegida», no una sede.
  const fromLink = get("branch") || undefined
  // En el servidor y al hidratar no hay nada guardado: el primer pintado es el
  // mismo en los dos (#418), y enseguida se usa la recordada.
  const stored = React.useSyncExternalStore(subscribeStored, readStored, () => undefined)

  // La sede a la que lleva un enlace pasa a ser la recordada.
  React.useEffect(() => {
    if (!fromLink || fromLink === stored) return
    writeStored(fromLink)
  }, [fromLink, stored])

  // La sede recordada se usa enseguida, sin esperar la lista: la pantalla pide
  // sus datos a la vez que las sedes, no después. Si al llegar la lista ya no
  // existe, se deja de pedir y el servidor elige la primera activa.
  const known = (id: string) => branches.some((item) => item.id === id)
  const branchId = fromLink ?? (stored && (!query.isSuccess || known(stored)) ? stored : undefined)
  // Con `?branch=` manda el enlace (y vuelve a anotarse): no se olvida nada.
  const forgotten = !fromLink && query.isSuccess && stored !== undefined && !known(stored)
  // Una sede que ya no existe se olvida: el próximo ingreso no la vuelve a pedir.
  React.useEffect(() => {
    if (!forgotten) return
    writeStored(undefined)
  }, [forgotten])

  const choose = React.useCallback(
    (id: string, extra?: Record<string, string | undefined>) => {
      writeStored(id)
      setParams({ ...extra, branch: id })
    },
    [setParams],
  )
  const firstActive = React.useMemo(() => firstActiveBranchId(query.data?.data ?? []), [query.data])
  return { branches, branchId, effectiveId: branchId ?? firstActive, choose }
}
