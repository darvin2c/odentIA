import { Button, FieldGroup, toast } from "@odentia/ui"
import { submitForm, useAppForm, useFormSubmitError } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useQuery } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { z } from "zod"
import { apiFetch } from "../../lib/api"
import { type ConsentDocument, fetchProposedPersonalRisks } from "../../lib/clinical-forms"
import {
  risksDraftOf,
  saveRisksDraft,
  setRisksDraft,
  useRisksDrafts,
} from "../../lib/consent-risks-draft"
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
 * «Volver a proponer» solo mientras se escribe algo distinto de lo propuesto, o con el campo vacío
 * (QA de diseño del 18 nov, H9): guardado a propósito, lo escrito a mano no tiene un botón al lado
 * para siempre.
 */
export function offersProposal(input: {
  written: string
  saved: string
  proposed: string
}): boolean {
  if (!input.proposed || input.written === input.proposed) return false
  return input.written !== input.saved || input.written === ""
}

/**
 * Los riesgos propios de su caso (reglas clínicas del 18 nov): el sistema los propone al generar el
 * consentimiento desde sus antecedentes y el procedimiento; aquí se cambian o se borran, una frase
 * por línea, mientras está pendiente y no se envió a su enlace. Vacío, la hoja queda como siempre.
 * No frena la firma: lo escrito sin guardar queda como borrador (`consent-risks-draft`), y firmar
 * lo guarda antes de abrir la hoja («Guardar y firmar»).
 */
export function ConsentPersonalRisksField({
  document,
  onSaved,
  autoFocus = false,
}: {
  document: ConsentDocument
  onSaved: () => void | Promise<void>
  /** Desde «Revisar» de la fila: el foco va al campo. */
  autoFocus?: boolean
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
  const rootRef = useRef<HTMLDivElement>(null)
  const broughtRef = useRef<HTMLParagraphElement>(null)
  // Lo escrito antes y sin guardar (se cerró el panel): vuelve al campo.
  const draft = useRisksDrafts().get(document.id) ?? null
  const latest = draft?.latest ?? null
  // «Volver a proponer» trajo lo propuesto: se dice que falta guardar, y el foco va a esa frase.
  const [brought, setBrought] = useState(false)
  const focusField = () => rootRef.current?.querySelector("textarea")?.focus()
  /** Guardado: el foco vuelve al campo cuando deja de estar desactivado. */
  const [refocus, setRefocus] = useState(false)
  const form = useAppForm({
    defaultValues: { personalRisks: risksDraftOf(document.id)?.text ?? saved },
    validators: {
      onSubmit: z.object({
        personalRisks: z.string().max(6000, "Escribe como mucho 6000 caracteres."),
      }),
    },
    onSubmit: async ({ value }) => {
      const text = value.personalRisks.trim()
      remember(value.personalRisks)
      try {
        await saveRisksDraft(document.id)
      } catch (error) {
        void onSaved()
        throw error
      }
      setBrought(false)
      toast.success(text ? "Riesgos propios guardados" : "Riesgos propios quitados de la hoja")
      await onSaved()
      // El botón queda desactivado al guardar: el foco vuelve al campo, no al inicio de la página.
      // Aquí el campo sigue desactivado mientras se envía y no lo recibe: se enfoca al habilitarse
      // (verificación del 18 nov: caía a `body` y el lector de pantalla perdía el sitio).
      setRefocus(true)
    },
  })
  const error = useFormSubmitError(form)
  const pending = useStore(form.store, (state) => state.isSubmitting)
  const raw = useStore(form.store, (state) => state.values.personalRisks)
  const written = raw.trim()
  const changed = written !== saved
  /** Lo escrito queda como borrador mientras sea distinto de lo guardado. */
  const remember = (text: string) => {
    const now = risksDraftOf(document.id)
    if (text.trim() === saved && !now?.latest) {
      setRisksDraft(document.id, null)
      return
    }
    setRisksDraft(document.id, {
      documentId: document.id,
      patientId: document.patientId,
      planItemId: document.planItemId,
      text,
      seen: now?.seen ?? savedRisks,
      latest: now?.latest ?? null,
    })
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: solo cuando cambia lo escrito o lo guardado.
  useEffect(() => {
    if (!pending) remember(raw)
  }, [raw, saved])
  // biome-ignore lint/correctness/useExhaustiveDependencies: solo al aparecer.
  useEffect(() => {
    if (!autoFocus) return
    rootRef.current?.scrollIntoView({ block: "center" })
    focusField()
  }, [])
  useEffect(() => {
    if (brought) broughtRef.current?.focus()
  }, [brought])
  // biome-ignore lint/correctness/useExhaustiveDependencies: cuando termina de guardar.
  useEffect(() => {
    if (!refocus || pending) return
    setRefocus(false)
    focusField()
  }, [refocus, pending])
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
        <div ref={rootRef}>
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
        </div>
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
        {brought && changed ? (
          <p
            ref={broughtRef}
            tabIndex={-1}
            role="status"
            className="text-sm text-muted-foreground outline-none"
          >
            Trajiste lo que propone el sistema. Falta «Guardar».
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={pending || (!changed && !latest)}
          >
            {pending ? "Guardando…" : "Guardar"}
          </Button>
          {/* Borrados o cambiados por error: lo que propone el sistema vuelve al campo, sin guardar. */}
          {offersProposal({ written, saved, proposed: proposedText }) ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                form.setFieldValue("personalRisks", proposedText)
                setBrought(true)
              }}
            >
              Volver a proponer
            </Button>
          ) : null}
        </div>
      </FieldGroup>
    </form>
  )
}
