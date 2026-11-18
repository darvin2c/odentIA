import { Button, FieldGroup, toast } from "@odentia/ui"
import { submitForm, useAppForm, useFormSubmitError } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useQuery } from "@tanstack/react-query"
import { useRef, useState } from "react"
import { z } from "zod"
import { ApiError, apiFetch } from "../../lib/api"
import {
  type ConsentDocument,
  fetchConsents,
  fetchProposedPersonalRisks,
  setConsentPersonalRisks,
} from "../../lib/clinical-forms"
import { usePermission } from "../../lib/crm"
import type { PatientFull } from "../../lib/patients"

/** ¿Se pueden cambiar todavía? Pendiente, sin firmar en su enlace y sin enviar: lo que lee no cambia. */
export function personalRisksEditable(
  document: Pick<ConsentDocument, "status" | "personSignedAt" | "linkSentAt" | "sectionsSnapshot">,
): boolean {
  return (
    document.status === "pendiente" &&
    !document.personSignedAt &&
    !document.linkSentAt &&
    !!document.sectionsSnapshot
  )
}

/**
 * La ayuda del campo: «Lo propone el sistema» solo si el sistema los propuso y nadie los cambió (el
 * documento sigue como nació); sin riesgos, una ayuda neutra para escribirlos.
 */
export function personalRisksHelp(
  document: Pick<ConsentDocument, "sectionsSnapshot" | "createdAt" | "updatedAt">,
): string {
  const saved = document.sectionsSnapshot?.personalRisks ?? []
  if (saved.length === 0) return "Escribe los riesgos propios de su caso, una frase por línea."
  if (document.updatedAt === document.createdAt)
    return "Lo propone el sistema según sus antecedentes. Cámbialo o bórralo. Una frase por línea."
  return "Cámbialo o bórralo. Una frase por línea."
}

/**
 * Los riesgos propios de su caso (reglas clínicas del 18 nov): el sistema los propone al generar el
 * consentimiento desde sus antecedentes y el procedimiento; aquí se cambian o se borran, una frase
 * por línea, mientras está pendiente y no se envió a su enlace. Vacío, la hoja queda como siempre.
 * No frena la firma.
 */
export function ConsentPersonalRisksField({
  document,
  onSaved,
}: {
  document: ConsentDocument
  onSaved: () => void | Promise<void>
}) {
  const canPatients = usePermission("patients.read")
  const patientQuery = useQuery({
    queryKey: ["patient", document.patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${document.patientId}`),
    enabled: canPatients,
  })
  const person = patientQuery.data?.data.patient
  const first = (person?.givenNames ?? person?.displayName ?? "").trim().split(/\s+/)[0] ?? ""
  const savedRisks = document.sectionsSnapshot?.personalRisks ?? []
  const saved = savedRisks.join("\n")
  // Lo que tenía a la vista quien edita: si otra pestaña los cambió, el servidor no los pisa (409).
  const seen = useRef<string[]>(savedRisks)
  // Tras ese 409, lo que dicen ahora: se ven, y lo escrito se conserva para guardarlo encima a sabiendas.
  const [latest, setLatest] = useState<string[] | null>(null)
  const form = useAppForm({
    defaultValues: { personalRisks: saved },
    validators: {
      onSubmit: z.object({
        personalRisks: z.string().max(6000, "Escribe como mucho 6000 caracteres."),
      }),
    },
    onSubmit: async ({ value }) => {
      const text = value.personalRisks.trim()
      try {
        const result = await setConsentPersonalRisks(document.id, text || null, seen.current)
        seen.current = result.data.sectionsSnapshot?.personalRisks ?? []
      } catch (error) {
        if (error instanceof ApiError && error.shape.code === "CONSENT_RISKS_CHANGED") {
          const fresh = await fetchConsents({ patientId: document.patientId })
            .then((response) => response.data.find((row) => row.id === document.id) ?? null)
            .catch(() => null)
          if (fresh) {
            seen.current = fresh.sectionsSnapshot?.personalRisks ?? []
            setLatest(seen.current)
          }
          void onSaved()
        }
        throw error
      }
      setLatest(null)
      toast.success(text ? "Riesgos propios guardados" : "Riesgos propios quitados de la hoja")
      await onSaved()
    },
  })
  const error = useFormSubmitError(form)
  const pending = useStore(form.store, (state) => state.isSubmitting)
  const written = useStore(form.store, (state) => state.values.personalRisks.trim())
  const changed = written !== saved
  // Lo que propone hoy el sistema, con su ficha de ahora: «Volver a proponer» lo trae al campo.
  const proposed = useQuery({
    queryKey: ["consent-proposed-risks", document.id],
    queryFn: () => fetchProposedPersonalRisks(document.id),
    staleTime: 60_000,
  })
  const proposedText = (proposed.data?.data ?? []).join("\n")
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        void submitForm(form)
      }}
    >
      <FieldGroup className="gap-2">
        <form.AppField name="personalRisks">
          {(field) => (
            <field.TextareaField
              label={
                first
                  ? `Riesgos propios de ${first} (opcional)`
                  : "Riesgos propios de su caso (opcional)"
              }
              description={personalRisksHelp(document)}
              rows={3}
              maxLength={6000}
              disabled={pending}
            />
          )}
        </form.AppField>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {latest ? (
          <div className="flex flex-col gap-1 rounded-md border p-2 text-sm">
            <p className="font-medium">Ahora dicen:</p>
            {latest.length > 0 ? (
              <ul className="list-disc pl-5">
                {latest.map((risk) => (
                  <li key={risk}>{risk}</li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">Ninguno: la hoja va sin riesgos propios.</p>
            )}
            <p className="text-muted-foreground">Si guardas otra vez, quedan los que escribiste.</p>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" variant="outline" disabled={pending || !changed}>
            {pending ? "Guardando…" : "Guardar"}
          </Button>
          {/* Borrados o cambiados por error: lo que propone el sistema vuelve al campo, sin guardar. */}
          {proposedText && written !== proposedText ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => form.setFieldValue("personalRisks", proposedText)}
            >
              Volver a proponer
            </Button>
          ) : null}
        </div>
      </FieldGroup>
    </form>
  )
}
