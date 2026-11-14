import { Button, toast } from "@odentia/ui"
import { submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useId } from "react"
import { startFormResponse } from "../../lib/clinical-forms"
import {
  fetchFormOffers,
  type FormOffer,
  offerActionWords,
  offerStateWords,
  offerWhyWords,
} from "../../lib/consultation-forms"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"

/** «12 oct», en la zona de la clínica. */
const dayOf = (iso: string) =>
  new Date(iso).toLocaleDateString(activeOrgLocale(), { day: "numeric", month: "short", timeZone: activeOrgTimeZone() })

/**
 * Las fichas que la atención ofrece solas (ADR 0117): por la especialidad de la
 * cita, por la edad o, sin servicio, por la de quien atiende. Cada una con por
 * qué aparece y un solo botón; «Otra ficha…» abre las demás. Ofrecer no es
 * pedir: nada de esto se exige para firmar ni para cobrar.
 */
export function FormOffersBox({
  patientId,
  encounterId,
  professionalUserId,
  canStart,
  beforeWrite,
  onStarted,
  onOpen,
  onOther,
}: {
  patientId: string
  encounterId: string
  /** Quien atiende: responde por la ficha que se empieza aquí. */
  professionalUserId: string
  /** Puede empezar o seguir una ficha en esta atención; si no, solo las ve. */
  canStart: boolean
  beforeWrite: () => Promise<void>
  onStarted: () => Promise<void>
  onOpen: (responseId: string) => void
  onOther: () => void
}): React.JSX.Element | null {
  const titleId = useId()
  const offers = useQuery({
    queryKey: ["form-offers", patientId, encounterId],
    queryFn: () => fetchFormOffers(patientId, encounterId),
    retry: 1,
  })
  const start = useMutation({
    mutationFn: async (offer: FormOffer) => {
      await beforeWrite()
      return startFormResponse({
        templateId: offer.templateId,
        patientId,
        encounterId,
        professionalUserId,
        answers: {},
      })
    },
    onSuccess: async (result) => {
      await onStarted()
      onOpen(result.data.id)
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  const list = offers.data?.data ?? []
  // Sin ninguna que ofrecer, nada: «Nuevo › Ficha» sigue ahí.
  if (list.length === 0) return null

  const act = (offer: FormOffer) => {
    if (offer.today) onOpen(offer.today.responseId)
    else start.mutate(offer)
  }

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2 rounded-lg border p-3">
      <h3 id={titleId} className="text-sm font-medium">
        Fichas para esta atención
      </h3>
      <ul className="flex flex-col divide-y">
        {list.map((offer) => {
          const state = offerStateWords(offer)
          const action = offerActionWords(offer)
          // Ver la de hoy no escribe nada; empezarla o seguirla, sí.
          const allowed = canStart || action === "Ver la de hoy"
          return (
            <li key={offer.templateId} className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
              <div className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">
                  {offer.title}
                  {state ? <span className="font-normal text-muted-foreground"> · {state}</span> : null}
                </span>
                <span className="text-xs text-muted-foreground">
                  {offerWhyWords(offer)}
                  {offer.previous ? ` · la anterior, del ${dayOf(offer.previous.finalizedAt)}, se ve al lado` : ""}
                </span>
              </div>
              {allowed ? (
                <Button
                  type="button"
                  size="sm"
                  variant={offer.today ? "outline" : "default"}
                  className="min-h-11 sm:min-h-8"
                  disabled={start.isPending}
                  // Con varias ofrecidas, cada botón dice de cuál es.
                  aria-label={`${action}: ${offer.title}`}
                  onClick={() => act(offer)}
                >
                  {action}
                </Button>
              ) : null}
            </li>
          )
        })}
      </ul>
      {canStart ? (
        <Button type="button" size="sm" variant="ghost" className="min-h-11 w-fit sm:min-h-8" onClick={onOther}>
          Otra ficha…
        </Button>
      ) : null}
    </section>
  )
}
