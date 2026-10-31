import { MEDICAL_LEAVE_MAX_DAYS, medicalLeaveWords } from "@odentia/clinical"
import { FieldDescription, Input, toast } from "@odentia/ui"
import {
  DatePickerButton,
  FormDrawer,
  regionToday,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { z } from "zod"
import { createMedicalLeaveApi, type MedicalLeave } from "../../lib/medical-leaves"
import { DiagnosisSearch } from "./diagnosis-search"

/** Las claves que se refrescan cuando cambia un descanso médico. */
export const medicalLeaveKeys = (patientId: string) => [["medical-leaves", patientId]] as const

/** Los días escritos, si son un número válido de días de descanso. */
function leaveDays(value: string): number | null {
  const count = Number(value)
  return value !== "" && Number.isInteger(count) && count >= 1 && count <= MEDICAL_LEAVE_MAX_DAYS
    ? count
    : null
}

/** Los mismos límites que `POST /medical-leaves`. */
const leaveSchema = z
  .object({
    startsOn: z.string().min(1, "Elige el primer día del descanso."),
    days: z
      .string()
      .refine(
        (value) => leaveDays(value) !== null,
        `Escribe los días de descanso: de 1 a ${MEDICAL_LEAVE_MAX_DAYS}.`,
      ),
    notes: z.string().max(2000, "Las indicaciones tienen como mucho 2000 caracteres."),
    showDiagnosis: z.boolean(),
    diagnosisCode: z.string(),
    diagnosisSystem: z.string().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.showDiagnosis && !value.diagnosisCode)
      ctx.addIssue({
        code: "custom",
        path: ["diagnosisCode"],
        message: "Elige el diagnóstico o desmarca que figure.",
      })
  })

const reasonSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Indica el motivo de la anulación.")
    .max(2000, "El motivo tiene como mucho 2000 caracteres."),
})

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
  const queryClient = useQueryClient()
  const create = useMutation({
    mutationFn: (body: Parameters<typeof createMedicalLeaveApi>[1]) =>
      createMedicalLeaveApi(patientId, body),
  })
  const form = useAppForm({
    defaultValues: {
      startsOn: defaultStartsOn ?? regionToday(),
      days: defaultDays ? String(defaultDays) : "",
      notes: "",
      showDiagnosis: false,
      diagnosisCode: defaultDiagnosisCode ?? "",
      diagnosisSystem: defaultDiagnosisSystem ?? (null as string | null),
    },
    validators: { onSubmit: leaveSchema },
    onSubmit: async ({ value }) => {
      const withDiagnosis = value.showDiagnosis && value.diagnosisCode !== ""
      const result = await create.mutateAsync({
        encounterId: encounterId ?? null,
        startsOn: value.startsOn,
        days: Number(value.days),
        showDiagnosis: value.showDiagnosis,
        diagnosisCode: withDiagnosis ? value.diagnosisCode : null,
        diagnosisSystem: withDiagnosis ? value.diagnosisSystem : null,
        notes: value.notes.trim() || null,
      })
      toast.success("Descanso médico emitido.")
      for (const queryKey of medicalLeaveKeys(patientId))
        void queryClient.invalidateQueries({ queryKey })
      onCreated(result.data)
    },
  })
  const surface = useFormSurface(form)
  const startsOn = useStore(form.store, (state) => state.values.startsOn)
  const count = useStore(form.store, (state) => leaveDays(state.values.days))
  const showDiagnosis = useStore(form.store, (state) => state.values.showDiagnosis)
  return (
    <FormDrawer
      {...surface}
      open={open}
      title="Emitir descanso médico"
      description="Queda firmado con tu perfil profesional. No se corrige: se anula con motivo."
      submitLabel="Emitir descanso médico"
      onClose={() => {
        if (!surface.isSubmitting) onClose()
      }}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-4">
          <form.AppField name="startsOn">
            {(field) => (
              <field.Control label="Desde" className="w-auto">
                {(control) => (
                  <DatePickerButton
                    {...control.props}
                    className="w-56"
                    value={field.state.value}
                    onChange={field.handleChange}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
          <form.AppField name="days">
            {(field) => (
              <field.Control label="Días" className="w-auto">
                {(control) => (
                  <Input
                    {...control.props}
                    className="w-24"
                    inputMode="numeric"
                    maxLength={3}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value.replace(/\D/g, ""))}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
        </div>
        {count !== null && startsOn ? (
          <p className="text-sm text-muted-foreground">{medicalLeaveWords(startsOn, count)}.</p>
        ) : null}
        <form.AppField name="notes">
          {(field) => (
            <field.TextareaField
              label="Indicaciones (opcional)"
              maxLength={2000}
              placeholder="Por ejemplo, reposo relativo, sin esfuerzo físico"
            />
          )}
        </form.AppField>
        <form.AppField name="showDiagnosis">
          {(field) => <field.CheckboxField label="La persona autoriza que el diagnóstico figure" />}
        </form.AppField>
        {showDiagnosis ? (
          <form.AppField name="diagnosisCode">
            {(field) => (
              <field.Control label="Diagnóstico">
                {(control) => (
                  <DiagnosisSearch
                    id={control.id}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    value={field.state.value}
                    system={form.getFieldValue("diagnosisSystem")}
                    onChange={(code, _description, system) => {
                      field.handleChange(code)
                      form.setFieldValue("diagnosisSystem", system)
                    }}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
        ) : (
          <FieldDescription>
            Sin su autorización, el diagnóstico no va en la constancia ni se guarda en ella.
          </FieldDescription>
        )}
      </div>
    </FormDrawer>
  )
}
