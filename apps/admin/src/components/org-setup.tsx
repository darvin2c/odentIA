import { Badge, Button, Skeleton } from "@odentia/ui"
import { ConfirmDialog, submitErrorMessage } from "@odentia/ui-patterns"
import { useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"
import { z } from "zod"
import { api } from "../lib/api"
import type { DraftSource } from "./arm/import-drafts"

/**
 * «Cargar datos» › la configuración de la clínica (ADR 0104): se elige el plan
 * (`clinica.json`) que preparó la skill de carga con lo que la clínica envió, se ve
 * el ensayo área por área y se carga. Cada cosa se escribe con la operación de su
 * pantalla en la clínica; volver a cargar no duplica. El plan vive solo en esta
 * pestaña. Con `draft` (la ficha del cliente › Alta) también se puede tomar el
 * plan aprobado que dejó la skill, sin elegir un archivo. Solo administración,
 * y el servidor lo exige.
 */

const statusSchema = z.enum(["nueva", "cambia", "igual", "espera", "error"])
type Status = z.infer<typeof statusSchema>
const resultSchema = z.object({
  planSha256: z.string(),
  items: z.array(z.object({ area: z.string(), label: z.string(), status: statusSchema, detail: z.string().optional() })),
  totals: z.record(statusSchema, z.number()),
  invitations: z.array(z.object({ id: z.string(), email: z.string(), role: z.string() })),
  emails: z.array(z.object({ email: z.string(), sent: z.boolean() })).optional(),
})
type Result = z.infer<typeof resultSchema>

type Stage =
  | { kind: "idle" }
  | { kind: "checking"; fileName: string }
  | { kind: "checked"; fileName: string; plan: unknown; result: Result }
  | { kind: "loading"; fileName: string; plan: unknown; result: Result }
  | { kind: "done"; fileName: string; plan: unknown; result: Result }

/** Cómo se dice cada estado: antes de cargar (ensayo) y después. */
const WORDS: Record<Status, { before: string; after: string; tone: "default" | "secondary" | "outline" | "destructive" }> = {
  nueva: { before: "Se crea", after: "Creado", tone: "default" },
  cambia: { before: "Se actualiza", after: "Actualizado", tone: "secondary" },
  igual: { before: "Ya está", after: "Ya estaba", tone: "outline" },
  espera: { before: "Espera a una persona", after: "Espera a una persona", tone: "outline" },
  error: { before: "No se carga", after: "No se cargó", tone: "destructive" },
}

export function OrgSetup({
  organizationId,
  organizationName,
  draft,
}: {
  organizationId: string
  organizationName: string
  draft?: DraftSource
}) {
  const queryClient = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [stage, setStage] = useState<Stage>({ kind: "idle" })
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  async function check(fileName: string, plan: unknown) {
    setError(null)
    setStage({ kind: "checking", fileName })
    try {
      const result = resultSchema.parse(
        await api<unknown>(`/api/admin/imports/${organizationId}/setup/preview`, { method: "POST", body: JSON.stringify(plan) }),
      )
      setStage({ kind: "checked", fileName, plan, result })
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
      setError("El archivo no es un plan: elige el clinica.json que dejó la skill")
      return
    }
    await check(file.name, plan)
  }

  async function takeDraft(source: DraftSource) {
    setError(null)
    setStage({ kind: "checking", fileName: source.fileName })
    let plan: unknown
    try {
      plan = await source.load()
    } catch (failure) {
      setError(submitErrorMessage(failure))
      setStage({ kind: "idle" })
      return
    }
    await check(source.fileName, plan)
  }

  async function load(current: Extract<Stage, { kind: "checked" }>) {
    setError(null)
    setStage({ ...current, kind: "loading" })
    try {
      const result = resultSchema.parse(
        await api<unknown>(`/api/admin/imports/${organizationId}/setup/apply`, { method: "POST", body: JSON.stringify(current.plan) }),
      )
      setStage({ kind: "done", fileName: current.fileName, plan: current.plan, result })
      if (draft && current.fileName === draft.fileName) draft.onUsed?.()
      void queryClient.invalidateQueries()
    } catch (failure) {
      // Un corte a mitad no deja nada a medias que se repita: volver a ensayar dice qué entró.
      setError(`${submitErrorMessage(failure)} Vuelve a ensayar para ver qué quedó cargado.`)
      setStage(current)
    }
  }

  const result = "result" in stage ? stage.result : null
  const toLoad = result ? result.totals.nueva + result.totals.cambia : 0
  const invites = result?.items.filter((item) => item.area === "Equipo" && item.status === "nueva").length ?? 0

  return (
    <section className="flex flex-col gap-4 rounded-xl border bg-card p-4" aria-labelledby="cargar-configuracion">
      <div className="flex flex-col gap-1">
        <h2 id="cargar-configuracion" className="text-base font-medium">
          Configuración de la clínica
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          Elige el clinica.json que preparó la skill de carga. Primero se ensaya: nada se guarda hasta que pulses «Cargar».
          Cada cosa se guarda como en su pantalla de la clínica y volver a cargar no duplica. Solo se envían las
          invitaciones del equipo.
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
      {draft && stage.kind === "idle" ? <p className="text-sm">{draft.label}</p> : null}
      {stage.kind === "idle" || stage.kind === "checked" || stage.kind === "done" ? (
        <div className="flex flex-wrap items-center gap-2">
          {draft && stage.kind === "idle" ? (
            <Button type="button" onClick={() => void takeDraft(draft)}>
              Ensayar este plan
            </Button>
          ) : null}
          <Button
            type="button"
            variant={stage.kind === "idle" && !draft ? "default" : "outline"}
            onClick={() => input.current?.click()}
          >
            {stage.kind === "idle" ? (draft ? "Elegir un archivo" : "Elegir el plan") : "Elegir otro plan"}
          </Button>
          {"fileName" in stage ? <span className="text-sm text-muted-foreground">{stage.fileName}</span> : null}
          {stage.kind === "done" ? (
            <Button type="button" variant="ghost" onClick={() => void check(stage.fileName, stage.plan)}>
              Volver a ensayar
            </Button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {stage.kind === "checking" || stage.kind === "loading" ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <p className="text-sm text-muted-foreground">
            {stage.kind === "checking" ? `Ensayando ${stage.fileName}…` : `Cargando ${stage.fileName}…`}
          </p>
          <Skeleton className="h-24 w-full" />
        </div>
      ) : null}

      {result && (stage.kind === "checked" || stage.kind === "done") ? (
        <>
          <Totals result={result} after={stage.kind === "done"} />
          {stage.kind === "checked" ? (
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={toLoad === 0} onClick={() => setConfirming(true)}>
                Cargar
              </Button>
            </div>
          ) : null}
          {stage.kind === "done" && result.emails?.some((email) => !email.sent) ? (
            <p role="alert" className="text-sm text-destructive">
              No salió el correo de invitación a {result.emails.filter((email) => !email.sent).map((email) => email.email).join(", ")}.
              La invitación quedó creada: reenvíala desde la pestaña Equipo.
            </p>
          ) : null}
          <Areas result={result} after={stage.kind === "done"} />
        </>
      ) : null}

      <ConfirmDialog
        open={confirming}
        title={`Cargar en ${organizationName}`}
        description={
          result
            ? `Se crean o actualizan ${toLoad} cosas de la configuración${invites ? ` y salen ${invites} invitaciones del equipo por correo` : ""}${result.totals.error ? `; ${result.totals.error} no se cargan por errores` : ""}. No se escribe a ningún paciente.`
            : ""
        }
        confirmLabel="Cargar"
        variant="default"
        onConfirm={() => {
          setConfirming(false)
          if (stage.kind === "checked") void load(stage)
        }}
        onClose={() => setConfirming(false)}
      />
    </section>
  )
}

function Totals({ result, after }: { result: Result; after: boolean }) {
  const order: Status[] = ["nueva", "cambia", "igual", "espera", "error"]
  const facts = order.filter((status) => result.totals[status]).map((status) => `${result.totals[status]} ${(after ? WORDS[status].after : WORDS[status].before).toLowerCase()}`)
  return (
    <div className="flex flex-col gap-1" aria-live="polite">
      <p className="text-sm font-medium">{after ? "Carga terminada" : "Lo que hará la carga"}</p>
      <p className="text-sm text-muted-foreground">{facts.join(" · ") || "Nada que cargar"}</p>
    </div>
  )
}

function Areas({ result, after }: { result: Result; after: boolean }) {
  const areas = [...new Set(result.items.map((item) => item.area))]
  return (
    <div className="flex flex-col gap-4">
      {areas.map((area) => {
        const items = result.items.filter((item) => item.area === area)
        return (
          <div key={area} className="flex flex-col gap-2">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              {area} <Badge variant="outline">{items.length}</Badge>
            </h3>
            <ul className="flex flex-col divide-y text-sm">
              {items.map((item, index) => (
                <li key={`${item.label}-${index}`} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                  <span className="min-w-0">
                    <span className="font-medium">{item.label}</span>
                    {item.detail ? <span className="block text-muted-foreground">{item.detail}</span> : null}
                  </span>
                  <Badge variant={WORDS[item.status].tone} className="shrink-0 self-start">
                    {after ? WORDS[item.status].after : WORDS[item.status].before}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}
