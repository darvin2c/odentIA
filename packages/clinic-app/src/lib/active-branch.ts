/**
 * Sede activa de las pantallas que trabajan por sede (Agenda, Horarios y
 * bloqueos). Una sola regla para todas: manda la sede del enlace (`?branch=`);
 * si no la hay, la última que eligió **esta persona** (en un mostrador
 * compartido, quien entra no hereda la sede de quien estuvo antes); y si
 * tampoco, la que hoy tiene más citas, como Inicio.
 */
import { useListSearch } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import * as React from "react"
import { apiFetch } from "./api"

/** Cada organización vive en su propio origen: la clave lleva solo a la persona. */
const STORAGE_PREFIX = "odentia:sede-activa"
let storageKey = STORAGE_PREFIX

/** La sede recordada es de quien entró: se fija al saber quién es. */
export function setActiveBranchOwner(userId: string | null | undefined): void {
  storageKey = userId ? `${STORAGE_PREFIX}:${userId}` : STORAGE_PREFIX
  for (const listener of listeners) listener()
}

export interface BranchOption {
  id: string
  name: string
}

function readStored(): string | undefined {
  try {
    return localStorage.getItem(storageKey) ?? undefined
  } catch {
    return undefined
  }
}

const listeners = new Set<() => void>()

function writeStored(id: string | undefined): void {
  try {
    if (id === undefined) localStorage.removeItem(storageKey)
    else localStorage.setItem(storageKey, id)
  } catch {
    // Sin almacenamiento (modo privado): la sede sigue en el enlace.
  }
  for (const listener of listeners) listener()
}

/**
 * Lo guardado cambia en esta pestaña. Lo que se elige en otra no cambia la
 * sede de esta a mitad de un cobro: vale al volver a abrirla.
 */
function subscribeStored(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
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

/**
 * Sin una sede elegida: la que hoy tiene más citas y, con empate (o sin citas),
 * la primera activa. La misma regla que Inicio en el servidor (`homeBranch`).
 */
export function preferredBranchId(
  rows: ReadonlyArray<{ id: string; isActive: boolean; createdAt: string; todayAppointments?: number }>,
): string | undefined {
  const first = firstActiveBranchId(rows)
  const busiest = rows
    .filter((item) => item.isActive && (item.todayAppointments ?? 0) > 0)
    .sort(
      (a, b) =>
        (b.todayAppointments ?? 0) - (a.todayAppointments ?? 0) ||
        a.createdAt.localeCompare(b.createdAt) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )[0]
  return busiest?.id ?? first
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
      apiFetch<{ data: Array<{ id: string; name: string; isActive: boolean; createdAt: string; todayAppointments?: number }> }>(
        "/api/branches",
      ),
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
  const firstActive = React.useMemo(() => preferredBranchId(query.data?.data ?? []), [query.data])
  return { branches, branchId, effectiveId: branchId ?? firstActive, choose }
}
