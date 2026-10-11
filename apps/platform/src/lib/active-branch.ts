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

function writeStored(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // Sin almacenamiento (modo privado): la sede sigue en el enlace.
  }
}

export function useActiveBranch(): {
  /** Sedes activas de la organización. */
  branches: BranchOption[]
  /** Sede pedida; `undefined` deja que el servidor elija la primera activa. */
  branchId: string | undefined
  /** `false` mientras no se sabe si la sede recordada sigue existiendo. */
  ready: boolean
  /** Cambia de sede, la recuerda y la deja en el enlace. */
  choose: (id: string, extra?: Record<string, string | undefined>) => void
} {
  const { get, setParams } = useListSearch()
  const query = useQuery({
    queryKey: ["branches", "activas"],
    queryFn: () =>
      apiFetch<{ data: Array<{ id: string; name: string; isActive: boolean }> }>("/api/branches"),
    staleTime: 60_000,
  })
  const branches = React.useMemo(
    () =>
      (query.data?.data ?? [])
        .filter((item) => item.isActive)
        .map(({ id, name }) => ({ id, name })),
    [query.data],
  )
  const fromLink = get("branch")
  const [stored, setStored] = React.useState(readStored)

  // La sede a la que lleva un enlace pasa a ser la recordada.
  React.useEffect(() => {
    if (!fromLink || fromLink === stored) return
    writeStored(fromLink)
    setStored(fromLink)
  }, [fromLink, stored])

  // Una sede recordada que ya no existe no debe romper la pantalla.
  const known = (id: string) => branches.some((item) => item.id === id)
  const branchId = fromLink ?? (stored && query.isSuccess && known(stored) ? stored : undefined)
  const ready = fromLink !== undefined || stored === undefined || !query.isPending

  const choose = React.useCallback(
    (id: string, extra?: Record<string, string | undefined>) => {
      writeStored(id)
      setStored(id)
      setParams({ ...extra, branch: id })
    },
    [setParams],
  )
  return { branches, branchId, ready, choose }
}
