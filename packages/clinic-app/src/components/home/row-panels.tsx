import { Button, buttonVariants, cn, Field, FieldError, FieldLabel, Input, toast } from "@odentia/ui"
import { ConfirmDialog, DetailDrawer, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { type ReactNode, useState } from "react"
import { invalidateAppointmentQueries } from "../../lib/agenda"
import { apiFetch } from "../../lib/api"
import { fetchMyProfessionalProfile, saveProfessionalProfileApi } from "../../lib/encounters"
import { alsoWords, type HomeTextContext, waitingText } from "../../lib/home"
import { createReorderDrafts } from "../../lib/inventory"
import { activeOrgLocale } from "../../lib/locale"
import { useOrgProfile } from "../../lib/org"
import type { WaitingPromotion, WaitingRow } from "../../lib/workspace"
import { productUi } from "../../product/product-ui"
import { useAppointmentVisitStatus } from "../agenda/arrival"
import { openAppointmentAnywhere, openBookingAnywhere } from "../agenda/schedule-host"
import { useAttendAppointment } from "../patient/new-encounter-button"
import { WriteToPersonDialog } from "../write-to-person"

type RowOf<K extends WaitingRow["kind"]> = Extract<WaitingRow, { kind: K }>

const ACTION = "min-h-11 sm:min-h-9"

/** Lo demás de esta persona que le toca a quien mira: se resuelve sin salir del panel. */
export function AlsoList({ rows, context, onRun }: { rows: WaitingRow[]; context: HomeTextContext; onRun: (row: WaitingRow) => void }) {
  if (rows.length === 0) return null
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => {
        const text = waitingText(row, context)
        const label = row.kind === "task" ? "Hecha" : text.action
        return (
          <li key={`${row.kind}-${alsoWords(row)}`} className="flex items-center gap-3 rounded-xl bg-warning/10 p-3 text-sm">
            <span className="min-w-0 flex-1">
              <strong className="font-bold">También:</strong> {(text.ask ?? text.title).replace(/^./, (first) => first.toLowerCase())}.
            </span>
            {label ? (
              <Button type="button" size="sm" variant="secondary" className="min-h-11 shrink-0 sm:min-h-8" aria-label={`${label}: ${text.title}`} onClick={() => onRun(row)}>
                {label}
              </Button>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

/** «¿Vino?»: una sola pregunta. Quien atiende registra la atención; los demás dicen si no vino. */
export function VisitPanel({
  row,
  also,
  context,
  canAttend,
  canWrite,
  onClose,
  onChanged,
}: {
  row: RowOf<"unclosed">
  also: ReactNode
  context: HomeTextContext
  canAttend: boolean
  canWrite: boolean
  onClose: () => void
  onChanged: () => void
}) {
  const text = waitingText(row, context)
  const attend = useAttendAppointment()
  const status = useAppointmentVisitStatus()
  const [noShow, setNoShow] = useState(false)
  return (
    <DetailDrawer
      open
      title={row.patientName}
      description={[text.ask].filter(Boolean).join(" · ") || undefined}
      onClose={onClose}
      actions={
        noShow ? (
          canWrite ? (
            <Button type="button" className={ACTION} onClick={() => openBookingAnywhere({ patient: { id: row.patientId, name: row.patientName }, lockedPatient: true })}>
              Reagendar
            </Button>
          ) : undefined
        ) : (
          <div className="flex w-full flex-col gap-2">
            <p className="text-sm font-bold">¿Vino a su cita?</p>
            <div className="flex flex-wrap justify-end gap-2">
              {canWrite ? (
                <Button
                  type="button"
                  variant="secondary"
                  className={ACTION}
                  disabled={status.isPending}
                  onClick={() =>
                    status.mutate(
                      { id: row.id, status: "no_asistio" },
                      {
                        onSuccess: () => {
                          setNoShow(true)
                          onChanged()
                        },
                      },
                    )
                  }
                >
                  {status.isPending ? "Guardando…" : "No vino"}
                </Button>
              ) : null}
              {canAttend ? (
                <Button
                  type="button"
                  className={ACTION}
                  disabled={attend.isPending}
                  onClick={() =>
                    attend.mutate({
                      patientId: row.patientId,
                      appointment: { id: row.id, professionalUserId: row.professionalUserId, professionalName: row.professionalName ?? "otro profesional" },
                    })
                  }
                >
                  Sí, registrar la atención
                </Button>
              ) : null}
            </div>
            {!canAttend && row.professionalName ? (
              <p className="text-[13px] text-muted-foreground">Si vino, la registra quien atendió: a {row.professionalName} también le aparece en «Te espera».</p>
            ) : null}
          </div>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {noShow ? <p role="status" className="text-sm">Quedó marcada como que no vino. Si quiere otra fecha, puedes reagendarla.</p> : <p className="text-sm">Mientras no se cierre, no cuenta como atendida ni como falta.</p>}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
          {row.serviceName ? (
            <>
              <dt className="text-muted-foreground">Servicio</dt>
              <dd className="font-semibold">{row.serviceName}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Sede</dt>
          <dd className="font-semibold">{row.branchName}</dd>
          {row.professionalName ? (
            <>
              <dt className="text-muted-foreground">Con</dt>
              <dd className="font-semibold">{row.professionalName}</dd>
            </>
          ) : null}
        </dl>
        {also}
      </div>
    </DetailDrawer>
  )
}

/** «Llamar»: el número y «¿Qué te dijo?», que anota lo que dijo sin salir de Inicio. */
export function CallPanel({
  row,
  also,
  context,
  canWrite,
  onClose,
  onChanged,
}: {
  row: RowOf<"unconfirmed">
  also: ReactNode
  context: HomeTextContext
  canWrite: boolean
  onClose: () => void
  onChanged: () => void
}) {
  const queryClient = useQueryClient()
  const text = waitingText(row, context)
  const status = useAppointmentVisitStatus()
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [writing, setWriting] = useState(false)
  const contact = useQuery({
    queryKey: ["patient-person", row.patientId],
    queryFn: () => apiFetch<{ data: { personId: string } }>(`/api/patients/${row.patientId}/person`),
    retry: false,
  })
  const cancel = useMutation({
    retry: false,
    // Lo dijo por teléfono: ya lo sabe, no hace falta otro mensaje.
    mutationFn: () => apiFetch(`/api/appointments/${row.id}/status`, { method: "POST", body: JSON.stringify({ status: "cancelada", cancelReason: "paciente", notice: false }) }),
    onSuccess: async () => {
      toast.success(`Cita de ${row.patientName}: cancelada`)
      setConfirmCancel(false)
      await invalidateAppointmentQueries(queryClient)
      onChanged()
      onClose()
    },
  })
  return (
    <>
      <DetailDrawer
        open
        title={row.patientName}
        description={[row.serviceName, row.branchName].filter(Boolean).join(" · ") || undefined}
        onClose={onClose}
        actions={
          canWrite ? (
            <div className="flex w-full flex-col gap-2">
              <p className="text-sm font-bold">¿Qué te dijo?</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  className={ACTION}
                  disabled={status.isPending}
                  onClick={() =>
                    status.mutate(
                      { id: row.id, status: "confirmada" },
                      {
                        onSuccess: () => {
                          onChanged()
                          onClose()
                        },
                      },
                    )
                  }
                >
                  {status.isPending ? "Guardando…" : "Confirmó por teléfono"}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  className={ACTION}
                  onClick={() => {
                    openAppointmentAnywhere(row.id, "move")
                    onClose()
                  }}
                >
                  Quiere otra hora
                </Button>
                <Button type="button" variant="secondary" className={ACTION} onClick={() => setConfirmCancel(true)}>
                  No viene
                </Button>
              </div>
              <p className="text-[13px] text-muted-foreground">
                ¿No contestó?{" "}
                {contact.data ? (
                  <Button type="button" variant="link" className="h-auto min-h-0 p-0 text-[13px] font-semibold" onClick={() => setWriting(true)}>
                    Escríbele
                  </Button>
                ) : (
                  "Escríbele"
                )}{" "}
                o vuelve a intentarlo: seguirá en la lista.
              </p>
            </div>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm">{text.ask}.</p>
          {row.phone ? (
            <a href={`tel:${row.phone.replace(/\s+/g, "")}`} className={cn(buttonVariants(), "min-h-11")} aria-label={`Llamar: ${row.patientName}`}>
              Llamar al {row.phone}
            </a>
          ) : (
            <p className="text-sm text-muted-foreground">No tiene teléfono guardado.</p>
          )}
          {also}
        </div>
      </DetailDrawer>
      <ConfirmDialog
        open={confirmCancel}
        title="Cancelar la cita"
        description={`La cita de ${row.patientName} queda cancelada y su hora vuelve a estar libre. No se le envía ningún mensaje: ya lo sabe.`}
        confirmLabel="Cancelar la cita"
        cancelLabel="Volver"
        pending={cancel.isPending}
        error={cancel.error ? submitErrorMessage(cancel.error) : null}
        onClose={() => setConfirmCancel(false)}
        onConfirm={() => cancel.mutate()}
      />
      {contact.data ? <WriteToPersonDialog open={writing} onClose={() => setWriting(false)} people={[{ contactId: contact.data.data.personId, displayName: row.patientName }]} /> : null}
    </>
  )
}

const HAS_WORDS: Record<string, string> = { reason: "Motivo", diagnosis: "Diagnóstico", evolution: "Evolución" }

/** Una atención de otro día: qué ya tiene y qué falta, «Continuar» primero y anular al final. */
export function EncounterPanel({
  row,
  also,
  context,
  canVoid,
  onClose,
  onVoid,
  onChanged,
}: {
  row: RowOf<"staleEncounter">
  also: ReactNode
  context: HomeTextContext
  canVoid: boolean
  onClose: () => void
  onVoid: () => void
  onChanged: () => void
}) {
  const queryClient = useQueryClient()
  const text = waitingText(row, context)
  const orgProfile = useOrgProfile().data
  const needsLicense = row.missing.includes("signature")
  const has = Object.keys(HAS_WORDS).filter((key) => !row.missing.includes(key)).map((key) => HAS_WORDS[key] as string)
  const [number, setNumber] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const profile = useQuery({
    queryKey: ["professional-profile", "me"],
    queryFn: () => fetchMyProfessionalProfile(),
    enabled: needsLicense,
    retry: false,
  })
  const save = useMutation({
    retry: false,
    mutationFn: () => {
      // Lo que ya tiene el perfil y, si falta, lo que propone el país: se escribe una vez.
      const current = profile.data?.data
      const suggested = productUi().country.professional(orgProfile?.countryCode)
      return saveProfessionalProfileApi("me", {
        professionalTitle: current?.professionalTitle || suggested?.title || "",
        registrationBody: current?.registrationBody || suggested?.registrationBody || "",
        registrationNumber: number.trim(),
      })
    },
    onSuccess: async () => {
      setSaved(true)
      setError(null)
      await queryClient.invalidateQueries({ queryKey: ["professional-profile"] })
      onChanged()
    },
    onError: (cause) => setError(submitErrorMessage(cause)),
  })
  return (
    <DetailDrawer
      open
      title={row.patientName}
      description={text.ask ?? undefined}
      onClose={onClose}
      actions={
        <div className="flex w-full flex-col gap-2">
          <Link
            to="/patients/$patientId/encounters/$encounterId"
            params={{ patientId: row.patientId, encounterId: row.id }}
            className={cn(buttonVariants(), "min-h-11")}
          >
            Continuar la atención
          </Link>
          {canVoid ? (
            <p className="text-[13px] text-muted-foreground">
              ¿No se hizo?{" "}
              <Button type="button" variant="link" className="h-auto min-h-0 p-0 text-[13px] font-semibold text-destructive" onClick={onVoid}>
                Anularla con motivo
              </Button>
            </p>
          ) : null}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm">Se empezó y no se firmó. Mientras siga abierta no puedes abrirle otra atención.</p>
        {has.length > 0 ? (
          <div className="rounded-xl border p-3 text-sm">
            <p className="text-[13px] font-bold text-muted-foreground">Lo que ya tiene</p>
            <p>{has.join(", ")}.</p>
          </div>
        ) : null}
        {needsLicense && !saved ? (
          <form
            className="flex flex-col gap-1.5 rounded-xl bg-warning/10 p-3"
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              if (!number.trim()) {
                setError("Escribe tu número de colegiatura.")
                return
              }
              save.mutate()
            }}
          >
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="panel-colegiatura">Falta tu colegiatura</FieldLabel>
              <div className="flex gap-2">
                <Input
                  id="panel-colegiatura"
                  value={number}
                  maxLength={20}
                  autoComplete="off"
                  placeholder="N.º de colegiatura"
                  aria-invalid={error ? true : undefined}
                  onChange={(event) => {
                    setNumber(event.target.value)
                    setError(null)
                  }}
                />
                <Button type="submit" variant="secondary" className={cn(ACTION, "shrink-0")} disabled={save.isPending}>
                  {save.isPending ? "Guardando…" : "Guardar"}
                </Button>
              </div>
              {error ? <FieldError>{error}</FieldError> : null}
            </Field>
            <p className="text-[13px]">Se escribe una vez y sirve para todas tus atenciones.</p>
          </form>
        ) : null}
        {saved ? <p role="status" className="text-sm">Listo: tu colegiatura quedó guardada para todas tus atenciones.</p> : null}
        {also}
      </div>
    </DetailDrawer>
  )
}

/** Un documento repetido o un representante por confirmar: nada se une ni se vincula solo. */
export function DuplicatePanel({
  row,
  also,
  context,
  pending,
  error,
  onConfirm,
  onDiscard,
  onReviewed,
  compareLink,
  onClose,
}: {
  row: RowOf<"possibleDuplicate">
  also: ReactNode
  context: HomeTextContext
  pending: boolean
  error: string | null
  onConfirm?: () => void
  onDiscard?: () => void
  onReviewed?: () => void
  /** La ficha entera, para comparar: es lo único que lleva a otra pantalla. */
  compareLink: ReactNode
  onClose: () => void
}) {
  const text = waitingText(row, context)
  return (
    <DetailDrawer
      open
      title={text.title}
      description={text.ask ?? undefined}
      onClose={onClose}
      actions={
        <div className="flex w-full flex-wrap justify-end gap-2">
          {compareLink}
          {row.source === "representante" && onDiscard ? (
            <Button type="button" variant="secondary" className={ACTION} disabled={pending} onClick={onDiscard}>
              No es representante
            </Button>
          ) : null}
          {row.source === "representante" && onConfirm ? (
            <Button type="button" className={ACTION} disabled={pending} onClick={onConfirm}>
              Confirmar
            </Button>
          ) : null}
          {row.source === "registro" && onDiscard ? (
            <Button type="button" variant="secondary" className={ACTION} disabled={pending} onClick={onDiscard}>
              Descartar
            </Button>
          ) : null}
          {row.source === "enlace" && onReviewed ? (
            <Button type="button" variant="secondary" className={ACTION} disabled={pending} onClick={onReviewed}>
              Revisada
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm">{row.detail || "Nada se une ni se vincula solo."}</p>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {also}
      </div>
    </DetailDrawer>
  )
}

/** El inventario de una sede: lo que falta y «Pedir lo que falta». Queda un borrador por proveedor. */
export function InventoryPanel({ row, onClose, onChanged }: { row: RowOf<"inventory">; onClose: () => void; onChanged: () => void }) {
  const queryClient = useQueryClient()
  const [done, setDone] = useState<string | null>(null)
  const reorder = useMutation({
    retry: false,
    mutationFn: () => createReorderDrafts(row.branchId),
    onSuccess: (result) => {
      const drafts = result.drafts.length
      const loose = result.withoutSupplier.length
      setDone(
        drafts === 0
          ? loose > 0
            ? "Lo que falta no tiene proveedor: elígelo en la compra."
            : "Lo que falta ya está en un borrador."
          : `${drafts === 1 ? "Quedó 1 borrador" : `Quedaron ${drafts} borradores`} de compra${loose > 0 ? `; ${loose === 1 ? "1 producto no tiene" : `${loose} productos no tienen`} proveedor` : ""}. Revísalos y confírmalos en Compras.`,
      )
      void queryClient.invalidateQueries({ queryKey: ["inventory"] })
      onChanged()
    },
  })
  const expiredDay = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(activeOrgLocale(), { day: "numeric", month: "short", timeZone: "UTC" }).replace(".", "")
  return (
    <DetailDrawer
      open
      title={`Inventario de ${row.branchName}`}
      description="Queda un borrador de compra por proveedor. Lo confirmas tú en Compras."
      onClose={onClose}
      actions={
        done ? (
          <Link to="/inventory" search={{ tab: "compras", branch: row.branchId, ver: "borradores" }} className={cn(buttonVariants(), ACTION)}>
            Ver los borradores
          </Link>
        ) : row.needed > 0 ? (
          <Button type="button" className={ACTION} disabled={reorder.isPending} onClick={() => reorder.mutate()}>
            {reorder.isPending ? "Guardando…" : "Pedir lo que falta"}
          </Button>
        ) : (
          <Link to="/inventory" search={{ branch: row.branchId, ver: "por_vencer" }} className={cn(buttonVariants({ variant: "secondary" }), ACTION)}>
            Ver lo vencido
          </Link>
        )
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        {done ? <p role="status">{done}</p> : null}
        {reorder.error ? (
          <p role="alert" className="text-destructive">
            {submitErrorMessage(reorder.error)}
          </p>
        ) : null}
        {row.neededNames.length > 0 ? (
          <div>
            <p className="font-bold">Hacen falta</p>
            <p>
              {row.neededNames.join(", ")}
              {row.needed > row.neededNames.length ? ` y ${row.needed - row.neededNames.length} más` : ""}.
            </p>
          </div>
        ) : null}
        {row.expired.length > 0 ? (
          <div>
            <p className="font-bold">Vencidos</p>
            <ul className="flex flex-col gap-0.5">
              {row.expired.map((item) => (
                <li key={`${item.productName}-${item.expiresAt}`}>
                  {item.productName}: venció el {expiredDay(item.expiresAt)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </DetailDrawer>
  )
}

/** Muestra el texto como lo leerá quien lo revisa: «[persona]» en vez de «{{persona}}». */
const shownText = (body: string) => body.replace(/\{\{([a-z_]+)\}\}/g, "[$1]")

/**
 * Los avisos que WhatsApp clasificó como publicidad: lo que eso significa y el
 * texto solo de aviso listo para pedir otra revisión. WhatsApp decide: la pantalla
 * nunca lo da por hecho, y mientras tanto sigue saliendo el texto actual.
 */
export function PromotionPanel({ items, onClose, onChanged }: { items: WaitingPromotion[]; onClose: () => void; onChanged: () => void }) {
  const queryClient = useQueryClient()
  const ready = items.filter((item) => item.noticeText && item.connectionId && !item.inReview)
  const [done, setDone] = useState(false)
  const send = useMutation({
    retry: false,
    mutationFn: async () => {
      for (const item of ready) {
        await apiFetch(`/api/channels/connections/${item.connectionId}/messages/${encodeURIComponent(item.messageId)}/text`, {
          method: "PUT",
          body: JSON.stringify({ body: item.noticeText }),
        })
      }
    },
    onSuccess: () => {
      setDone(true)
      void queryClient.invalidateQueries({ queryKey: ["clinic-messages"] })
      onChanged()
    },
  })
  return (
    <DetailDrawer
      open
      title={items.length === 1 ? "1 mensaje automático no le llega a todos" : `${items.length} mensajes automáticos no le llegan a todos`}
      description="Mensajes automáticos de WhatsApp"
      onClose={onClose}
      actions={
        !done && ready.length > 0 ? (
          <div className="flex w-full flex-col gap-2">
            <Button type="button" className={ACTION} disabled={send.isPending} onClick={() => send.mutate()}>
              {send.isPending ? "Enviando…" : "Enviar a revisión de WhatsApp"}
            </Button>
            <p className="text-[13px] text-muted-foreground">WhatsApp decide y puede tardar hasta un día. Mientras tanto sigue saliendo el texto actual.</p>
          </div>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p>WhatsApp los clasificó como publicidad, así que quien no aceptó novedades deja de recibirlos. Te dejamos un texto solo de aviso.</p>
        {done ? (
          <p role="status" className="font-semibold">
            Enviado a revisión. Si WhatsApp no lo acepta como aviso, se dice aquí.
          </p>
        ) : null}
        {send.error ? (
          <p role="alert" className="text-destructive">
            {submitErrorMessage(send.error)}
          </p>
        ) : null}
        <ul className="flex flex-col divide-y">
          {items.map((item) => (
            <li key={item.messageId} className="flex flex-col gap-1 py-2.5">
              <span className="font-bold">{item.title}</span>
              {item.inReview ? <span className="text-[13px] text-muted-foreground">En revisión de WhatsApp.</span> : null}
              {item.noticeText ? <span className="text-[13px] text-muted-foreground">Texto nuevo: «{shownText(item.noticeText)}»</span> : <span className="text-[13px] text-muted-foreground">Es un mensaje propio de la clínica: el texto lo escribes tú.</span>}
              <Link to="/settings/integrations/whatsapp" search={{ mensaje: item.messageId }} className="inline-flex min-h-11 items-center self-start text-[13px] font-semibold text-primary hover:underline sm:min-h-8">
                {item.noticeText ? "Editar" : "Cambiar el texto"}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </DetailDrawer>
  )
}
