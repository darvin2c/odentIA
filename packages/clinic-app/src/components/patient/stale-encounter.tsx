import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  toast,
} from "@odentia/ui"
import { submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { History } from "lucide-react"
import { useState } from "react"
import { useMyUserId, usePermission } from "../../lib/crm"
import { discardEncounterApi, fetchOpenEncounter, type OpenEncounterRef } from "../../lib/encounters"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import { usePersonArchived } from "../../lib/person-archived"
import { EncounterVoidDialog } from "./encounter-void-dialog"

/** «el lunes 9 de noviembre», en la zona de la clínica. */
export function encounterDayWords(iso: string): string {
  return new Intl.DateTimeFormat(activeOrgLocale(), {
    timeZone: activeOrgTimeZone(),
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(iso))
}

/** La atención en curso de un paciente: cuál, de qué día, si está vacía. Solo para quien atiende. */
export function useOpenEncounter(patientId: string, enabled = true) {
  const canWrite = usePermission("clinical.write")
  return useQuery({
    queryKey: ["open-encounter", patientId],
    queryFn: () => fetchOpenEncounter(patientId),
    enabled: enabled && canWrite,
  })
}

/** «Descartar» una atención vacía: se borra sin motivo y se vuelve a leer lo que dependía de ella. */
export function useDiscardEncounter(patientId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (encounterId: string) => discardEncounterApi(patientId, encounterId),
    onSuccess: async () => {
      toast.success("Atención descartada: no tenía nada registrado")
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["open-encounter", patientId] }),
        queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] }),
        queryClient.invalidateQueries({ queryKey: ["encounters", patientId] }),
        queryClient.invalidateQueries({ queryKey: ["stale-encounters"] }),
        queryClient.invalidateQueries({ queryKey: ["appointments"] }),
      ])
    },
    onError: (error) => {
      toast.error(submitErrorMessage(error))
      // Ya tenía algo registrado: se vuelve a leer y se ofrece cerrarla o anularla.
      void queryClient.invalidateQueries({ queryKey: ["open-encounter", patientId] })
    },
  })
}

/**
 * Lo que se puede hacer con una atención que quedó abierta de otro día (10 nov): seguir en ella,
 * cerrarla (sin procedimientos también se cierra) o, si no tiene nada registrado, descartarla de
 * un toque. Sirve igual en la ficha, al atender y en Inicio.
 */
function StaleEncounterActions({
  patientId,
  open,
  size = "sm",
  onDiscarded,
}: {
  patientId: string
  open: OpenEncounterRef
  size?: "sm" | "default"
  onDiscarded?: () => void | Promise<void>
}) {
  const navigate = useNavigate()
  const myUserId = useMyUserId()
  const discard = useDiscardEncounter(patientId)
  const go = () =>
    void navigate({
      to: "/patients/$patientId/encounters/$encounterId",
      params: { patientId, encounterId: open.id },
    })
  // Descartar es de quien la lleva (el servidor lo exige); otro la abre y toma el relevo.
  const mine = open.professionalUserId === myUserId
  const queryClient = useQueryClient()
  const [voiding, setVoiding] = useState(false)
  return (
    <span className="flex flex-wrap gap-2">
      <Button type="button" size={size} onClick={go}>
        Seguir en ella
      </Button>
      <Button type="button" size={size} variant="outline" onClick={go}>
        Cerrarla
      </Button>
      {/* El texto la nombra: «Anularla» va aquí mismo, no solo dentro (QA del 10 nov, B12). */}
      {!open.empty && mine ? (
        <>
          <Button type="button" size={size} variant="ghost" onClick={() => setVoiding(true)}>
            Anularla
          </Button>
          <EncounterVoidDialog
            open={voiding}
            patientId={patientId}
            encounterId={open.id}
            onClose={() => setVoiding(false)}
            onVoided={async () => {
              setVoiding(false)
              await Promise.all(
                ["open-encounter", "patient-summary", "encounters", "stale-encounters", "appointments", "plan-next"].map(
                  (key) => queryClient.invalidateQueries({ queryKey: [key] }),
                ),
              )
            }}
          />
        </>
      ) : null}
      {open.empty && mine ? (
        <Button
          type="button"
          size={size}
          variant="ghost"
          disabled={discard.isPending}
          onClick={async () => {
            // Con la promesa, no con el `onSuccess` de la llamada: al releer la atención en curso,
            // quien pregunta cambia y ese aviso no llegaría (QA en pantalla).
            try {
              await discard.mutateAsync(open.id)
            } catch {
              return
            }
            await onDiscarded?.()
          }}
        >
          {discard.isPending ? "Descartando…" : "Descartarla"}
        </Button>
      ) : null}
    </span>
  )
}

function staleWords(open: OpenEncounterRef): string {
  return open.empty
    ? "Está vacía: descártala o sigue en ella si es lo de ese día."
    : "Sigue en ella si es lo de ese día; si no, ciérrala (sin procedimientos también se cierra) o anúlala con su motivo para atender hoy en otra."
}

/** En la ficha: el aviso de la atención que quedó abierta de otro día, sin frenar nada. */
export function StaleEncounterNotice({ patientId }: { patientId: string }) {
  const archived = usePersonArchived()
  const query = useOpenEncounter(patientId, !archived)
  const open = query.data?.data
  if (!open || open.today) return null
  return (
    <Alert>
      <History aria-hidden />
      <AlertDescription className="flex flex-col items-start gap-2 text-foreground">
        <span>
          Quedó abierta la atención del {encounterDayWords(open.startedAt)}. {staleWords(open)}
        </span>
        <StaleEncounterActions patientId={patientId} open={open} />
      </AlertDescription>
    </Alert>
  )
}

/** Al atender con una atención de otro día abierta: la pregunta, en vez de un rechazo. */
export function StaleEncounterDialog({
  patientId,
  open,
  onClose,
  onDiscarded,
}: {
  patientId: string
  open: OpenEncounterRef | null
  onClose: () => void
  /** Descartada: sigue con lo que se quería hacer (abrir la de hoy). */
  onDiscarded?: () => void | Promise<void>
}) {
  return (
    <AlertDialog
      open={open !== null}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <AlertDialogContent size="default">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {open ? `Quedó abierta la del ${encounterDayWords(open.startedAt)}` : "Quedó abierta otra atención"}
          </AlertDialogTitle>
          <AlertDialogDescription>{open ? staleWords(open) : ""}</AlertDialogDescription>
        </AlertDialogHeader>
        {open ? (
          <StaleEncounterActions
            patientId={patientId}
            open={open}
            size="default"
            onDiscarded={async () => {
              onClose()
              await onDiscarded?.()
            }}
          />
        ) : null}
        <AlertDialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
