import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner,
} from "@odentia/ui"
import {
  normalizeCountry,
  SubmitButton,
  submitErrorMessage,
  useAppForm,
  useFormSubmit,
  useFormSubmitError,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { ChevronRight } from "lucide-react"
import { useEffect, useState } from "react"
import { z } from "zod"
import { ApiError, apiFetch } from "../lib/api"
import { useOrgProfile } from "../lib/org"

/** Una persona a la que se le puede escribir desde aquí. */
export interface WriteTarget {
  contactId: string
  displayName: string
  /** «Es la paciente», «Responsable»…: para elegir entre varias. */
  detail?: string
  isPreferred?: boolean
}

interface WriteResult {
  conversationId: string
  created: boolean
  channel: string
  identityCreated: boolean
}

/** «Escribirle» en el servidor: la conversación por la que se le escribe (no envía nada). */
export function useWriteToPerson() {
  const queryClient = useQueryClient()
  return useMutation({
    retry: false,
    mutationFn: (input: { contactId: string; phone?: string }) =>
      apiFetch<{ data: WriteResult }>(`/api/contacts/${input.contactId}/write`, {
        method: "POST",
        body: JSON.stringify(input.phone ? { phone: input.phone } : {}),
      }).then((result) => result.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["conversations"] })
    },
  })
}

const phoneSchema = z.object({
  phone: z
    .string()
    .nullable()
    .refine((value) => value !== null, "Escribe su número de WhatsApp."),
})

/**
 * «Escribirle»: la única forma de escribirle a una persona desde la ficha, la
 * Agenda, Finanzas o la Bandeja. Abre su conversación en la Bandeja: la que
 * tiene abierta, su WhatsApp o una nueva con su número. Si no tiene número lo
 * pide aquí mismo; con varias personas (un paciente y quien habla por él),
 * primero se elige a quién. Nadie escribe «wa:», elige un canal ni una conexión.
 */
export function WriteToPersonDialog({
  open,
  onClose,
  people,
  prepareRegistration = false,
}: {
  open: boolean
  onClose: () => void
  people: WriteTarget[]
  /** Al abrir la conversación, la Bandeja prepara «Su enlace» para revisarlo antes de enviarlo. */
  prepareRegistration?: boolean
}) {
  const navigate = useNavigate()
  const profile = useOrgProfile()
  const write = useWriteToPerson()
  const [chosen, setChosen] = useState<WriteTarget | null>(null)
  // Se pide el número desde que el servidor dijo que no tiene (`NO_PHONE`) y hasta
  // cerrar: un número rechazado se dice en su campo, sin que el campo desaparezca.
  const [needsPhone, setNeedsPhone] = useState(false)

  const openConversation = (conversationId: string) => {
    onClose()
    void navigate({
      to: "/inbox",
      search: prepareRegistration
        ? { conversation: conversationId, prepareRegistration: true as const }
        : { conversation: conversationId },
    })
  }

  const phoneForm = useAppForm({
    defaultValues: { phone: null as string | null },
    validators: { onSubmit: phoneSchema },
    onSubmit: async ({ value }) => {
      if (!chosen || !value.phone) return
      const result = await write.mutateAsync({ contactId: chosen.contactId, phone: value.phone })
      openConversation(result.conversationId)
    },
  })
  const submitPhone = useFormSubmit(phoneForm)
  const phoneError = useFormSubmitError(phoneForm)
  const phoneSubmitting = useStore(phoneForm.store, (state) => state.isSubmitting)

  const go = (target: WriteTarget) => {
    setChosen(target)
    write.mutate(
      { contactId: target.contactId },
      {
        onSuccess: (result) => openConversation(result.conversationId),
        onError: (error) => {
          if (error instanceof ApiError && error.shape.code === "NO_PHONE") setNeedsPhone(true)
        },
      },
    )
  }

  // Con una sola persona no hay nada que elegir: se abre su conversación al momento.
  // biome-ignore lint/correctness/useExhaustiveDependencies: se dispara una vez por apertura
  useEffect(() => {
    if (!open) return
    write.reset()
    phoneForm.reset({ phone: null })
    setNeedsPhone(false)
    setChosen(null)
    const only = people.length === 1 ? people[0] : undefined
    if (only) go(only)
  }, [open])

  const title = prepareRegistration ? "Escribirle con su enlace" : "Escribirle"
  const name = chosen?.displayName ?? ""
  const working = write.isPending && !needsPhone
  const choosing = people.length > 1 && !chosen

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !write.isPending) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {choosing
              ? "¿A quién le escribes? Se abre su conversación en la Bandeja."
              : needsPhone
                ? `${name} no tiene un número de WhatsApp. Escríbelo y se abre su conversación.`
                : `Se abre la conversación con ${name} en la Bandeja.`}
          </DialogDescription>
        </DialogHeader>

        {people.length === 0 ? (
          <p className="text-sm text-muted-foreground">No hay a quién escribirle: vincula primero a una persona.</p>
        ) : choosing ? (
          <ul className="grid gap-2">
            {people.map((target) => (
              <li key={target.contactId}>
                <Button
                  variant="outline"
                  className="h-auto min-h-11 w-full justify-between gap-2 py-2 text-left"
                  disabled={write.isPending}
                  onClick={() => go(target)}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{target.displayName}</span>
                    {target.detail || target.isPreferred ? (
                      <span className="block truncate text-xs font-normal text-muted-foreground">
                        {[target.detail, target.isPreferred ? "Recibe los avisos" : null].filter(Boolean).join(" · ")}
                      </span>
                    ) : null}
                  </span>
                  <ChevronRight className="size-4 shrink-0" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        ) : needsPhone && chosen ? (
          <form className="grid gap-3" noValidate onSubmit={submitPhone}>
            <phoneForm.AppField name="phone">
              {(field) => (
                <field.PhoneField
                  label="Su número de WhatsApp"
                  description="Queda como su WhatsApp para las próximas veces."
                  defaultCountry={normalizeCountry(profile.data?.countryCode)}
                />
              )}
            </phoneForm.AppField>
            {phoneError ? (
              <p role="alert" className="text-sm text-destructive">
                {phoneError}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={phoneSubmitting} onClick={onClose}>
                Cancelar
              </Button>
              <SubmitButton type="submit" pending={phoneSubmitting}>
                Escribirle
              </SubmitButton>
            </DialogFooter>
          </form>
        ) : working ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-5" aria-hidden />
            Abriendo la conversación…
          </p>
        ) : null}

        {write.error && !needsPhone ? (
          <div className="grid gap-3">
            <p role="alert" className="text-sm text-destructive">
              {submitErrorMessage(write.error)}
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Cerrar
              </Button>
              {chosen ? <Button onClick={() => go(chosen)}>Reintentar</Button> : null}
            </DialogFooter>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
