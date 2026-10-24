import { MEDICAL_LEAVE_MAX_DAYS, medicalLeaveWords } from "@odentia/clinical"
import {
  Button,
  buttonVariants,
  Checkbox,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  Textarea,
  toast,
} from "@odentia/ui"
import { DatePickerButton, FormDrawer, regionToday } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useId, useState } from "react"
import { formatDate, mutationMessage } from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import {
  cancelMedicalLeaveApi,
  createMedicalLeaveApi,
  type MedicalLeave,
} from "../../lib/medical-leaves"
import { DiagnosisSearch } from "./diagnosis-search"
import { HealthDocumentSendDrawer } from "./health-document-send"

/** Las claves que se refrescan cuando cambia un descanso médico. */
export const medicalLeaveKeys = (patientId: string) => [["medical-leaves", patientId]] as const

/**
 * Emitir un descanso médico (issue 229, decisión 8): desde qué día y cuántos,
 * las indicaciones y, solo si la persona lo autoriza, el diagnóstico. Queda
 * firmado con el perfil profesional; no se corrige: se anula con motivo.
 */
export function NewMedicalLeaveDrawer({
  open,
  patientId,
  encounterId,
  defaultDiagnosisCode,
  defaultDiagnosisSystem,
  defaultDays,
  defaultStartsOn,
  onClose,
  onCreated,
}: {
  open: boolean
  patientId: string
  encounterId?: string
  /** El diagnóstico de la atención, ya puesto si la persona autoriza que figure. */
  defaultDiagnosisCode?: string
  defaultDiagnosisSystem?: string
  /** Lo que dictó el médico (Clío, issue 229): los días y desde cuándo. */
  defaultDays?: number
  defaultStartsOn?: string
  onClose: () => void
  onCreated: (leave: MedicalLeave) => void
}) {
  const uid = useId()
  const queryClient = useQueryClient()
  const [startsOn, setStartsOn] = useState(() => defaultStartsOn ?? regionToday())
  const [days, setDays] = useState(defaultDays ? String(defaultDays) : "")
  const [notes, setNotes] = useState("")
  const [showDiagnosis, setShowDiagnosis] = useState(false)
  const [diagnosisCode, setDiagnosisCode] = useState(defaultDiagnosisCode ?? "")
  const [diagnosisSystem, setDiagnosisSystem] = useState<string | null>(
    defaultDiagnosisSystem ?? null,
  )
  const [error, setError] = useState<string | null>(null)
  const count = Number(days)
  const validDays = Number.isInteger(count) && count >= 1 && count <= MEDICAL_LEAVE_MAX_DAYS
  const create = useMutation({
    mutationFn: () =>
      createMedicalLeaveApi(patientId, {
        encounterId: encounterId ?? null,
        startsOn,
        days: count,
        showDiagnosis,
        diagnosisCode: showDiagnosis && diagnosisCode ? diagnosisCode : null,
        diagnosisSystem: showDiagnosis && diagnosisCode ? diagnosisSystem : null,
        notes: notes.trim() || null,
      }),
    onSuccess: (result) => {
      toast.success("Descanso médico emitido.")
      for (const queryKey of medicalLeaveKeys(patientId))
        void queryClient.invalidateQueries({ queryKey })
      onCreated(result.data)
    },
    onError: (mutationError) => setError(mutationMessage(mutationError)),
  })
  return (
    <FormDrawer
      open={open}
      title="Emitir descanso médico"
      description="Queda firmado con tu perfil profesional. No se corrige: se anula con motivo."
      error={open ? error : null}
      isSubmitting={create.isPending}
      submitLabel="Emitir descanso médico"
      onClose={() => {
        if (!create.isPending) onClose()
      }}
      onSubmit={(event) => {
        event.preventDefault()
        if (!validDays) {
          setError(`Escribe los días de descanso: de 1 a ${MEDICAL_LEAVE_MAX_DAYS}.`)
          return
        }
        if (showDiagnosis && !diagnosisCode) {
          setError("Elige el diagnóstico o desmarca que figure.")
          return
        }
        setError(null)
        create.mutate()
      }}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-4">
          <Field className="w-auto">
            <FieldLabel htmlFor={`${uid}-leave-start`}>Desde</FieldLabel>
            <DatePickerButton
              id={`${uid}-leave-start`}
              className="w-56"
              value={startsOn}
              onChange={setStartsOn}
            />
          </Field>
          <Field className="w-auto">
            <FieldLabel htmlFor={`${uid}-leave-days`}>Días</FieldLabel>
            <Input
              id={`${uid}-leave-days`}
              className="w-24"
              inputMode="numeric"
              maxLength={3}
              value={days}
              onChange={(event) => setDays(event.target.value.replace(/\D/g, ""))}
            />
          </Field>
        </div>
        {validDays && startsOn ? (
          <p className="text-sm text-muted-foreground">{medicalLeaveWords(startsOn, count)}.</p>
        ) : null}
        <Field>
          <FieldLabel htmlFor={`${uid}-leave-notes`}>Indicaciones (opcional)</FieldLabel>
          <Textarea
            id={`${uid}-leave-notes`}
            maxLength={2000}
            placeholder="Por ejemplo, reposo relativo, sin esfuerzo físico"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </Field>
        <Field orientation="horizontal">
          <Checkbox
            id={`${uid}-leave-dx`}
            checked={showDiagnosis}
            onCheckedChange={(checked: boolean) => setShowDiagnosis(checked === true)}
          />
          <FieldLabel htmlFor={`${uid}-leave-dx`}>
            La persona autoriza que el diagnóstico figure
          </FieldLabel>
        </Field>
        {showDiagnosis ? (
          <DiagnosisSearch
            label="Diagnóstico"
            value={diagnosisCode}
            system={diagnosisSystem}
            onChange={(code, _description, system) => {
              setDiagnosisCode(code)
              setDiagnosisSystem(system)
            }}
          />
        ) : (
          <FieldDescription>
            Sin su autorización, el diagnóstico no va en la constancia ni se guarda en ella.
          </FieldDescription>
        )}
      </div>
    </FormDrawer>
  )
}

/** Un descanso médico abierto al lado: lo que dice, imprimir, enviar y anular con motivo. */
export function MedicalLeaveEntry({
  patientId,
  leave,
}: {
  patientId: string
  leave: MedicalLeave
}) {
  const uid = useId()
  const canWrite = usePermission("clinical.write")
  const queryClient = useQueryClient()
  const [cancelling, setCancelling] = useState(false)
  const [sending, setSending] = useState(false)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const cancel = useMutation({
    mutationFn: () => cancelMedicalLeaveApi(patientId, leave.id, { reason: reason.trim() }),
    onSuccess: () => {
      setCancelling(false)
      setReason("")
      setError(null)
      for (const queryKey of medicalLeaveKeys(patientId))
        void queryClient.invalidateQueries({ queryKey })
    },
    onError: (mutationError) => setError(mutationMessage(mutationError)),
  })
  const issued = leave.status === "emitido"
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium">{medicalLeaveWords(leave.startsOn, leave.days)}</p>
      <p className="text-sm text-muted-foreground">
        {leave.showDiagnosis && leave.diagnosisCode
          ? `Con el diagnóstico ${leave.diagnosisCode}: la persona lo autorizó.`
          : "Sin diagnóstico: la persona no autorizó que figure."}
      </p>
      {leave.notes ? <p className="text-sm">{leave.notes}</p> : null}
      {leave.cancelReason ? (
        <p className="text-sm text-muted-foreground">Anulado: {leave.cancelReason}</p>
      ) : null}
      {leave.signerName ? (
        <p className="text-xs text-muted-foreground">
          Emitido el {formatDate(leave.issuedAt)} por {leave.signerName}
          {leave.signerRegistration ? ` · ${leave.signerRegistration}` : ""}
        </p>
      ) : null}
      {error && !cancelling ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {issued ? (
        <div className="flex flex-wrap gap-2">
          <Link
            to="/patients/$patientId/medical-leaves/$leaveId/print"
            params={{ patientId, leaveId: leave.id }}
            target="_blank"
            className={buttonVariants({ size: "sm", variant: "outline" })}
          >
            Imprimir
          </Link>
          {canWrite ? (
            <Button type="button" size="sm" variant="outline" onClick={() => setSending(true)}>
              Enviar a la persona
            </Button>
          ) : null}
          {canWrite ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setError(null)
                setCancelling(true)
              }}
            >
              Anular descanso médico
            </Button>
          ) : null}
        </div>
      ) : null}
      {sending ? (
        <HealthDocumentSendDrawer
          open
          patientId={patientId}
          documentType="medical_leave"
          documentId={leave.id}
          onClose={() => setSending(false)}
        />
      ) : null}
      <FormDrawer
        dock={false}
        open={cancelling}
        title="Anular descanso médico"
        description="La constancia conserva su contenido original y el motivo de anulación."
        error={cancelling ? error : null}
        isSubmitting={cancel.isPending}
        submitLabel="Anular descanso médico"
        onClose={() => {
          if (!cancel.isPending) setCancelling(false)
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!reason.trim()) {
            setError("Indica el motivo de la anulación.")
            return
          }
          cancel.mutate()
        }}
      >
        <Field>
          <FieldLabel htmlFor={`${uid}-leave-cancel`}>Motivo de anulación</FieldLabel>
          <Textarea
            id={`${uid}-leave-cancel`}
            maxLength={2000}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
      </FormDrawer>
    </div>
  )
}
