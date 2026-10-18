import { Button } from "@odentia/ui"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { X } from "lucide-react"
import { useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { formatDateTime } from "../../lib/clinical-journey"
import { activeOrgLocale } from "../../lib/locale"
import { formatMeasure } from "./tomography-slice"

/**
 * Medidas guardadas de una tomografía (decisión 3 del lienzo, ADR 0055): cada
 * medida queda con quién y cuándo, sin tocar el archivo; quitarla la retira.
 * Quien no escribe en la ficha mide igual, pero su medida no se guarda.
 */

export type Vec3 = [number, number, number]

export interface SavedMeasure {
  id: string
  kind: "distancia" | "angulo"
  view: string
  /** Puntos en mm dentro del volumen. */
  points: Vec3[]
  value: number
  toothNumber: number | null
  createdAt: string
  createdByName: string | null
}

export type NewMeasure = Omit<SavedMeasure, "id" | "createdAt" | "createdByName">

export const VIEW_WORDS: Record<string, string> = {
  panoramica: "panorámica",
  transversal: "corte transversal",
  axial: "desde arriba",
  coronal: "de frente",
  sagital: "de lado",
}

export function useSavedMeasures(patientId: string, documentId: string, canWrite: boolean) {
  const queryClient = useQueryClient()
  const key = ["imaging-measurements", patientId, documentId]
  const saved = useQuery({
    queryKey: key,
    queryFn: () =>
      apiFetch<{ data: SavedMeasure[] }>(`/api/patients/${patientId}/imaging/studies/${documentId}/measurements`),
  })
  const [local, setLocal] = useState<SavedMeasure[]>([])
  const [error, setError] = useState<string | null>(null)
  const keep = async (measure: NewMeasure) => {
    if (!canWrite) {
      setLocal((prev) => [
        ...prev,
        { ...measure, id: crypto.randomUUID(), createdAt: new Date().toISOString(), createdByName: null },
      ])
      return
    }
    try {
      setError(null)
      await apiFetch(`/api/patients/${patientId}/imaging/studies/${documentId}/measurements`, {
        method: "POST",
        body: JSON.stringify(measure),
      })
      await queryClient.invalidateQueries({ queryKey: key })
    } catch (e) {
      setError(e instanceof ApiError ? (e.shape.message ?? "No se pudo guardar la medida.") : "No se pudo guardar la medida.")
    }
  }
  const retire = async (id: string) => {
    if (local.some((m) => m.id === id)) {
      setLocal((prev) => prev.filter((m) => m.id !== id))
      return
    }
    try {
      setError(null)
      await apiFetch(`/api/patients/${patientId}/imaging/studies/${documentId}/measurements/${id}/retire`, {
        method: "POST",
        body: "{}",
      })
      await queryClient.invalidateQueries({ queryKey: key })
    } catch {
      setError("No se pudo quitar la medida.")
    }
  }
  return { measures: [...(saved.data?.data ?? []), ...local], keep, retire, error }
}

export type SavedMeasures = ReturnType<typeof useSavedMeasures>

/** La lista de la columna derecha: qué, dónde, cuánto y quién. */
export function MeasureList({
  saved,
  canWrite,
  viewOnly,
}: {
  saved: SavedMeasures
  canWrite: boolean
  viewOnly: boolean
}) {
  return (
    <>
      <h3 className="text-xs font-semibold tracking-wide text-slate-400 uppercase">Medidas guardadas</h3>
      {saved.measures.length === 0 ? (
        <p className="text-slate-400">
          {viewOnly
            ? "Para medir, abre la tomografía en una computadora o una tablet."
            : canWrite
              ? "Elige «Medir» y marca dos puntos, o «Ángulo» y marca tres; queda guardada con tu nombre."
              : "Elige «Medir» y marca dos puntos, o «Ángulo» y marca tres."}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {saved.measures.map((m) => (
            <li key={m.id} className="flex flex-col gap-0.5 rounded-lg bg-slate-900 px-2.5 py-1.5">
              <span className="flex items-center justify-between gap-2">
                <span className="text-slate-300">
                  {m.kind === "angulo" ? "Ángulo" : "Distancia"} · {VIEW_WORDS[m.view] ?? m.view}
                  {m.toothNumber ? ` · ${m.toothNumber}` : ""}
                </span>
                <span className="flex items-center gap-1">
                  <b className="text-amber-400 tabular-nums">{formatMeasure(m)}</b>
                  {!viewOnly && (canWrite || !m.createdByName) && (
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Quitar la medida"
                      onClick={() => void saved.retire(m.id)}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  )}
                </span>
              </span>
              <span className="text-xs text-slate-500">
                {m.createdByName ? `${m.createdByName} · ${formatDateTime(m.createdAt)}` : "Sin guardar"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {saved.error && (
        <p role="alert" className="text-xs text-red-300">
          {saved.error}
        </p>
      )}
    </>
  )
}

/** Lo que dice junto a cada medida (decisión 9). */
export const MEASURE_NOTE = (voxelMm: number | null) =>
  `Medidas orientativas${voxelMm ? `, con el tamaño de vóxel del archivo (${voxelMm.toLocaleString(activeOrgLocale(), { maximumFractionDigits: 2 })} mm)` : ""}. Para planificar una cirugía, confírmalas en el programa del equipo.`
