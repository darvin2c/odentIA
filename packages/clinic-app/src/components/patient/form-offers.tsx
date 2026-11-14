import { Button, toast } from "@odentia/ui"
import { submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"
import { fetchFormTemplates, startFormResponse } from "../../lib/clinical-forms"
import {
  fetchFormOffers,
  type FormOffer,
  offerActionWords,
  offerStateWords,
  offersView,
  offerWhyWords,
} from "../../lib/consultation-forms"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import { FormDetail } from "./encounter-documents"
import { NewResponseDrawer } from "./formularios-tab"

/** «12 oct», en la zona de la clínica. */
const dayOf = (iso: string) =>
  new Date(iso).toLocaleDateString(activeOrgLocale(), { day: "numeric", month: "short", timeZone: activeOrgTimeZone() })

/**
 * Las fichas que la atención ofrece solas (ADR 0117): por la especialidad de la
 * cita, por la edad o, sin servicio, por la de quien atiende. Va arriba, debajo
 * de «Hoy viene a…» (dibujo 18), con por qué aparece cada una y un solo botón;
 * «Otra ficha…» abre las demás. La ficha se abre al lado sin salir de la
 * atención. Ofrecer no es pedir: nada de esto se exige para firmar ni para cobrar.
 */
export function FormOffersBox({
  patientId,
  encounterId,
  professionalUserId,
  canStart,
  beforeWrite,
  onChanged,
}: {
  patientId: string
  encounterId: string
  /** Quien atiende: responde por la ficha que se empieza aquí. */
  professionalUserId: string
  /** Puede empezar o seguir una ficha en esta atención; si no, solo las ve. */
  canStart: boolean
  beforeWrite: () => Promise<void>
  /** Lo que la atención vuelve a leer al empezar o cambiar una ficha (su cierre, sus documentos). */
  onChanged: () => Promise<void>
}): React.JSX.Element | null {
  const titleId = useId()
  const queryClient = useQueryClient()
  const [opened, setOpened] = useState<string | null>(null)
  const [choosing, setChoosing] = useState(false)
  const offers = useQuery({
    queryKey: ["form-offers", patientId, encounterId],
    queryFn: () => fetchFormOffers(patientId, encounterId),
    retry: 1,
  })
  const templates = useQuery({
    queryKey: ["form-templates-published", "mine-first"],
    queryFn: () => fetchFormTemplates({ status: "publicado", forUser: "me" }),
    enabled: choosing,
  })
  const refresh = async () => {
    await Promise.all(
      [
        ["form-offers", patientId, encounterId],
        ["form-responses", patientId],
        ["encounter-closing", patientId, encounterId],
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    )
    await onChanged()
  }
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
      await refresh()
      setOpened(result.data.id)
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  const list = offers.data?.data ?? []
  // Si no se pudo leer, igual se ofrece elegir una: «Otra ficha…» está siempre.
  const view = offersView(offers.data?.data ?? (offers.isError ? [] : undefined), canStart)
  if (view === "nada") return null

  const act = (offer: FormOffer) => {
    if (offer.today) setOpened(offer.today.responseId)
    else start.mutate(offer)
  }
  const other = (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="min-h-11 w-fit sm:min-h-8"
      onClick={() => setChoosing(true)}
    >
      Otra ficha…
    </Button>
  )
  const drawers = (
    <>
      {choosing ? (
        <NewResponseDrawer
          open
          patientId={patientId}
          encounterId={encounterId}
          defaultProfessionalUserId={professionalUserId}
          templates={(templates.data?.data ?? []).filter((template) => template.respondent !== "portal")}
          loading={!templates.isSuccess}
          onClose={() => setChoosing(false)}
          onCreated={async (id) => {
            setChoosing(false)
            await refresh()
            setOpened(id)
          }}
        />
      ) : null}
      <FormDetail
        patientId={patientId}
        responseId={opened}
        canWrite={canStart}
        onClose={() => setOpened(null)}
        onChanged={refresh}
      />
    </>
  )

  if (view === "solo-otra") {
    return (
      <>
        <p className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
          Ninguna ficha aparece sola en esta atención.
          {other}
        </p>
        {drawers}
      </>
    )
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
      {canStart ? other : null}
      {drawers}
    </section>
  )
}
