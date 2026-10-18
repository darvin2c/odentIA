import { cn, FieldLabel, RadioGroup, RadioGroupItem, Textarea, toast } from "@odentia/ui"
import { ConfirmDialog, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect, useId, useState } from "react"
import { ApiError, apiFetch } from "../lib/api"
import {
  BLOCK_REASON_OPTIONS,
  blockedNoticeWords,
  leftSpamWords,
  spamNoticeWords,
} from "../lib/contact-screen"
import type { ContactScreenView } from "../lib/crm"

/**
 * Spam y Bloquear en la Bandeja (ADR 0054): el aviso de arriba de la
 * conversación, el diálogo de «Bloquear a esta persona…» y sus acciones. El
 * servidor decide; la pantalla dice lo que pasó y refresca lo que lo muestra.
 */

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.shape.message ? error.shape.message : fallback
}

function useRefreshScreens() {
  const queryClient = useQueryClient()
  return () => {
    for (const key of ["conversations", "conversation", "crm-context", "crm-activity", "workspace-home", "people", "tasks"]) {
      void queryClient.invalidateQueries({ queryKey: [key] })
    }
  }
}

/**
 * Sobre quién se actúa: desde la Bandeja, la persona de una conversación
 * (`/api/conversations/:id`); desde su página, la persona (`/api/people/:id`).
 */
export interface ScreenTarget {
  base: string
  contactName: string
}
type Target = ScreenTarget

/** La persona de una conversación de la Bandeja. */
export function conversationTarget(conversationId: string, contactName: string): ScreenTarget {
  return { base: `/api/conversations/${conversationId}`, contactName }
}

/** «Es spam», «No es spam» y «Desbloquear»: las usan la lista y el hilo. */
export function useContactScreenActions() {
  const refresh = useRefreshScreens()
  const notSpam = useMutation({
    retry: false,
    mutationFn: (target: Target) =>
      apiFetch<{ data: { agentReplies: boolean; topic: boolean } }>(`${target.base}/not-spam`, {
        method: "POST",
      }),
    onSuccess: (result) => {
      toast.success(
        result.data.agentReplies
          ? "Listo, ya no es spam. El agente le está respondiendo."
          : result.data.topic
            ? "Listo, ya no es spam. Quedó en «Por atender»: para responderle hace falta una plantilla."
            : "Listo, ya no es spam.",
      )
      refresh()
    },
    onError: (error) => toast.error(errorText(error, "No se pudo sacar de Spam. Inténtalo de nuevo.")),
  })
  const spam = useMutation({
    retry: false,
    mutationFn: (target: Target) => apiFetch(`${target.base}/spam`, { method: "POST" }),
    onSuccess: (_result, target) => {
      // Actúa al instante: no pide confirmación (tablero 4). «Sacar de Spam» y no
      // «Deshacer»: lo devuelto y el caso de Soporte que abrió no se revierten.
      toast(`${target.contactName} pasó a Spam. El agente ya no le responde.`, {
        action: { label: "Sacar de Spam", onClick: () => notSpam.mutate(target) },
      })
      refresh()
    },
    onError: (error) => toast.error(errorText(error, "No se pudo mandar a Spam. Inténtalo de nuevo.")),
  })
  const unblock = useMutation({
    retry: false,
    mutationFn: (target: Target) => apiFetch(`${target.base}/unblock`, { method: "POST" }),
    onSuccess: (_result, target) => {
      toast.success(`${target.contactName} ya no está bloqueado. Puede volver a escribir.`)
      refresh()
    },
    onError: (error) => toast.error(errorText(error, "No se pudo desbloquear. Inténtalo de nuevo.")),
  })
  return { spam, notSpam, unblock }
}

/** Confirmación de «Desbloquear» (tablero 5b): dice qué cambia y que queda anotado. */
export function UnblockDialog({
  target,
  pending,
  onClose,
  onConfirm,
}: {
  target: Target | null
  pending: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <ConfirmDialog
      open={target !== null}
      title={`¿Desbloquear a ${target?.contactName ?? "esta persona"}?`}
      description="Podrá volver a escribirle a la clínica, y el agente le responderá como a cualquier persona. Queda anotado que lo desbloqueaste tú."
      confirmLabel="Desbloquear"
      variant="default"
      pending={pending}
      onClose={onClose}
      onConfirm={onConfirm}
    />
  )
}

/**
 * Lo que la conversación dice arriba (tableros 4, 5 y 5b): en Spam, con «No
 * es spam»; bloqueada, en rojo y con «Desbloquear»; si salió sola de Spam hace
 * poco, con «Es spam» para devolverla.
 */
export function ContactScreenBanner({
  target,
  view,
  canWrite,
  canBlock,
  canMarkSpam = true,
  className = "",
}: {
  target: ScreenTarget
  view: ContactScreenView | null | undefined
  /** Escribe en conversaciones: «Es spam» y «No es spam». */
  canWrite: boolean
  /** Maneja los contactos: «Desbloquear». */
  canBlock: boolean
  /** «Es spam» solo existe en la Bandeja: desde la página de la persona no se ofrece. */
  canMarkSpam?: boolean
  className?: string
}) {
  const actions = useContactScreenActions()
  const [unblockTarget, setUnblockTarget] = useState<Target | null>(null)
  if (!view) return null
  if (view.screen === "spam") {
    const words = spamNoticeWords(view)
    return (
      <div role="status" className={`flex flex-wrap items-center gap-2.5 border-b border-warning/40 bg-warning-soft px-3.5 py-2.5 text-[13px] ${className}`}>
        <p className="flex min-w-0 flex-1 basis-56 flex-col">
          <span className="font-semibold text-warning">{words.title}</span>
          <span>{words.detail}</span>
        </p>
        {canWrite ? (
          <SubmitButton
            size="sm"
            variant="outline"
            className="min-h-11 rounded-full sm:min-h-9"
            pending={actions.notSpam.isPending}
            onClick={() => actions.notSpam.mutate(target)}
          >
            No es spam
          </SubmitButton>
        ) : null}
      </div>
    )
  }
  if (view.screen === "blocked") {
    const words = blockedNoticeWords(view)
    return (
      <>
        <div role="status" className={`flex flex-wrap items-center gap-2.5 border-b border-destructive/40 bg-danger-soft px-3.5 py-2.5 text-[13px] text-destructive ${className}`}>
          <p className="flex min-w-0 flex-1 basis-56 flex-col">
            <span className="font-semibold">{words.title}</span>
            {words.detail ? <span className="text-foreground">{words.detail}</span> : null}
          </p>
          {canBlock ? (
            <SubmitButton
              size="sm"
              variant="outline"
              className="min-h-11 rounded-full sm:min-h-9"
              pending={actions.unblock.isPending}
              onClick={() => setUnblockTarget(target)}
            >
              Desbloquear
            </SubmitButton>
          ) : null}
        </div>
        <UnblockDialog
          target={unblockTarget}
          pending={actions.unblock.isPending}
          onClose={() => setUnblockTarget(null)}
          onConfirm={() => {
            if (unblockTarget) actions.unblock.mutate(unblockTarget, { onSettled: () => setUnblockTarget(null) })
          }}
        />
      </>
    )
  }
  const left = leftSpamWords(view)
  if (!left) return null
  return (
    <div role="status" className={`flex flex-wrap items-center gap-2.5 border-b bg-muted/60 px-3.5 py-2.5 text-[13px] ${className}`}>
      <p className="min-w-0 flex-1 basis-56 text-muted-foreground">{left}</p>
      {canWrite && canMarkSpam && !view.isPatient ? (
        <SubmitButton
          size="sm"
          variant="outline"
          className="min-h-11 rounded-full sm:min-h-9"
          pending={actions.spam.isPending}
          onClick={() => actions.spam.mutate(target)}
        >
          Es spam
        </SubmitButton>
      ) : null}
    </div>
  )
}

/**
 * «Bloquear a esta persona…» (tablero 5b): advertencia clara, motivo y qué
 * pasó, los dos obligatorios. Es un diálogo de confirmación como el de anular
 * una cita con motivo: decidir antes de seguir.
 */
export function BlockPersonDialog({
  target,
  onClose,
}: {
  target: Target | null
  onClose: () => void
}) {
  const refresh = useRefreshScreens()
  const reasonId = useId()
  const noteId = useId()
  const [reason, setReason] = useState("")
  const [note, setNote] = useState("")
  useEffect(() => {
    if (target) {
      setReason("")
      setNote("")
    }
  }, [target])
  const block = useMutation({
    retry: false,
    mutationFn: (input: Target & { reason: string; note: string }) =>
      apiFetch(`${input.base}/block`, {
        method: "POST",
        body: JSON.stringify({ reason: input.reason, note: input.note }),
      }),
    onSuccess: (_result, input) => {
      toast.success(`${input.contactName} quedó bloqueado. Nadie le escribe y el agente no le responde.`)
      refresh()
      onClose()
    },
  })
  const error = block.error ? errorText(block.error, "No se pudo bloquear. Inténtalo de nuevo.") : null
  return (
    <ConfirmDialog
      open={target !== null}
      title={`¿Bloquear a ${target?.contactName ?? "esta persona"}?`}
      description="No podrá escribirle a la clínica por WhatsApp, y el agente no le responderá en ningún canal. Nadie del equipo podrá escribirle hasta que alguien lo desbloquee. Sus mensajes y su ficha se conservan: no se borra nada."
      confirmLabel="Bloquear"
      variant="destructive"
      pending={block.isPending}
      confirmDisabled={!reason || !note.trim()}
      onClose={() => {
        block.reset()
        onClose()
      }}
      onConfirm={() => {
        if (target) block.mutate({ ...target, reason, note: note.trim() })
      }}
    >
      <div className="grid gap-3 text-left">
        <div className="grid gap-2">
          <span id={reasonId} className="text-sm font-medium">
            Motivo
          </span>
          <RadioGroup aria-labelledby={reasonId} value={reason} onValueChange={(next) => setReason(String(next))}>
            {BLOCK_REASON_OPTIONS.map((option) => (
              <FieldLabel
                key={option.value}
                className={cn(
                  "flex min-h-11 cursor-pointer items-center gap-2.5 rounded-xl border px-3 text-sm font-normal",
                  reason === option.value && "border-destructive bg-danger-soft",
                )}
              >
                <RadioGroupItem value={option.value} />
                {option.label}
              </FieldLabel>
            ))}
          </RadioGroup>
        </div>
        <div className="grid gap-1.5">
          <label htmlFor={noteId} className="text-sm font-medium">
            Qué pasó (obligatorio)
          </label>
          <Textarea
            id={noteId}
            maxLength={500}
            rows={3}
            placeholder="Por ejemplo: amenazó a recepción después de que le cobramos la consulta."
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </ConfirmDialog>
  )
}
