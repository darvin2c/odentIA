import { Button } from "@odentia/ui"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { X } from "lucide-react"
import { useId, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { formatDateTime } from "../../lib/clinical-journey"
import { useMyUserId } from "../../lib/crm"
import { activeOrgLocale } from "../../lib/locale"
import { formatMeasure } from "./tomography-slice"

/**
 * Medidas guardadas de una tomografía (decisión 3 del lienzo, ADR 0056): cada
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
  /** La serie donde se marcó; null: la serie mayor (las de antes de poder elegirla). */
  seriesInstanceUid?: string | null
  createdAt: string
  /** Quien la guardó (sin guardar: null). */
  createdBy?: string | null
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

/**
 * `series`: la serie que se ve y la mayor del estudio. Cada serie tiene su volumen y sus mm
 * cuentan desde su primer corte: solo se muestran las medidas de la que se ve, y una medida
 * nueva queda con ella.
 */
export function useSavedMeasures(
  patientId: string,
  documentId: string,
  canWrite: boolean,
  series: { shown: string; main: string } | null = null,
) {
  const queryClient = useQueryClient()
  const myUserId = useMyUserId()
  const key = ["imaging-measurements", patientId, documentId]
  const saved = useQuery({
    queryKey: key,
    queryFn: () =>
      apiFetch<{ data: SavedMeasure[] }>(`/api/patients/${patientId}/imaging/studies/${documentId}/measurements`),
  })
  const [local, setLocal] = useState<SavedMeasure[]>([])
  const [error, setError] = useState<string | null>(null)
  /** Guarda la medida; true si quedó guardada. */
  const keep = async (input: NewMeasure): Promise<boolean> => {
    // En la serie mayor no se manda la serie: el servidor la pone (las de antes ya la tienen), y una
    // API anterior aceptaría la medida igual.
    const measure: NewMeasure = { ...input, seriesInstanceUid: series && series.shown !== series.main ? series.shown : null }
    if (!canWrite) {
      setLocal((prev) => [
        ...prev,
        { ...measure, id: crypto.randomUUID(), createdAt: new Date().toISOString(), createdByName: null },
      ])
      return true
    }
    try {
      setError(null)
      await apiFetch(`/api/patients/${patientId}/imaging/studies/${documentId}/measurements`, {
        method: "POST",
        body: JSON.stringify(measure),
      })
      await queryClient.invalidateQueries({ queryKey: key })
      return true
    } catch (e) {
      setError(e instanceof ApiError ? (e.shape.message ?? "No se pudo guardar la medida.") : "No se pudo guardar la medida.")
      return false
    }
  }
  // La última quitada, para «Deshacer» ahí mismo: el visor es un diálogo y un aviso de fuera no se alcanza.
  const [removed, setRemoved] = useState<SavedMeasure | null>(null)
  const retire = async (id: string) => {
    const measure = [...(saved.data?.data ?? []), ...local].find((m) => m.id === id) ?? null
    if (local.some((m) => m.id === id)) {
      setLocal((prev) => prev.filter((m) => m.id !== id))
      setRemoved(measure)
      return
    }
    try {
      setError(null)
      await apiFetch(`/api/patients/${patientId}/imaging/studies/${documentId}/measurements/${id}/retire`, {
        method: "POST",
        body: "{}",
      })
      await queryClient.invalidateQueries({ queryKey: key })
      setRemoved(measure)
    } catch {
      setError("No se pudo quitar la medida.")
    }
  }
  /**
   * La vuelve a guardar igual; la quitada queda en el registro con quién y cuándo.
   * Solo la propia (o una sin guardar): la de un colega volvería con otro autor.
   */
  const undo = async () => {
    if (!removed) return
    const { kind, view, points, value, toothNumber } = removed
    if (await keep({ kind, view, points, value, toothNumber })) setRemoved(null)
  }
  const canUndo = (measure: SavedMeasure) => !measure.createdBy || measure.createdBy === myUserId
  const inShown = (m: SavedMeasure) => !series || (m.seriesInstanceUid ?? series.main) === series.shown
  return {
    measures: [...(saved.data?.data ?? []), ...local].filter(inShown),
    keep,
    retire,
    error,
    removed,
    canUndoRemoved: removed ? canUndo(removed) : false,
    undo,
    dismissRemoved: () => setRemoved(null),
  }
}

export type SavedMeasures = ReturnType<typeof useSavedMeasures>

/** La lista de la columna derecha: qué, dónde, cuánto y quién. */
export function MeasureList({
  saved,
  canWrite,
  viewOnly,
  note,
}: {
  saved: SavedMeasures
  canWrite: boolean
  viewOnly: boolean
  /** Lo orientativo de las medidas, una sola vez, debajo de la lista. */
  note: string
}) {
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2">
      <h3 id={titleId} className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
        Medidas
      </h3>
      {saved.measures.length === 0 ? (
        <p className="text-slate-400">
          {viewOnly
            ? "Sin medidas. Para medir, abre la tomografía en una computadora o una tablet."
            : canWrite
              ? "Sin medidas todavía. «Medir» marca dos puntos y «Ángulo», tres; quedan guardadas con tu nombre."
              : "Sin medidas todavía. «Medir» marca dos puntos y «Ángulo», tres."}
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
                      aria-label={`Quitar ${m.kind === "angulo" ? "el ángulo" : "la distancia"} de ${formatMeasure(m)}`}
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
      {saved.removed && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs text-slate-300">
          <span role="status" className="min-w-0 flex-1">
            Quitaste {saved.removed.kind === "angulo" ? "el ángulo" : "la distancia"} de {formatMeasure(saved.removed)}
            {saved.removed.createdByName && !saved.canUndoRemoved ? ` de ${saved.removed.createdByName}` : ""}.
          </span>
          {saved.canUndoRemoved && (
            // El foco pasa aquí al quitar: la «X» ya no existe.
            <Button type="button" size="sm" variant="outline" autoFocus onClick={() => void saved.undo()}>
              Deshacer
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={saved.dismissRemoved}>
            Listo
          </Button>
        </div>
      )}
      {saved.error && (
        <p role="alert" className="text-xs text-red-300">
          {saved.error}
        </p>
      )}
      <p className="text-xs text-slate-400">{note}</p>
    </section>
  )
}

/**
 * Lo que dice junto a las medidas de la tomografía médica (ADR 0154): el visor sirve para
 * ver el estudio junto a su informe, no para diagnosticar.
 */
export const CT_MEASURE_NOTE =
  "Visor de consulta: medidas orientativas con la escala del archivo. El diagnóstico es el informe del radiólogo."

/** Lo que dice junto a cada medida (decisión 9). */
export const MEASURE_NOTE = (voxelMm: number | null) =>
  `Medidas orientativas${voxelMm ? `, con el tamaño de vóxel del archivo (${voxelMm.toLocaleString(activeOrgLocale(), { maximumFractionDigits: 2 })} mm)` : ""}. Para planificar una cirugía, confírmalas en el programa del tomógrafo.`
