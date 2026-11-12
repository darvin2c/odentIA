import { Button, Skeleton } from "@odentia/ui"
import { ConfirmDialog, submitErrorMessage } from "@odentia/ui-patterns"
import { useEffect, useRef, useState } from "react"
import { z } from "zod"
import { api } from "../lib/api"
import type { DraftSource } from "./arm/import-drafts"

/**
 * «Cargar datos» › el informe a la clínica: se elige el informe.json que armó la skill
 * de carga con lo que se hizo en una etapa, se ve el PDF tal como saldrá y se envía
 * por el correo de producción, una sola vez. Es informativo: no pide respuesta.
 * Con `draft` (la ficha del cliente › Alta) también se puede tomar el informe
 * aprobado que dejó la skill. Solo administración, y el servidor lo exige.
 */

const previewSchema = z.object({
  to: z.string(),
  replyTo: z.string(),
  subject: z.string(),
  pages: z.number(),
  pdf: z.string(),
  sent: z.object({ at: z.string(), to: z.string().nullable(), state: z.enum(["enviando", "enviado", "desconocido"]) }).nullable(),
})
type Preview = z.infer<typeof previewSchema>

type Stage =
  | { kind: "idle" }
  | { kind: "checking"; fileName: string }
  | { kind: "ready"; fileName: string; report: unknown; preview: Preview }
  | { kind: "sending"; fileName: string; report: unknown; preview: Preview }
  | { kind: "sent"; fileName: string; to: string }

const when = new Intl.DateTimeFormat("es-PE", { dateStyle: "long", timeStyle: "short", timeZone: "America/Lima" })

export function OrgReport({ organizationId, draft }: { organizationId: string; draft?: DraftSource }) {
  const input = useRef<HTMLInputElement>(null)
  const [stage, setStage] = useState<Stage>({ kind: "idle" })
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)

  // El PDF se abre desde la memoria de la pestaña; se suelta al cambiar de informe.
  useEffect(() => () => (pdfUrl ? URL.revokeObjectURL(pdfUrl) : undefined), [pdfUrl])

  async function choose(file: File | undefined) {
    if (!file) return
    setError(null)
    let report: unknown
    try {
      report = JSON.parse(await file.text())
    } catch {
      setError("El archivo no es un informe: elige el informe.json que dejó la skill")
      return
    }
    await showReport(file.name, report)
  }

  async function takeDraft(source: DraftSource) {
    setError(null)
    setStage({ kind: "checking", fileName: source.fileName })
    let report: unknown
    try {
      report = await source.load()
    } catch (failure) {
      setError(submitErrorMessage(failure))
      setStage({ kind: "idle" })
      return
    }
    await showReport(source.fileName, report)
  }

  async function showReport(fileName: string, report: unknown) {
    setStage({ kind: "checking", fileName })
    try {
      const preview = previewSchema.parse(
        await api<unknown>(`/api/admin/imports/${organizationId}/report/preview`, { method: "POST", body: JSON.stringify(report) }),
      )
      const bytes = Uint8Array.from(atob(preview.pdf), (char) => char.charCodeAt(0))
      setPdfUrl(URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })))
      setStage({ kind: "ready", fileName, report, preview })
    } catch (failure) {
      setError(submitErrorMessage(failure))
      setStage({ kind: "idle" })
    }
  }

  async function send(current: Extract<Stage, { kind: "ready" }>) {
    setError(null)
    setStage({ ...current, kind: "sending" })
    try {
      await api<unknown>(`/api/admin/imports/${organizationId}/report/send`, { method: "POST", body: JSON.stringify(current.report) })
      setStage({ kind: "sent", fileName: current.fileName, to: current.preview.to })
      if (draft && current.fileName === draft.fileName) draft.onUsed?.()
    } catch (failure) {
      setError(submitErrorMessage(failure))
      setStage(current)
    }
  }

  return (
    <section className="flex flex-col gap-4 rounded-xl border bg-card p-4" aria-labelledby="informe-clinica">
      <div className="flex flex-col gap-1">
        <h2 id="informe-clinica" className="text-base font-medium">
          Informe a la clínica
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          Elige el informe.json de la etapa. Se ve el PDF tal como le llegará y se envía por el correo de odentIA, una sola
          vez por informe. Es informativo: no le pide respuesta.
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
      {stage.kind !== "checking" && stage.kind !== "sending" ? (
        <div className="flex flex-wrap items-center gap-2">
          {draft && stage.kind === "idle" ? (
            <Button type="button" onClick={() => void takeDraft(draft)}>
              Ver este informe
            </Button>
          ) : null}
          <Button
            type="button"
            variant={stage.kind === "idle" && !draft ? "default" : "outline"}
            onClick={() => input.current?.click()}
          >
            {stage.kind === "idle" ? (draft ? "Elegir un archivo" : "Elegir el informe") : "Elegir otro informe"}
          </Button>
          {"fileName" in stage ? <span className="text-sm text-muted-foreground">{stage.fileName}</span> : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {stage.kind === "checking" ? <Skeleton className="h-16 w-full" aria-busy="true" /> : null}
      {stage.kind === "ready" || stage.kind === "sending" ? (
        <div className="flex flex-col gap-3" aria-live="polite">
          <dl className="grid gap-1 text-sm sm:grid-cols-[8rem_1fr]">
            <dt className="text-muted-foreground">Para</dt>
            <dd>{stage.preview.to}</dd>
            <dt className="text-muted-foreground">Asunto</dt>
            <dd>{stage.preview.subject}</dd>
            <dt className="text-muted-foreground">Si responde</dt>
            <dd>{stage.preview.replyTo}</dd>
            <dt className="text-muted-foreground">PDF</dt>
            <dd>
              {stage.preview.pages} {stage.preview.pages === 1 ? "hoja" : "hojas"}
              {pdfUrl ? (
                <>
                  {" · "}
                  <a href={pdfUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                    Ver el PDF
                  </a>
                </>
              ) : null}
            </dd>
          </dl>
          {stage.preview.sent ? (
            <p className="text-sm text-muted-foreground">
              {stage.preview.sent.state === "enviado"
                ? `Este informe ya se envió el ${when.format(new Date(stage.preview.sent.at))}${stage.preview.sent.to ? ` a ${stage.preview.sent.to}` : ""}: no se envía dos veces.`
                : `Este informe se intentó enviar el ${when.format(new Date(stage.preview.sent.at))} y no se sabe si salió: revisa en Zoho antes de enviar otro con un número nuevo.`}
            </p>
          ) : (
            <div>
              <Button type="button" disabled={stage.kind === "sending"} onClick={() => setConfirming(true)}>
                {stage.kind === "sending" ? "Enviando…" : `Enviar a ${stage.preview.to}`}
              </Button>
            </div>
          )}
        </div>
      ) : null}
      {stage.kind === "sent" ? (
        <p className="text-sm" aria-live="polite">
          Enviado a {stage.to}. Quedó registrado y no se puede enviar otra vez.
        </p>
      ) : null}
      <ConfirmDialog
        open={confirming}
        title="Enviar el informe"
        description={stage.kind === "ready" ? `Le llega a ${stage.preview.to} con el PDF adjunto. Se envía una sola vez.` : ""}
        confirmLabel="Enviar"
        variant="default"
        onConfirm={() => {
          setConfirming(false)
          if (stage.kind === "ready") void send(stage)
        }}
        onClose={() => setConfirming(false)}
      />
    </section>
  )
}
