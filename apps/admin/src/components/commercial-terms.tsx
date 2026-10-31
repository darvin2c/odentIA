/**
 * Facturación › Condiciones comerciales (issue 167, ADR 0074): las reglas que
 * acompañan al precio, en frases, con «Cambiar» por grupo y «Ver cambios».
 * Frases, campos, límites y desde cuándo rige cada cambio los entrega el
 * servidor; el servidor comprueba lo mismo al guardar.
 */
import { Button, Input, toast } from "@odentia/ui"
import { DetailDrawer, ErrorState, FormDrawer, useAppForm, useFormSurface, SkeletonRegion } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Fragment, useMemo, useState } from "react"
import { z } from "zod"
import { ApiError, api } from "../lib/api"
import { CommercialTermsSkeleton } from "./skeletons/billing"

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
        <SkeletonRegion message="Cargando las condiciones">
          <CommercialTermsSkeleton />
        </SkeletonRegion>
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

/**
 * Las cifras del grupo (los límites que entrega el servidor) y el motivo. Cada
 * cifra es texto con su error en su campo (`values.<clave>`, como en el cuerpo
 * de la petición).
 */
function termsSchema(fields: TermField[]) {
  return z
    .object({
      values: z.record(z.string(), z.string()),
      reason: z.string().max(500, "Escribe como mucho 500 caracteres."),
    })
    .superRefine((form, ctx) => {
      for (const field of fields) {
        const message = fieldError(field, form.values[field.key] ?? "")
        if (message) ctx.addIssue({ code: "custom", path: ["values", field.key], message })
      }
      // El aviso va antes que la alarma (la misma regla que el servidor).
      const warn = fields.find((field) => field.key === "warnPercent")
      const alarm = fields.find((field) => field.key === "alarmPercent")
      const warnText = form.values.warnPercent ?? ""
      const alarmText = form.values.alarmPercent ?? ""
      if (warn && alarm && !fieldError(warn, warnText) && !fieldError(alarm, alarmText) && Number(warnText) >= Number(alarmText)) {
        ctx.addIssue({
          code: "custom",
          path: ["values", "warnPercent"],
          message: `El aviso va antes que la alarma: escribe menos de ${alarmText.trim()} %.`,
        })
      }
    })
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
  const schema = useMemo(() => termsSchema(group.fields), [group.fields])
  // Lo que cambió respecto de lo que rige: solo eso se envía.
  const changedOf = (texts: Record<string, string>) => group.fields.filter((field) => texts[field.key]?.trim() !== String(values[field.key]))

  const save = useMutation({
    mutationFn: (body: { values: Record<string, number>; basedOn: string | null; reason: string | null }) =>
      api<TermsView>("/api/admin/billing/terms", { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: (data) => {
      queryClient.setQueryData(TERMS_KEY, data)
      void queryClient.invalidateQueries({ queryKey: ["admin", "billing", "terms-history"] })
      toast.success("Condiciones guardadas")
      onClose()
    },
    onError: (e) => {
      // Si alguien guardó antes, se traen sus cifras: «antes» pasa a decir lo que rige ahora.
      if (e instanceof ApiError && e.status === 409)
        void queryClient.invalidateQueries({ queryKey: TERMS_KEY })
    },
  })

  const [initial] = useState(() => ({
    values: Object.fromEntries(group.fields.map((field) => [field.key, String(values[field.key] ?? "")])),
    reason: "",
  }))
  const form = useAppForm({
    defaultValues: initial,
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const changed = changedOf(value.values)
      if (changed.length === 0) return onClose()
      await save.mutateAsync({
        values: Object.fromEntries(changed.map((field) => [field.key, Number(value.values[field.key])])),
        basedOn,
        reason: value.reason.trim() || null,
      })
    },
  })
  const surface = useFormSurface(form)
  const texts = useStore(form.store, (state) => state.values.values)
  const reason = useStore(form.store, (state) => state.values.reason)
  const changed = changedOf(texts)

  // Cada fila: un campo, o dos que se leen juntos («3 días más, 1 vez por cargo»).
  const rows: TermField[][] = []
  for (const field of group.fields) {
    const last = rows[rows.length - 1]
    if (field.sameRow && last) last.push(field)
    else rows.push([field])
  }

  return (
    <FormDrawer
      {...surface}
      // Sin cambios de verdad (volver a la cifra que rige) se cierra sin preguntar.
      isDirty={changed.length > 0 || reason.trim() !== ""}
      open
      title={`Cambiar: ${group.title}`}
      description="Rige desde que guardas. Lo que ya empezó conserva la regla que tenía."
      submitLabel="Guardar"
      onClose={onClose}
    >
      <div className="flex flex-col gap-5">
        {rows.map((row) => {
          const [first] = row as [TermField, ...TermField[]]
          const rowChanged = row.filter((field) => changed.includes(field))
          const rowValid = row.every((field) => !fieldError(field, texts[field.key] ?? ""))
          return (
            <div key={first.key} className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
                {row.map((field) => (
                  <form.AppField key={field.key} name={`values.${field.key}`}>
                    {(input) => (
                      <input.Control id={`term-${field.key}`} label={field.label} description={field.hint} className="w-auto">
                        {(control) => (
                          <div className="flex flex-wrap items-center gap-2">
                            <Input
                              {...control.props}
                              className="w-20 tabular-nums"
                              inputMode="numeric"
                              autoComplete="off"
                              value={input.state.value ?? ""}
                              onChange={(event) => input.handleChange(event.target.value)}
                            />
                            <span className="text-sm text-muted-foreground">{field.unit}</span>
                            {changed.includes(field) ? (
                              <span className="text-xs font-semibold text-warning">antes {values[field.key]}</span>
                            ) : null}
                          </div>
                        )}
                      </input.Control>
                    )}
                  </form.AppField>
                ))}
              </div>
              {rowChanged.length && rowValid ? (
                <div className="flex flex-col gap-0.5 rounded-lg bg-primary/10 px-3 py-2 text-xs">
                  <span className="font-semibold">Desde cuándo rige</span>
                  <span>{first.since}</span>
                </div>
              ) : null}
            </div>
          )
        })}
        <form.AppField name="reason">
          {(field) => (
            <field.TextareaField id="term-reason" label="Por qué lo cambias (opcional)" description="Lo ve el equipo en «Ver cambios»." maxLength={500} />
          )}
        </form.AppField>
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
