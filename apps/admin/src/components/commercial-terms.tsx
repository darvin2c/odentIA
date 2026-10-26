/**
 * Facturación › Condiciones comerciales (issue 167, ADR 0074): las reglas que
 * acompañan al precio, en frases, con «Cambiar» por grupo y «Ver cambios».
 * Frases, campos, límites y desde cuándo rige cada cambio los entrega el
 * servidor; el servidor comprueba lo mismo al guardar.
 */
import { Button, FieldLabel, Input, Skeleton, Textarea, toast } from "@odentia/ui"
import { DetailDrawer, ErrorState, FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Fragment, useState } from "react"
import { ApiError, api } from "../lib/api"

interface TermField {
  key: string
  name: string
  label: string
  unit: string
  min: number
  max: number
  hint: string
  since: string
  sameRow?: boolean
}

interface TermsPart {
  text: string
  strong?: boolean
}

interface TermsGroup {
  key: string
  title: string
  sentences: TermsPart[][]
  fields: TermField[]
}

interface TermsView {
  version: {
    id: string | null
    effectiveFrom: string | null
    createdByName: string | null
    reason: string | null
    initial: boolean
  }
  values: Record<string, number>
  groups: TermsGroup[]
}

interface TermsVersion {
  id: string
  effectiveFrom: string
  createdByName: string | null
  reason: string | null
  initial: boolean
  changes: Array<{ key: string; name: string; before: string; after: string }>
  summary: Array<{ key: string; name: string; value: string }> | null
}

const TERMS_KEY = ["admin", "billing", "terms"] as const

const when = (iso: string) =>
  new Intl.DateTimeFormat("es-PE", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso))

function Sentence({ parts }: { parts: TermsPart[] }) {
  return (
    <li>
      {parts.map((part, index) =>
        part.strong ? (
          <strong key={index} className="font-semibold text-foreground tabular-nums">
            {part.text}
          </strong>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </li>
  )
}

export function CommercialTermsSection() {
  const terms = useQuery({
    queryKey: TERMS_KEY,
    queryFn: () => api<TermsView>("/api/admin/billing/terms"),
  })
  const [editing, setEditing] = useState<string | null>(null)
  const [history, setHistory] = useState(false)
  const group = terms.data?.groups.find((item) => item.key === editing) ?? null

  return (
    <section aria-labelledby="condiciones" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="condiciones" className="text-base font-semibold">
          Condiciones comerciales
        </h2>
        <Button size="sm" variant="outline" disabled={!terms.data} onClick={() => setHistory(true)}>
          Ver cambios
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Valen para todas las clínicas y todos los planes. Un cambio rige desde que lo guardas: lo
        que ya empezó conserva la regla que tenía. La web, el panel y los correos dicen lo que está
        aquí.
      </p>
      {terms.isPending ? (
        <div
          className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-2"
          aria-busy="true"
          aria-label="Cargando las condiciones"
        >
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="flex flex-col gap-2 rounded-lg border p-4">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-4/5" />
            </div>
          ))}
        </div>
      ) : terms.isError ? (
        <ErrorState
          title="No se pudieron cargar las condiciones"
          message={terms.error instanceof ApiError ? terms.error.shape.message : undefined}
          onRetry={() => void terms.refetch()}
        />
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-2">
            {terms.data.groups.map((item) => (
              <div key={item.key} className="flex flex-col gap-1.5 rounded-lg border p-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">{item.title}</h3>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEditing(item.key)}
                    aria-label={`Cambiar: ${item.title}`}
                  >
                    Cambiar
                  </Button>
                </div>
                <ul className="flex flex-col gap-1.5 text-sm text-muted-foreground">
                  {item.sentences.map((parts, index) => (
                    <Sentence key={index} parts={parts} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {terms.data.version.initial || !terms.data.version.effectiveFrom
              ? "Valores iniciales: los que estaban en el código."
              : `Último cambio: ${when(terms.data.version.effectiveFrom)} · ${terms.data.version.createdByName ?? "la administración"}.`}{" "}
            El peor costo de cada acción y el mínimo del doble no se cambian aquí: salen de medir la
            IA y los usa «Comprobación antes de guardar» de cada plan.
          </p>
        </>
      )}
      {group && terms.data ? (
        <TermsDrawer
          group={group}
          values={terms.data.values}
          basedOn={terms.data.version.id}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <TermsHistory open={history} onClose={() => setHistory(false)} />
    </section>
  )
}

/** Un número entero dentro de sus límites; si no, lo que hay que escribir. */
function fieldError(field: TermField, text: string): string | null {
  const value = Number(text.trim())
  if (!text.trim() || !Number.isInteger(value)) return "Escribe un número entero."
  if (value < field.min || value > field.max)
    return `Escribe un número entre ${field.min} y ${field.max}.`
  return null
}

function TermsDrawer({
  group,
  values,
  basedOn,
  onClose,
}: {
  group: TermsGroup
  values: Record<string, number>
  basedOn: string | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [texts, setTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(group.fields.map((field) => [field.key, String(values[field.key] ?? "")])),
  )
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [tried, setTried] = useState(false)

  const changed = group.fields.filter(
    (field) => texts[field.key]?.trim() !== String(values[field.key]),
  )
  const errors: Record<string, string> = {}
  for (const field of group.fields) {
    const message = fieldError(field, texts[field.key] ?? "")
    if (message) errors[field.key] = message
  }
  // El aviso va antes que la alarma (la misma regla que el servidor).
  if (
    !errors.warnPercent &&
    !errors.alarmPercent &&
    "warnPercent" in texts &&
    "alarmPercent" in texts
  ) {
    if (Number(texts.warnPercent) >= Number(texts.alarmPercent)) {
      errors.warnPercent = `El aviso va antes que la alarma: escribe menos de ${texts.alarmPercent} %.`
    }
  }

  const save = useMutation({
    mutationFn: () =>
      api<TermsView>("/api/admin/billing/terms", {
        method: "PUT",
        body: JSON.stringify({
          values: Object.fromEntries(changed.map((field) => [field.key, Number(texts[field.key])])),
          basedOn,
          reason: reason.trim() || null,
        }),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(TERMS_KEY, data)
      void queryClient.invalidateQueries({ queryKey: ["admin", "billing", "terms-history"] })
      toast.success("Condiciones guardadas")
      onClose()
    },
    onError: (e) => {
      setError(
        e instanceof ApiError ? (e.shape.message ?? "No se pudo guardar") : "No se pudo guardar",
      )
      // Si alguien guardó antes, se traen sus cifras: «antes» pasa a decir lo que rige ahora.
      if (e instanceof ApiError && e.status === 409)
        void queryClient.invalidateQueries({ queryKey: TERMS_KEY })
    },
  })

  // Cada fila: un campo, o dos que se leen juntos («3 días más, 1 vez por cargo»).
  const rows: TermField[][] = []
  for (const field of group.fields) {
    const last = rows[rows.length - 1]
    if (field.sameRow && last) last.push(field)
    else rows.push([field])
  }

  return (
    <FormDrawer
      open
      title={`Cambiar: ${group.title}`}
      description="Rige desde que guardas. Lo que ya empezó conserva la regla que tenía."
      submitLabel="Guardar"
      isDirty={changed.length > 0 || reason.trim() !== ""}
      isSubmitting={save.isPending}
      error={error}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault()
        setTried(true)
        setError(null)
        if (changed.length === 0) return onClose()
        if (Object.keys(errors).length > 0) return
        save.mutate()
      }}
    >
      <div className="flex flex-col gap-5">
        {rows.map((row) => {
          const [first] = row as [TermField, ...TermField[]]
          const rowChanged = row.filter((field) => changed.includes(field))
          const rowValid = row.every((field) => !errors[field.key])
          return (
            <div key={first.key} className="flex flex-col gap-1.5">
              <FieldLabel htmlFor={`term-${first.key}`}>{first.label}</FieldLabel>
              <div className="flex flex-wrap items-center gap-2">
                {row.map((field) => (
                  <Fragment key={field.key}>
                    <Input
                      id={`term-${field.key}`}
                      className="w-20 tabular-nums"
                      inputMode="numeric"
                      autoComplete="off"
                      aria-label={field === first ? undefined : field.label}
                      aria-invalid={
                        (tried || changed.includes(field)) && errors[field.key] ? true : undefined
                      }
                      aria-describedby={`term-${field.key}-hint`}
                      value={texts[field.key] ?? ""}
                      onChange={(event) =>
                        setTexts((prev) => ({ ...prev, [field.key]: event.target.value }))
                      }
                    />
                    <span className="text-sm text-muted-foreground">{field.unit}</span>
                  </Fragment>
                ))}
                {rowChanged.length ? (
                  <span className="text-xs font-semibold text-warning">
                    antes {rowChanged.map((field) => values[field.key]).join(" y ")}
                  </span>
                ) : null}
              </div>
              {row.map((field) =>
                (tried || changed.includes(field)) && errors[field.key] ? (
                  <p
                    key={field.key}
                    id={`term-${field.key}-hint`}
                    role="alert"
                    className="text-xs text-destructive"
                  >
                    {errors[field.key]}
                  </p>
                ) : (
                  <p
                    key={field.key}
                    id={`term-${field.key}-hint`}
                    className="text-xs text-muted-foreground"
                  >
                    {field.hint}
                  </p>
                ),
              )}
              {rowChanged.length && rowValid ? (
                <div className="flex flex-col gap-0.5 rounded-lg bg-primary/10 px-3 py-2 text-xs">
                  <span className="font-semibold">Desde cuándo rige</span>
                  <span>{first.since}</span>
                </div>
              ) : null}
            </div>
          )
        })}
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="term-reason">Por qué lo cambias (opcional)</FieldLabel>
          <Textarea
            id="term-reason"
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">Lo ve el equipo en «Ver cambios».</p>
        </div>
      </div>
    </FormDrawer>
  )
}

function TermsHistory({ open, onClose }: { open: boolean; onClose: () => void }) {
  const versions = useQuery({
    queryKey: ["admin", "billing", "terms-history"],
    queryFn: () => api<TermsVersion[]>("/api/admin/billing/terms/history"),
    enabled: open,
  })
  return (
    <DetailDrawer
      open={open}
      onClose={onClose}
      title="Cambios en las condiciones"
      description="Del más reciente al primero. No se borran."
      isLoading={versions.isPending}
      error={versions.isError ? "No se pudieron cargar los cambios" : null}
    >
      <ul className="flex flex-col divide-y">
        {(versions.data ?? []).map((version) => (
          <li key={version.id} className="flex flex-col gap-1 py-3 text-sm">
            {version.initial ? (
              <>
                <span className="text-xs text-muted-foreground">
                  Valores iniciales · los que estaban en el código
                </span>
                <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 text-muted-foreground">
                  {(version.summary ?? []).map((item) => (
                    <Fragment key={item.key}>
                      <dt>{item.name}</dt>
                      <dd className="text-right tabular-nums">{item.value}</dd>
                    </Fragment>
                  ))}
                </dl>
              </>
            ) : (
              <>
                <span className="text-xs text-muted-foreground">
                  {when(version.effectiveFrom)} · {version.createdByName ?? "la administración"}
                </span>
                {version.changes.map((change) => (
                  <span key={change.key} className="tabular-nums">
                    {change.name}: <s className="text-muted-foreground">{change.before}</s> →{" "}
                    <strong className="font-semibold">{change.after}</strong>
                  </span>
                ))}
                {version.reason ? (
                  <span className="italic text-muted-foreground">«{version.reason}»</span>
                ) : null}
              </>
            )}
          </li>
        ))}
      </ul>
    </DetailDrawer>
  )
}
