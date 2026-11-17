/**
 * Lo que cae con una anulación (QA del 16 nov, E2): lo que nació junto se corrige junto. Al
 * anular el hallazgo, su diagnóstico de esta atención y lo indicado hoy desde él vienen
 * marcados; al anular el diagnóstico, su hallazgo. Lo que sigue dice por qué, y lo que ya no se
 * deshace (el consentimiento firmado, lo hecho hoy) se avisa sin frenar. Lo calcula el
 * servidor (`getCorrectionPreview`); aquí solo se marca.
 */
import { Checkbox, Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@odentia/ui"
import { ErrorState, LoadingState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { ApiError } from "../../lib/api"
import {
  type CorrectionChoice,
  type CorrectionPreview,
  type CorrectionStart,
  fetchCorrectionPreview,
} from "../../lib/encounters"

/** Lo marcado de una vista previa, listo para enviar. */
export interface CorrectionMarks {
  findingIds: string[]
  diagnosisIds: string[]
  planItemIds: string[]
}

const NONE: CorrectionMarks = { findingIds: [], diagnosisIds: [], planItemIds: [] }

/** Todo lo marcable viene marcado: lo común es que lo nacido junto también estaba mal. */
function marked(preview: CorrectionPreview | undefined): CorrectionMarks {
  if (!preview) return NONE
  const ids = (choices: CorrectionChoice[]) => choices.filter((choice) => choice.offered).flatMap((choice) => choice.ids)
  return { findingIds: ids(preview.findings), diagnosisIds: ids(preview.diagnoses), planItemIds: ids(preview.planItems) }
}

/** Se quiso confirmar sin saber qué cae: no se anula a medias (QA del 16 nov, Q2). */
export const CORRECTION_NOT_READY =
  "Todavía no se sabe qué más cae con esta anulación. Espera a que cargue o reinténtalo: no se anuló nada."

/**
 * La vista previa de lo que cae y lo marcado. `start` nulo: cerrado, no pide nada.
 *
 * Mientras la lista no llegó (`ready` falso) no se confirma: con la red lenta se anulaba solo el
 * hallazgo y su diagnóstico seguía «Definitivo» para firmarse (QA del 16 nov, Q2). Tampoco se pinta
 * la lista de la vez anterior mientras llega la nueva, y si la vista previa falla se dice y se
 * reintenta: nunca se anula «solo lo pedido» sin haberlo elegido.
 */
export function useCorrection(
  patientId: string,
  encounterId: string,
  start: CorrectionStart | null,
  /** Mientras se guarda la anulación, la lista no se vuelve a pedir: ya se decidió con ella. */
  saving = false,
) {
  const preview = useQuery({
    queryKey: ["encounter-correction", patientId, encounterId, start],
    queryFn: () => fetchCorrectionPreview(patientId, encounterId, start!),
    enabled: start !== null && !saving,
    staleTime: 0,
    retry: false,
  })
  const open = start !== null
  const loading = open && preview.isFetching
  const failed = open && !preview.isFetching && preview.isError
  const data = open && !loading && !failed ? preview.data?.data : undefined
  // Lo marcado vale para la lista con que se marcó: con otra lista, todo lo marcable otra vez.
  const [chosen, setChosen] = useState<{ of: CorrectionPreview; marks: CorrectionMarks } | null>(null)
  const marks = data && chosen?.of === data ? chosen.marks : marked(data)
  return {
    preview: data,
    loading,
    failed,
    error: failed && preview.error instanceof ApiError ? preview.error.shape : null,
    /** La lista de lo que cae ya llegó: solo entonces se puede confirmar. */
    ready: data !== undefined,
    retry: () => void preview.refetch(),
    marks,
    setMarks: (next: CorrectionMarks) => {
      if (data) setChosen({ of: data, marks: next })
    },
  }
}

const WORDS: Record<keyof CorrectionMarks, string> = {
  findingIds: "También anular su hallazgo",
  diagnosisIds: "También anular su diagnóstico de esta atención",
  planItemIds: "Y el tratamiento indicado hoy",
}

/**
 * Las casillas de lo que cae con la anulación, y lo que no se deshace. Sin nada, no muestra nada.
 * Mientras se busca, lo dice; si no se pudo saber, lo dice con «Reintentar».
 */
export function CorrectionChoices({
  preview,
  marks,
  onMarksChange,
  disabled,
  idPrefix,
  loading = false,
  failed = false,
  error = null,
  onRetry,
}: {
  preview: CorrectionPreview | undefined
  marks: CorrectionMarks
  onMarksChange: (marks: CorrectionMarks) => void
  disabled?: boolean
  idPrefix: string
  loading?: boolean
  failed?: boolean
  error?: ApiError["shape"] | null
  onRetry?: () => void
}): React.JSX.Element | null {
  if (loading) return <LoadingState message="Buscando qué más cae con esta anulación…" />
  if (failed)
    return (
      <ErrorState
        title="No se pudo saber qué más cae con esta anulación"
        message={`${error?.message ? `${error.message} ` : ""}No se anuló nada.`}
        onRetry={onRetry}
        className="py-4"
      />
    )
  if (!preview) return null
  const groups: Array<[keyof CorrectionMarks, CorrectionChoice[]]> = [
    ["findingIds", preview.findings],
    ["diagnosisIds", preview.diagnoses],
    ["planItemIds", preview.planItems],
  ]
  const any = groups.some(([, choices]) => choices.length > 0) || preview.notices.length > 0
  if (!any) return null
  const toggle = (key: keyof CorrectionMarks, ids: string[], on: boolean) =>
    onMarksChange({
      ...marks,
      [key]: on ? [...new Set([...marks[key], ...ids])] : marks[key].filter((id) => !ids.includes(id)),
    })
  return (
    <FieldSet className="gap-2">
      <FieldLegend variant="label" className="mb-0">
        Lo que nació con {preview.target.kind === "finding" ? "el hallazgo" : "el diagnóstico"}
      </FieldLegend>
      <FieldGroup className="gap-2">
        {groups.flatMap(([key, choices]) =>
          choices.map((choice, index) =>
            choice.offered ? (
              <Field key={choice.ids.join(",")} orientation="horizontal">
                <Checkbox
                  id={`${idPrefix}-${key}-${index}`}
                  checked={choice.ids.every((id) => marks[key].includes(id))}
                  disabled={disabled}
                  onCheckedChange={(checked) => toggle(key, choice.ids, checked === true)}
                />
                <FieldLabel htmlFor={`${idPrefix}-${key}-${index}`} className="font-normal">
                  <span>
                    {WORDS[key]}: {choice.label}
                  </span>
                </FieldLabel>
              </Field>
            ) : (
              <p key={choice.ids.join(",")} className="text-sm text-muted-foreground">
                {choice.label} · {choice.note}
              </p>
            ),
          ),
        )}
      </FieldGroup>
      {preview.notices.length > 0 ? (
        <ul role="status" className="flex flex-col gap-1 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
          {preview.notices.map((notice) => (
            <li key={notice}>{notice}</li>
          ))}
        </ul>
      ) : null}
    </FieldSet>
  )
}
