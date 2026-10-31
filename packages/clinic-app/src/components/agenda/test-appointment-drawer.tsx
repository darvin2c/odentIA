import { Badge, Button, buttonVariants, cn } from "@odentia/ui"
import { DetailDrawer, DetailField, DetailList, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { AgendaAppointment } from "../../lib/agenda"
import { useReceptionName } from "../../lib/agent-names"
import { apiFetch } from "../../lib/api"
import { authClient } from "../../lib/auth-client"
import { usePermission } from "../../lib/crm"
import { appWords, upperFirst } from "../../lib/product-words"
import { rangeSaid, whenSaid } from "./shared"

/**
 * La cita de prueba abierta (ADR 0094): qué es, qué no hace y de qué prueba
 * salió. No hay «Llegó» ni «Atender» —nadie va a venir—: se ve la prueba o se
 * borra con todo lo que creó.
 */
export function TestAppointmentDrawer({
  appointment,
  timeZone,
  today,
  onClose,
  onChanged,
}: {
  appointment: AgendaAppointment
  timeZone: string
  today: string
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const receptionName = useReceptionName()
  const canTest = usePermission("agent.write")
  const canReadChats = usePermission("conversations.read")
  const me = authClient.useSession().data?.user.id
  const test = appointment.test
  const conversationId = test?.conversationId ?? null
  const remove = useMutation({
    retry: false,
    mutationFn: () =>
      apiFetch("/api/agent/probar/delete", {
        method: "POST",
        body: JSON.stringify({ conversationId }),
      }),
    onSuccess: async () => {
      await onChanged()
      onClose()
    },
  })
  // La de «Probar» se ve en su panel (la de quien mira); la del chat web, en la Bandeja.
  const fromProbar = Boolean(test?.byUserId)
  const view =
    fromProbar && test?.byUserId === me && canTest ? (
      <Link
        to="/agent/recepcion"
        hash="probar"
        className={cn(buttonVariants({ variant: "outline" }))}
      >
        Ver la prueba
      </Link>
    ) : !fromProbar && conversationId && canReadChats ? (
      <Link
        to="/inbox"
        search={{ conversation: conversationId }}
        className={cn(buttonVariants({ variant: "outline" }))}
      >
        Ver la prueba
      </Link>
    ) : null
  return (
    <DetailDrawer
      open
      title={appointment.patientName}
      description={rangeSaid(appointment.startsAt, appointment.endsAt, timeZone, today)}
      onClose={onClose}
      isSubmitting={remove.isPending}
      error={remove.isError ? submitErrorMessage(remove.error) : null}
      actions={
        <>
          {view}
          {canTest && conversationId ? (
            <Button
              variant="outline"
              className="border-destructive/40 text-destructive hover:text-destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Borrar esta prueba
            </Button>
          ) : null}
        </>
      }
    >
      <div className="grid gap-4">
        <Badge className="self-start">Prueba</Badge>
        <DetailList columns={1}>
          <DetailField label="Profesional">{appointment.professionalName}</DetailField>
          <DetailField label={upperFirst(appWords().room.one)}>{appointment.roomName}</DetailField>
          <DetailField label="Servicio">{appointment.serviceName ?? "Sin servicio"}</DetailField>
          <DetailField label="Salió de">
            {fromProbar
              ? `Probar · la hizo ${test?.byName ?? "alguien del equipo"}`
              : "La prueba del chat web"}
          </DetailField>
        </DetailList>
        <p role="note" className="rounded-xl border bg-muted/50 px-4 py-3 text-sm leading-relaxed">
          <strong className="font-semibold">Es una prueba.</strong> {receptionName} la reservó de
          verdad, pero no ocupa el horario: un paciente real puede reservar esta hora igual. No se
          envían recordatorios, no va al calendario del profesional y no cuenta en Reportes.
          {test?.deletesAt ? ` Se borra sola ${whenSaid(test.deletesAt, timeZone, today)}.` : ""}
        </p>
        {canTest && conversationId ? (
          <p className="text-xs text-muted-foreground">
            «Borrar esta prueba» borra la conversación de prueba y todo lo que creó.
          </p>
        ) : null}
      </div>
    </DetailDrawer>
  )
}
