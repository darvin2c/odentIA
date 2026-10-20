import { Badge, Button, Field, FieldDescription, FieldLabel, Input, Textarea } from "@odentia/ui"
import { ConfirmDialog, FlowDiagram } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { CircleAlert, CircleCheck } from "lucide-react"
import { useEffect, useId, useState } from "react"
import { type AdminDraft, type AdminLineDetail, type AdminRequestResult, adminLineKey, refreshAdmin } from "../../lib/admin"
import { ADMIN_NAME, useReceptionName } from "../../lib/agent-names"
import { apiFetch } from "../../lib/api"
import { mutationErrorMessage } from "../../lib/query-error"
import { adminFlowToDiagram } from "./admin-line"

/** Con el modelo caído el campo se desactiva y vuelve solo pasado este tiempo. */
const RETRY_AFTER_MS = 30_000

/** Quien escribe es el agente de recepción: el ejemplo dice su nombre en esta clínica. */
const examples = (receptionName: string) => [
  `Cuando alguien cancele su cita, que ${receptionName} le ofrezca otra fecha`,
  "Cuando alguien falte a su cita, que salga a las 10 y que además llame una persona si no puede",
  "Apaga la de saldos vencidos",
]

/**
 * «Dile qué quieres que haga»: pedirle algo a Argos con palabras. Lo
 * que entiende queda como borrador en su línea y se abre ahí; no prende ni
 * cambia nada. Lo que no reconoce o no se puede, lo dice.
 */
export function AdminRequest({ onOpen }: { onOpen: (key: string | undefined) => void }) {
  const uid = useId()
  const queryClient = useQueryClient()
  const receptionName = useReceptionName()
  const [text, setText] = useState("")
  const [toDelete, setToDelete] = useState<string | null>(null)
  const [down, setDown] = useState(false)
  // Lo que no sabe hacer se puede enviar a odentIA como pedido: es la misma vía de la Ayuda.
  const forward = useMutation({
    retry: false,
    mutationFn: (request: string) =>
      apiFetch("/api/help/requests", {
        method: "POST",
        body: JSON.stringify({ question: request.slice(0, 500), screen: "/agent/administrador", kind: "pregunta", detail: `Pedido a ${ADMIN_NAME} que todavía no sabe hacer` }),
      }),
    // La misma lista de «Tus casos con soporte» en Ayuda: el caso aparece enseguida.
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["support-cases"] }),
  })
  const ask = useMutation({
    retry: false,
    mutationFn: (request: string) =>
      apiFetch<{ data: AdminRequestResult }>("/api/agent/admin/request", { method: "POST", body: JSON.stringify({ text: request }) }),
    onSuccess: ({ data }) => {
      setDown(data.unavailable)
      if (data.confirmDelete && data.key) {
        setToDelete(data.key)
        onOpen(data.key)
        return
      }
      if (!data.draft || !data.key) return
      setText("")
      refreshAdmin(queryClient)
      onOpen(data.key)
    },
  })
  // Se reactiva solo: el modelo suele volver sin que nadie haga nada.
  useEffect(() => {
    if (!down) return
    const timer = setTimeout(() => setDown(false), RETRY_AFTER_MS)
    return () => clearTimeout(timer)
  }, [down])
  const answer = ask.data?.data
  const ready = text.trim().length >= 4 && !ask.isPending && !down
  const unknown = !!answer && !answer.understood && !answer.unavailable
  return (
    <section aria-labelledby={`${uid}-titulo`} className="elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-5 sm:p-6">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (ready) ask.mutate(text.trim())
        }}
      >
        <Field>
          <FieldLabel htmlFor={`${uid}-pedido`} id={`${uid}-titulo`} className="font-heading text-base font-semibold">
            Dile qué quieres que haga
          </FieldLabel>
          <FieldDescription>
            Con tus palabras. Arma el cambio con lo que el sistema ya sabe hacer y te lo deja como borrador: nada se prende ni cambia hasta que tú lo
            decidas. También puedes hacerlo todo con los interruptores de abajo.
          </FieldDescription>
          <Textarea
            id={`${uid}-pedido`}
            rows={2}
            maxLength={600}
            disabled={down || ask.isPending}
            value={text}
            placeholder={`Por ejemplo: cuando alguien cancele su cita, que ${receptionName} le ofrezca otra fecha`}
            onChange={(event) => {
              setText(event.target.value)
              if (ask.data || ask.isError) ask.reset()
              if (forward.data || forward.isError) forward.reset()
            }}
          />
        </Field>
        <Button type="submit" className="min-h-11 self-start sm:min-h-9" disabled={!ready}>
          {ask.isPending ? "Leyendo tu pedido…" : "Armar el cambio"}
        </Button>
        {text.trim().length === 0 && !down ? (
          <div className="flex min-w-0 flex-col gap-1.5">
            <p className="text-xs font-semibold text-muted-foreground">Por ejemplo</p>
            {examples(receptionName).map((example) => (
              <Button
                key={example}
                type="button"
                variant="outline"
                size="sm"
                className="h-auto min-h-11 max-w-full shrink justify-start self-start whitespace-normal py-1.5 text-left sm:min-h-8"
                onClick={() => setText(example)}
              >
                {example}
              </Button>
            ))}
          </div>
        ) : null}
      </form>
      {ask.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {mutationErrorMessage(ask.error)}
        </p>
      ) : null}
      {answer?.message ? (
        <div role="status" className="flex flex-col gap-2 rounded-xl bg-muted px-3.5 py-3 text-sm">
          <p>{answer.message}</p>
          {answer.unavailable ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" disabled={ask.isPending} onClick={() => ask.mutate(text.trim())}>
                {ask.isPending ? "Reintentando…" : "Reintentar"}
              </Button>
              <span className="text-muted-foreground">{down ? "El campo vuelve a activarse solo en medio minuto." : "Ya puedes volver a escribir."}</span>
            </div>
          ) : null}
          {unknown ? (
            forward.isSuccess ? (
              <p className="font-medium">Enviado a odentIA. La respuesta te llega en Ayuda.</p>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" disabled={forward.isPending} onClick={() => forward.mutate(text.trim())}>
                  {forward.isPending ? "Enviando…" : "Enviarlo a odentIA como pedido"}
                </Button>
                <span className="min-w-0 flex-1 basis-64 text-muted-foreground">
                  Se envía lo que escribiste, con el nombre de tu clínica, tu rol, esta pantalla y la versión de odentIA.
                </span>
              </div>
            )
          ) : null}
          {forward.isError ? (
            <p role="alert" className="text-destructive">
              {mutationErrorMessage(forward.error)}
            </p>
          ) : null}
        </div>
      ) : null}
      {toDelete ? <DeleteAdminLineDialog lineKey={toDelete} onClose={() => setToDelete(null)} /> : null}
    </section>
  )
}

function DeleteAdminLineDialog({ lineKey, name, onClose }: { lineKey: string; name?: string; onClose: () => void }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const remove = useMutation({
    retry: false,
    mutationFn: () => apiFetch(`/api/agent/admin/lines/${lineKey}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: adminLineKey(lineKey) })
      refreshAdmin(queryClient)
      void navigate({ to: "/agent/administrador", search: {}, replace: true })
      onClose()
    },
  })
  return (
    <ConfirmDialog
      open
      title={name ? `Eliminar «${name}»` : "Eliminar esta línea"}
      description="Deja de ejecutarse y se cancela lo que tenía pendiente de enviar. Lo ya hecho se conserva: los mensajes, las tareas y el registro de qué pasó. No se puede deshacer."
      confirmLabel="Eliminar"
      pending={remove.isPending}
      onClose={() => {
        if (!remove.isPending) onClose()
      }}
      onConfirm={() => remove.mutate()}
    >
      {remove.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {mutationErrorMessage(remove.error)}
        </p>
      ) : null}
    </ConfirmDialog>
  )
}

/** Eliminar una línea creada por la clínica. Las que vienen armadas no lo ofrecen: se apagan. */
export function DeleteAdminLine({ lineKey, name }: { lineKey: string; name: string }) {
  const [confirming, setConfirming] = useState(false)
  return (
    <div className="flex flex-wrap items-center gap-3 border-t pt-4 text-sm">
      <p className="min-w-0 flex-1 basis-64 text-muted-foreground">Esta línea la creó tu clínica. Si ya no la quieres, puedes eliminarla.</p>
      <Button type="button" variant="outline" className="min-h-11 text-destructive sm:min-h-9" onClick={() => setConfirming(true)}>
        Eliminar esta línea
      </Button>
      {confirming ? <DeleteAdminLineDialog lineKey={lineKey} name={name} onClose={() => setConfirming(false)} /> : null}
    </div>
  )
}

const CHANGE_WORD = { cambio: "Cambia", nueva: "Nueva", quita: "Se quita" } as const
const ACTION = {
  prender: { apply: "Prender", applying: "Prendiendo…", discard: "Descartar" },
  guardar: { apply: "Guardar el cambio", applying: "Guardando…", discard: "Cancelar" },
  apagar: { apply: "Apagarla", applying: "Apagando…", discard: "Cancelar" },
} as const

/**
 * El borrador de una línea: lo que se pidió, cómo quedaría su flujo, qué
 * cambia, la prueba con los últimos 30 días, lo que se revisó y lo que no se
 * puede. Todo lo entrega el servidor; aquí solo se decide.
 */
export function AdminDraftBlock({
  line,
  draft,
  canWrite,
  adminOn,
}: {
  line: AdminLineDetail
  draft: AdminDraft
  canWrite: boolean
  adminOn: boolean
}) {
  const uid = useId()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const receptionName = useReceptionName()
  const done = () => refreshAdmin(queryClient)
  const apply = useMutation({
    retry: false,
    mutationFn: () => apiFetch<{ data: AdminLineDetail }>(`/api/agent/admin/lines/${line.key}/draft`, { method: "POST" }),
    onSuccess: (response) => {
      queryClient.setQueryData(adminLineKey(line.key), response)
      done()
    },
  })
  const discard = useMutation({
    retry: false,
    mutationFn: () => apiFetch<{ data: { removed: boolean } }>(`/api/agent/admin/lines/${line.key}/draft`, { method: "DELETE" }),
    onSuccess: ({ data }) => {
      if (data.removed) {
        queryClient.removeQueries({ queryKey: adminLineKey(line.key) })
        void navigate({ to: "/agent/administrador", search: {}, replace: true })
      }
      done()
    },
  })
  const [note, setNote] = useState<string | null>(null)
  const saveNote = useMutation({
    retry: false,
    mutationFn: (taskNote: string) =>
      apiFetch<{ data: AdminLineDetail }>(`/api/agent/admin/lines/${line.key}/draft`, { method: "PATCH", body: JSON.stringify({ taskNote }) }),
    onSuccess: (response) => {
      queryClient.setQueryData(adminLineKey(line.key), response)
      setNote(null)
    },
  })
  const busy = apply.isPending || discard.isPending || saveNote.isPending
  const flow = adminFlowToDiagram(draft.flow)
  const words = ACTION[draft.action]
  const blocked = draft.action === "prender" && !adminOn
  return (
    <section aria-labelledby={`${uid}-borrador`} className="flex flex-col gap-4 rounded-xl border border-warning/40 bg-card p-4">
      <div className="flex flex-col gap-1">
        <h3 id={`${uid}-borrador`} className="flex flex-wrap items-center gap-2 font-heading text-sm font-semibold">
          {draft.creates ? "Línea nueva" : "Lo que pediste cambiar"}
          <Badge variant="warning">{draft.creates ? "Borrador" : "Sin guardar"}</Badge>
        </h3>
        <p className="text-sm text-muted-foreground">Pediste: «{draft.request}»</p>
        <p className="text-sm">{draft.summary}</p>
      </div>

      {draft.action !== "apagar" ? (
        <FlowDiagram
          label={`${line.name}, como quedaría`}
          main={flow.main}
          otherwise={flow.otherwise}
          idle
          renderControl={(step) => {
            const mark = draft.marks[step.id]
            return mark ? <Badge variant="warning">{mark === "nueva" ? "Nueva" : "Cambió"}</Badge> : null
          }}
        />
      ) : null}

      {draft.changes.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold">Qué cambia</h4>
          <ul className="flex flex-col divide-y rounded-xl border text-sm">
            {draft.changes.map((change) => (
              <li key={`${change.kind}-${change.after}`} className="flex flex-col gap-0.5 px-3 py-2">
                {change.before !== null ? (
                  <>
                    <span className="text-muted-foreground">Antes: {change.before}</span>
                    <span>
                      <span className="font-semibold">Ahora:</span> {change.after}
                    </span>
                  </>
                ) : (
                  <span>
                    <span className="font-semibold">{CHANGE_WORD[change.kind]}:</span> {change.after}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {draft.test ? (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold">
            La probé con tus últimos {draft.test.days} días: {draft.test.title}
          </h4>
          {draft.test.total === 0 ? (
            <p className="text-sm text-muted-foreground">No pasó ninguna vez en ese tiempo: no hay con qué estimar por dónde llegaría.</p>
          ) : (
            <ul className="flex flex-col divide-y rounded-xl border text-sm">
              {draft.test.rows.map((row) => (
                <li key={row.route} className="flex items-baseline gap-3 px-3 py-2">
                  <span className="w-8 shrink-0 text-right font-semibold tabular-nums">{row.total}</span>
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium">{row.label}</span>
                    <span className="text-muted-foreground">{row.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">{draft.test.how}</p>
        </div>
      ) : null}

      {draft.review.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold">Lo que revisé</h4>
          <ul className="flex flex-col gap-1.5 text-sm">
            {draft.review.map((check) => (
              <li key={check.text} className="flex items-start gap-2">
                {check.ok ? (
                  <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                ) : (
                  <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
                )}
                <span>
                  <span className="sr-only">{check.ok ? "Bien: " : "Atención: "}</span>
                  {check.text}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {draft.creates && draft.message ? (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold">Así le llegaría</h4>
          <div className="flex max-w-md flex-col gap-2 rounded-xl border bg-card p-3 text-sm">
            <p>{draft.message.text}</p>
            <div className="flex flex-wrap gap-2">
              {draft.message.buttons.map((button) => (
                <span key={button} className="rounded-lg border px-2.5 py-1 text-xs font-semibold text-primary">
                  {button}
                </span>
              ))}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Con datos de ejemplo. El texto es fijo: es el que se pide aprobar a WhatsApp.</p>
        </div>
      ) : null}

      {draft.unsupported.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-xl bg-muted px-3.5 py-3 text-sm">
          <h4 className="font-semibold">Lo que pediste y no se puede</h4>
          {draft.unsupported.map((item) => (
            <p key={item}>{item}</p>
          ))}
        </div>
      ) : null}

      {draft.taskNote && canWrite ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (!saveNote.isPending) saveNote.mutate((note ?? draft.taskNote?.value ?? "").trim())
          }}
        >
          <Field>
            <FieldLabel htmlFor={`${uid}-indicacion`}>Lo que sí puedo: dejarlo como indicación en la tarea</FieldLabel>
            <FieldDescription>
              La lee la persona de {draft.taskNote.team} que reciba la tarea, para que lo haga ella. {receptionName} no lo dice ni lo ofrece.
            </FieldDescription>
            <Input
              id={`${uid}-indicacion`}
              maxLength={draft.taskNote.max}
              value={note ?? draft.taskNote.value ?? ""}
              placeholder="Por ejemplo: ofrecer 10 % si reprograma"
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-8"
              disabled={busy || (note ?? draft.taskNote.value ?? "").trim() === (draft.taskNote.value ?? "")}
            >
              {saveNote.isPending ? "Guardando…" : draft.taskNote.value ? "Cambiar la indicación" : "Sí, ponlo en la tarea"}
            </Button>
            {draft.taskNote.value ? (
              <Button type="button" variant="ghost" size="sm" className="min-h-11 sm:min-h-8" disabled={busy} onClick={() => saveNote.mutate("")}>
                Quitarla
              </Button>
            ) : null}
          </div>
          {saveNote.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {mutationErrorMessage(saveNote.error)}
            </p>
          ) : null}
        </form>
      ) : null}

      {canWrite ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" className="min-h-11 sm:min-h-9" disabled={busy || blocked} onClick={() => apply.mutate()}>
            {apply.isPending ? words.applying : words.apply}
          </Button>
          <Button type="button" variant="ghost" className="min-h-11 sm:min-h-9" disabled={busy} onClick={() => discard.mutate()}>
            {discard.isPending ? "Descartando…" : words.discard}
          </Button>
          {blocked ? <span className="text-sm text-muted-foreground">Enciende primero a {ADMIN_NAME}.</span> : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Lo decide quien administra el agente.</p>
      )}
      {apply.isError || discard.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {mutationErrorMessage(apply.error ?? discard.error)}
        </p>
      ) : null}
    </section>
  )
}
