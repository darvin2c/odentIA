import { Badge, Button, Skeleton } from "@odentia/ui"
import { ConfirmDialog, submitErrorMessage } from "@odentia/ui-patterns"
import { useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"
import { z } from "zod"
import { api } from "../lib/api"

/**
 * «Cargar datos» de una clínica (ADR 0104): se elige el plan que preparó la
 * skill de carga, se ve el ensayo y se carga por tandas. El plan vive solo en
 * esta pestaña (nunca se guarda en el navegador); lo que dice cada fila sale
 * del servidor. Solo administración, y el servidor lo exige.
 */

const messageSchema = z.object({ level: z.enum(["error", "aviso"]), message: z.string() })
const previewSchema = z.object({
  planSha256: z.string(),
  order: z.array(z.string()),
  totals: z.object({
    nuevas: z.number(),
    pacientes: z.number(),
    responsables: z.number(),
    cargadas: z.number(),
    existen: z.number(),
    errores: z.number(),
    paraRevisar: z.number(),
    fuera: z.number(),
  }),
  rows: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      patient: z.boolean(),
      origin: z.object({ file: z.string(), row: z.number() }).nullable(),
      status: z.enum(["nueva", "cargada", "existe", "error"]),
      messages: z.array(messageSchema),
    }),
  ),
  omitted: z.array(z.object({ file: z.string(), row: z.number(), reason: z.string() })),
})
type Preview = z.infer<typeof previewSchema>
const batchSchema = z.object({
  next: z.number(),
  total: z.number(),
  done: z.object({ creadas: z.number(), existentes: z.number(), yaCargadas: z.number(), errores: z.number() }),
  failed: z.array(z.object({ key: z.string(), name: z.string(), message: z.string() })),
})

type Loaded = { creadas: number; existentes: number; errores: number; failed: z.infer<typeof batchSchema>["failed"] }
type Stage =
  | { kind: "idle" }
  | { kind: "checking"; fileName: string }
  | { kind: "checked"; fileName: string; plan: unknown; preview: Preview }
  | { kind: "loading" | "stopped" | "failed" | "done"; fileName: string; plan: unknown; preview: Preview; next: number; total: number; loaded: Loaded; error?: string }

const count = new Intl.NumberFormat("es-PE")
/** Cuántas filas de cada lista se muestran: el resto está en el informe de la skill. */
const SHOWN = 50

export function OrgImport({ organizationId, organizationName }: { organizationId: string; organizationName: string }) {
  const queryClient = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const stop = useRef(false)
  const [stage, setStage] = useState<Stage>({ kind: "idle" })
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  async function check(fileName: string, plan: unknown) {
    setError(null)
    setStage({ kind: "checking", fileName })
    try {
      const preview = previewSchema.parse(
        await api<unknown>(`/api/admin/imports/${organizationId}/preview`, { method: "POST", body: JSON.stringify(plan) }),
      )
      setStage({ kind: "checked", fileName, plan, preview })
    } catch (failure) {
      setError(submitErrorMessage(failure))
      setStage({ kind: "idle" })
    }
  }

  async function choose(file: File | undefined) {
    if (!file) return
    let plan: unknown
    try {
      plan = JSON.parse(await file.text())
    } catch {
      setError("Ese archivo no es un plan de carga: elige el plan.json que preparó la skill")
      return
    }
    await check(file.name, plan)
  }

  async function load(from: Extract<Stage, { plan: unknown }>, start: number, previous: Loaded) {
    stop.current = false
    let next = start
    const loaded = { ...previous, failed: [...previous.failed] }
    const total = from.preview.order.length
    setStage({ ...from, kind: "loading", next, total, loaded })
    while (next < total) {
      try {
        const batch = batchSchema.parse(
          await api<unknown>(`/api/admin/imports/${organizationId}/apply`, { method: "POST", body: JSON.stringify({ plan: from.plan, from: next }) }),
        )
        next = batch.next
        loaded.creadas += batch.done.creadas
        loaded.existentes += batch.done.existentes
        loaded.errores += batch.done.errores
        loaded.failed.push(...batch.failed)
      } catch (failure) {
        setStage({ ...from, kind: "failed", next, total, loaded, error: submitErrorMessage(failure) })
        return
      }
      if (stop.current && next < total) {
        setStage({ ...from, kind: "stopped", next, total, loaded })
        return
      }
      setStage({ ...from, kind: "loading", next, total, loaded: { ...loaded } })
    }
    setStage({ ...from, kind: "done", next, total, loaded })
    void queryClient.invalidateQueries({ queryKey: ["admin-organization", organizationId] })
  }

  const empty: Loaded = { creadas: 0, existentes: 0, errores: 0, failed: [] }
  const preview = "preview" in stage ? stage.preview : null
  const toLoad = preview ? preview.totals.nuevas + preview.totals.existen : 0

  return (
    <section className="flex flex-col gap-4 rounded-xl border bg-card p-4" aria-labelledby="cargar-datos">
      <div className="flex flex-col gap-1">
        <h2 id="cargar-datos" className="text-base font-medium">
          Cargar los datos de la clínica
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          Elige el plan que preparó la skill de carga con los archivos de la clínica. Primero se ensaya: nada se guarda
          hasta que pulses «Cargar». Cada persona se crea con las reglas de «Nuevo paciente» y no se envía ningún
          mensaje.
        </p>
      </div>

      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          void choose(event.target.files?.[0])
          event.target.value = ""
        }}
      />
      {stage.kind === "idle" || stage.kind === "checked" || stage.kind === "done" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant={stage.kind === "idle" ? "default" : "outline"} onClick={() => input.current?.click()}>
            {stage.kind === "idle" ? "Elegir el plan" : "Elegir otro plan"}
          </Button>
          {"fileName" in stage ? <span className="text-sm text-muted-foreground">{stage.fileName}</span> : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {stage.kind === "checking" ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <p className="text-sm text-muted-foreground">Ensayando {stage.fileName}…</p>
          <Skeleton className="h-24 w-full" />
        </div>
      ) : null}

      {stage.kind === "checked" && preview ? (
        <>
          <Summary preview={preview} />
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={toLoad === 0} onClick={() => setConfirming(true)}>
              {preview.totals.nuevas ? `Cargar ${count.format(preview.totals.nuevas)}` : "Cargar"}
            </Button>
          </div>
          <Details preview={preview} />
        </>
      ) : null}

      {stage.kind === "loading" || stage.kind === "stopped" || stage.kind === "failed" || stage.kind === "done" ? (
        <Progress stage={stage} onStop={() => (stop.current = true)} onResume={() => void load(stage, stage.next, stage.loaded)} onCheck={() => void check(stage.fileName, stage.plan)} />
      ) : null}

      <ConfirmDialog
        open={confirming}
        title={`Cargar en ${organizationName}`}
        description={
          preview
            ? `Se crearán ${count.format(preview.totals.pacientes)} fichas de pacientes y ${count.format(preview.totals.responsables)} personas que hablan por ellos${preview.totals.errores ? `; ${count.format(preview.totals.errores)} filas con errores no entran` : ""}. No se envía ningún mensaje. Si se corta, se sigue sin duplicar.`
            : ""
        }
        confirmLabel="Cargar"
        variant="default"
        onConfirm={() => {
          setConfirming(false)
          if (stage.kind === "checked") void load(stage, 0, empty)
        }}
        onClose={() => setConfirming(false)}
      />
    </section>
  )
}

function Summary({ preview }: { preview: Preview }) {
  const { totals } = preview
  const facts = [
    totals.cargadas ? `${count.format(totals.cargadas)} ya se cargaron antes` : null,
    totals.existen ? `${count.format(totals.existen)} ya estaban en la clínica y no se tocan` : null,
    totals.errores ? `${count.format(totals.errores)} no se cargarán por errores` : null,
    totals.paraRevisar ? `${count.format(totals.paraRevisar)} para revisar` : null,
    totals.fuera ? `${count.format(totals.fuera)} quedaron fuera al preparar` : null,
  ].filter(Boolean)
  return (
    <div className="flex flex-col gap-1" aria-live="polite">
      <p className="text-sm font-medium">
        {totals.nuevas
          ? `Se crearán ${count.format(totals.pacientes)} fichas de pacientes y ${count.format(totals.responsables)} personas que hablan por ellos.`
          : "No hay nada nuevo que crear con este plan."}
      </p>
      {facts.length ? <p className="text-sm text-muted-foreground">{facts.join(" · ")}</p> : null}
    </div>
  )
}

const where = (origin: { file: string; row: number } | null) => (origin ? `${origin.file}, fila ${origin.row}` : "")

function Details({ preview }: { preview: Preview }) {
  const errors = preview.rows.filter((row) => row.status === "error")
  const review = preview.rows.filter((row) => row.status !== "error" && row.messages.length)
  return (
    <div className="flex flex-col gap-4">
      <RowList
        title="No se cargarán"
        tone="destructive"
        items={errors.map((row) => ({ id: row.key, name: row.name, where: where(row.origin), text: row.messages.filter((m) => m.level === "error").map((m) => m.message) }))}
      />
      <RowList
        title="Para revisar antes de cargar"
        tone="warning"
        items={review.map((row) => ({ id: row.key, name: row.name, where: where(row.origin), text: row.messages.map((m) => m.message) }))}
      />
      <RowList
        title="Quedaron fuera al preparar"
        tone="outline"
        items={preview.omitted.map((item) => ({ id: `${item.file}:${item.row}`, name: "", where: where(item), text: [item.reason] }))}
      />
    </div>
  )
}

function RowList({
  title,
  tone,
  items,
}: {
  title: string
  tone: "destructive" | "warning" | "outline"
  items: Array<{ id: string; name: string; where: string; text: string[] }>
}) {
  if (!items.length) return null
  return (
    <div className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        {title} <Badge variant={tone}>{count.format(items.length)}</Badge>
      </h3>
      <ul className="flex flex-col divide-y text-sm">
        {items.slice(0, SHOWN).map((item) => (
          <li key={item.id} className="flex flex-col gap-0.5 py-2">
            <span className="flex flex-wrap gap-x-2">
              {item.name ? <span className="font-medium">{item.name}</span> : null}
              <span className="text-muted-foreground">{item.where}</span>
            </span>
            {item.text.map((text) => (
              <span key={text}>{text}</span>
            ))}
          </li>
        ))}
      </ul>
      {items.length > SHOWN ? (
        <p className="text-xs text-muted-foreground">Y {count.format(items.length - SHOWN)} más: están en el informe que dejó la skill.</p>
      ) : null}
    </div>
  )
}

function Progress({
  stage,
  onStop,
  onResume,
  onCheck,
}: {
  stage: Extract<Stage, { kind: "loading" | "stopped" | "failed" | "done" }>
  onStop: () => void
  onResume: () => void
  onCheck: () => void
}) {
  const { next, total, loaded } = stage
  const percent = total ? Math.round((next / total) * 100) : 100
  const done = [
    `${count.format(loaded.creadas)} creadas`,
    loaded.existentes ? `${count.format(loaded.existentes)} ya estaban` : null,
    loaded.errores ? `${count.format(loaded.errores)} no entraron` : null,
  ].filter(Boolean)
  const heading =
    stage.kind === "loading"
      ? `Cargando… ${count.format(next)} de ${count.format(total)}`
      : stage.kind === "done"
        ? "Carga terminada"
        : stage.kind === "stopped"
          ? `Se detuvo en ${count.format(next)} de ${count.format(total)}: lo que entró queda`
          : `Se cortó en ${count.format(next)} de ${count.format(total)}: lo que entró queda`
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5" aria-live="polite">
        <p className="text-sm font-medium">{heading}</p>
        <div
          role="progressbar"
          aria-label="Avance de la carga"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={next}
          className="h-2 w-full max-w-md overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full bg-primary transition-[width] motion-reduce:transition-none" style={{ width: `${percent}%` }} />
        </div>
        <p className="text-sm text-muted-foreground">{done.join(" · ")}</p>
        {stage.kind === "failed" && stage.error ? (
          <p role="alert" className="text-sm text-destructive">
            {stage.error}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {stage.kind === "loading" ? (
          <Button type="button" variant="outline" onClick={onStop}>
            Detener
          </Button>
        ) : null}
        {stage.kind === "stopped" || stage.kind === "failed" ? (
          <Button type="button" onClick={onResume}>
            Seguir desde donde quedó
          </Button>
        ) : null}
        {stage.kind === "done" ? (
          <Button type="button" variant="outline" onClick={onCheck}>
            Volver a ensayar
          </Button>
        ) : null}
      </div>
      {stage.kind !== "loading" && loaded.failed.length ? (
        <RowList
          title="No entraron"
          tone="destructive"
          items={loaded.failed.map((item) => ({ id: item.key, name: item.name, where: "", text: [item.message] }))}
        />
      ) : null}
    </div>
  )
}
