import { documentText, formatMoney } from "@odentia/clinical"
import { Button, Field, FieldDescription, FieldLabel, toast } from "@odentia/ui"
import { ConfirmDialog, DetailDrawer } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ComponentProps, lazy, Suspense, useEffect, useId, useState } from "react"
import { useActiveBranch } from "../../lib/active-branch"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { financeErrorMessage } from "../../lib/finance"
import {
  collectApi,
  type CollectResultBody,
  fetchPatientAccount3,
  invalidatePatientAccount,
  useOrgFinanceProfile,
} from "../../lib/finance-collect"
import type { PatientFull } from "../../lib/patients"
import { ChoiceSelect } from "../ui/choice-select"

// El cobro pesa: se trae al pulsar, para no cargarlo con el Resumen.
const CollectDrawer = lazy(() => import("../finance/collect-drawer").then((m) => ({ default: m.CollectDrawer })))
const TicketView = lazy(() => import("../finance/ticket-view").then((m) => ({ default: m.TicketView })))

/**
 * Aplicar lo que tiene a favor mueve saldo y queda como un ticket: siempre se
 * confirma, con el importe y la sede a la vista. No entra dinero nuevo.
 * Ninguna dirección lo ejecuta sola: solo este botón.
 */
export function ApplyCreditDialog({
  open,
  patientId,
  patientName,
  amountText,
  branchId,
  branchName,
  onClose,
  onApplied,
}: {
  open: boolean
  patientId: string
  patientName: string
  amountText: string
  branchId: string
  branchName: string
  onClose: () => void
  onApplied: (result: CollectResultBody) => void
}) {
  // La misma clave mientras el diálogo sigue abierto: un reintento tras un corte no aplica dos veces.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const apply = useMutation({
    mutationFn: () => collectApi(patientId, { branchId, requestId }),
    onSuccess: (result) => {
      onApplied(result.data)
      onClose()
    },
  })
  const { reset } = apply
  useEffect(() => {
    if (!open) return
    setRequestId(crypto.randomUUID())
    reset()
  }, [open, reset])
  return (
    <ConfirmDialog
      open={open}
      title="¿Aplicar lo que tiene a favor?"
      description={`Se aplican ${amountText} a lo que debe ${patientName}. No entra dinero nuevo: queda como un ticket${branchName ? ` en ${branchName}` : ""}.`}
      confirmLabel={`Aplicar ${amountText}`}
      variant="default"
      pending={apply.isPending}
      error={apply.error ? financeErrorMessage(apply.error) : null}
      onClose={onClose}
      onConfirm={() => apply.mutate()}
    />
  )
}

/**
 * «Cobrar» ahí mismo: el mismo cajón y el mismo ticket de la pestaña Cobros, sin
 * cambiar de pestaña. Si lo que tiene a favor cubre lo que debe, el botón lo dice
 * y confirma. Solo para quien puede cobrar.
 */
export function CollectButton(props: CollectButtonProps) {
  const canWrite = usePermission("finance.write")
  return canWrite ? <CollectAction {...props} /> : null
}

interface CollectButtonProps {
  patientId: string
  patientName: string
  size?: ComponentProps<typeof Button>["size"]
  variant?: ComponentProps<typeof Button>["variant"]
}

function CollectAction({ patientId, patientName, size, variant }: CollectButtonProps) {
  const uid = useId()
  const queryClient = useQueryClient()
  const sede = useActiveBranch()
  const profile = useOrgFinanceProfile()
  const prof = profile.data?.data ?? null
  const account = useQuery({
    queryKey: ["patient-account3", patientId],
    queryFn: () => fetchPatientAccount3(patientId),
  })
  // La ficha ya cargó al paciente: misma clave, sin otra petición.
  const patient = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
  })
  const [pickedBranch, setPickedBranch] = useState("")
  const [asking, setAsking] = useState<"cobrar" | "aplicar" | null>(null)
  const [collecting, setCollecting] = useState(false)
  const [applying, setApplying] = useState(false)
  const [ticket, setTicket] = useState<CollectResultBody | null>(null)

  const branchId = sede.effectiveId ?? pickedBranch
  const branchName = sede.branches.find((item) => item.id === branchId)?.name ?? ""
  const orgRow = account.data?.data.byCurrency.find((row) => row.currency === prof?.currency)
  const covered = (orgRow?.porCobrar ?? 0) > 0 && orgRow?.saldo === 0
  // Sin deuda, lo único que se puede cobrar es un adelanto: lo mismo que dice Cobros.
  const collectLabel = account.data && (orgRow?.saldo ?? 0) <= 0 ? "Cobrar un adelanto" : "Cobrar"
  const person = patient.data?.data.patient
  const ready = Boolean(prof && account.data)

  const begin = (action: "cobrar" | "aplicar") => (action === "aplicar" ? setApplying(true) : setCollecting(true))
  const onClick = () => {
    const action = covered ? "aplicar" : "cobrar"
    // Solo se pregunta la sede si no hay ninguna activa.
    if (!branchId) setAsking(action)
    else begin(action)
  }
  const changed = () => invalidatePatientAccount(queryClient, patientId)

  return (
    <>
      <Button type="button" size={size} variant={variant} disabled={!ready} onClick={onClick}>
        {covered ? "Aplicar lo que tiene a favor" : collectLabel}
      </Button>
      <ConfirmDialog
        open={asking !== null}
        title="¿En qué sede estás cobrando?"
        description="El cobro entra a la caja de esa sede."
        confirmLabel="Seguir"
        variant="default"
        confirmDisabled={!pickedBranch}
        onClose={() => setAsking(null)}
        onConfirm={() => {
          sede.choose(pickedBranch)
          if (asking) begin(asking)
          setAsking(null)
        }}
      >
        <Field>
          <FieldLabel htmlFor={`${uid}-sede`}>Sede</FieldLabel>
          <ChoiceSelect
            id={`${uid}-sede`}
            value={pickedBranch}
            placeholder="Elige la sede"
            onChange={(event) => setPickedBranch(event.target.value)}
          >
            {sede.branches.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </ChoiceSelect>
          <FieldDescription>Queda como tu sede activa.</FieldDescription>
        </Field>
      </ConfirmDialog>
      {prof ? (
        <>
          <ApplyCreditDialog
            open={applying}
            patientId={patientId}
            patientName={patientName}
            amountText={formatMoney(orgRow?.porCobrar ?? 0, prof.currency, prof.locale)}
            branchId={branchId}
            branchName={branchName}
            onClose={() => setApplying(false)}
            onApplied={(result) => {
              changed()
              toast.success(
                result.remainingCents > 0
                  ? `Se aplicaron ${formatMoney(result.creditAppliedCents, prof.currency, prof.locale)}. Falta: ${formatMoney(result.remainingCents, prof.currency, prof.locale)}.`
                  : `Se aplicaron ${formatMoney(result.creditAppliedCents, prof.currency, prof.locale)}. Ya no debe nada.`,
              )
            }}
          />
          {collecting ? (
            <Suspense fallback={null}>
              <CollectDrawer
                patientId={patientId}
                patientName={patientName}
                patientDocument={person?.docNumber ? documentText(person.docType, person.docNumber) : null}
                patientSex={person?.sex}
                branchId={branchId}
                branchName={branchName}
                currency={prof.currency}
                locale={prof.locale}
                open
                onClose={() => setCollecting(false)}
                onCollected={(result) => {
                  changed()
                  setTicket(result)
                }}
              />
            </Suspense>
          ) : null}
          <DetailDrawer open={ticket !== null} onClose={() => setTicket(null)} title="Cobro" showClose={false}>
            {ticket ? (
              <Suspense fallback={null}>
                <TicketView
                  key={ticket.ticket.id}
                  ticket={ticket.ticket}
                  remainingCents={ticket.remainingCents}
                  receipt={ticket.receipt ?? null}
                  patientName={patientName}
                  branchName={branchName}
                  locale={prof.locale}
                  timeZone={prof.timezone}
                  inAccount
                  onDone={() => setTicket(null)}
                  onCollect={() => {
                    setTicket(null)
                    setCollecting(true)
                  }}
                  onChanged={changed}
                />
              </Suspense>
            ) : null}
          </DetailDrawer>
        </>
      ) : null}
    </>
  )
}
