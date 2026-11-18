import { Button, toast } from "@odentia/ui"
import { submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useRef, useState } from "react"
import {
  discardFormResponse,
  type FormResponse,
  fetchFormResponses,
  fetchFormTemplates,
  startFormResponse,
  writesForm,
} from "../../lib/clinical-forms"
import { useMyUserId } from "../../lib/crm"
import {
  fetchFormOffers,
  type FormOffer,
  offerActionWords,
  offerButtonName,
  offerStateWords,
  offersView,
  offerWhyWords,
} from "../../lib/consultation-forms"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import { ClioFormNotice, proposalsOf, useClioFormProposals } from "./clio-form-proposals"
import { FormDetail } from "./encounter-documents"
import { isEmptyAnswer } from "./form-fields"
import { DiscardFormDialog, NewResponseDrawer } from "./formularios-tab"

/** «12 oct», en la zona de la clínica. */
const dayOf = (iso: string) =>
  new Date(iso).toLocaleDateString(activeOrgLocale(), {
    day: "numeric",
    month: "short",
    timeZone: activeOrgTimeZone(),
  })

/** El motivo que queda en la traza al quitar una ficha vacía, sin preguntar. */
export const EMPTY_REMOVED_REASON = "Se quitó sin respuestas: se agregó por error."

/**
 * Cómo se saca de la atención una ficha de hoy a medias: vacía (sin respuestas ni nada
 * propuesto por Clío) se «Quita» sin preguntar, con «Deshacer»; con algo escrito se
 * «Descarta…» con su motivo. Las dos son el mismo descarte, con su traza.
 */
export function offerRemoval(
  response: Pick<FormResponse, "status" | "answers"> | null | undefined,
  proposals: number,
): "Quitar" | "Descartar…" | null {
  if (!response || response.status !== "borrador") return null
  const empty = Object.values(response.answers ?? {}).every(isEmptyAnswer) && proposals === 0
  return empty ? "Quitar" : "Descartar…"
}

/**
 * Las fichas que la atención ofrece solas (ADR 0117): por la especialidad de la
 * cita, por la edad o, sin servicio, por la de quien atiende. Va arriba, debajo
 * de la cabecera, arriba de Consulta (dibujo 18), como las demás partes de la atención: con por
 * qué aparece cada una y un solo botón; «Otra ficha…» abre las demás. La ficha
 * se abre en el panel sin salir de la atención. Ofrecer no es pedir: nada de
 * esto se exige para firmar ni para cobrar. La de hoy agregada por error se
 * quita desde su fila.
 */
export function FormOffersBox({
  patientId,
  encounterId,
  professionalUserId,
  sex,
  canStart,
  beforeWrite,
  onChanged,
}: {
  patientId: string
  encounterId: string
  /** Quien atiende: responde por la ficha que se empieza aquí. */
  professionalUserId: string
  /** El sexo registrado del paciente, para decir quién dijo lo que envió. */
  sex: string | null
  /** Puede empezar o seguir una ficha en esta atención; si no, solo las ve. */
  canStart: boolean
  beforeWrite: () => Promise<void>
  /** Lo que la atención vuelve a leer al empezar o cambiar una ficha (su cierre, sus documentos). */
  onChanged: () => Promise<void>
}): React.JSX.Element | null {
  const titleId = useId()
  const queryClient = useQueryClient()
  const me = useMyUserId()
  const clio = useClioFormProposals()
  const [opened, setOpened] = useState<string | null>(null)
  // De qué fila se abrió: al cerrar, el foco vuelve a su botón («Seguir con la de hoy»).
  const [from, setFrom] = useState<string | null>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const [choosing, setChoosing] = useState(false)
  // La de hoy con respuestas que se descarta: con su motivo, en el diálogo de siempre.
  const [discarding, setDiscarding] = useState<string | null>(null)
  const offers = useQuery({
    queryKey: ["form-offers", patientId, encounterId],
    queryFn: () => fetchFormOffers(patientId, encounterId),
    retry: 1,
  })
  // Las de esta atención: «Otra ficha…» abre la que ya está a medias en vez de empezar otra, y cada
  // fila sabe si la de hoy está vacía («Quitar») o tiene algo («Descartar…»).
  const forms = useQuery({
    queryKey: ["form-responses", patientId],
    queryFn: () => fetchFormResponses({ patientId }),
  })
  const drafts = (forms.data?.data ?? []).filter((form) => form.encounterId === encounterId)
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
  const startOffer = async (offer: Pick<FormOffer, "templateId">) => {
    await beforeWrite()
    return startFormResponse({
      templateId: offer.templateId,
      patientId,
      encounterId,
      professionalUserId,
      answers: {},
    })
  }
  const start = useMutation({
    mutationFn: startOffer,
    onSuccess: async (result, offer) => {
      await refresh()
      setFrom(offer.templateId)
      setOpened(result.data.id)
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  // «Quitar» la vacía: el mismo descarte, sin preguntar; «Deshacer» la vuelve a empezar vacía, como estaba.
  const remove = useMutation({
    mutationFn: async (offer: FormOffer) => {
      if (!offer.today) return
      await beforeWrite()
      await discardFormResponse(offer.today.responseId, EMPTY_REMOVED_REASON)
    },
    onSuccess: async (_, offer) => {
      await refresh()
      toast(`Quitaste «${offer.title}» de esta atención.`, {
        duration: 10_000,
        action: {
          label: "Deshacer",
          onClick: () => {
            void startOffer(offer)
              .then(() => refresh())
              .catch((error: unknown) => toast.error(submitErrorMessage(error)))
          },
        },
      })
      // El foco, en el «Empezar la de hoy» de la misma fila: es el deshacer que está a mano (el aviso
      // dura 10 s y con el teclado quedaba lejos). Si la fila ya no está, en el título.
      requestAnimationFrame(() => {
        const section = sectionRef.current
        ;(
          section?.querySelector<HTMLElement>(`[data-offer="${CSS.escape(offer.templateId)}"]`) ??
          section?.querySelector<HTMLElement>("h2")
        )?.focus()
      })
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  const list = offers.data?.data ?? []
  // Sin ninguna ofrecida (o si no se pudo leer), nada: «Otra ficha…» sigue en Documentos › Nuevo.
  const view = offersView(offers.data?.data)
  if (view === "nada") return null

  const act = (offer: FormOffer) => {
    setFrom(offer.templateId)
    if (offer.today) setOpened(offer.today.responseId)
    else start.mutate(offer)
  }
  const close = () => {
    setOpened(null)
    // El botón de origen cambió de nombre («Empezar» pasó a «Seguir»), pero es la misma fila.
    const target = from
    requestAnimationFrame(() =>
      sectionRef.current?.querySelector<HTMLElement>(`[data-offer="${target}"]`)?.focus(),
    )
  }
  const busy = start.isPending || remove.isPending
  const other = (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="min-h-11 sm:min-h-8"
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
          templates={(templates.data?.data ?? []).filter(
            (template) => template.respondent !== "portal",
          )}
          loading={!templates.isSuccess || !forms.isSuccess}
          drafts={drafts}
          onClose={() => setChoosing(false)}
          onCreated={async (id) => {
            setChoosing(false)
            await refresh()
            setOpened(id)
          }}
        />
      ) : null}
      {discarding ? (
        <DiscardFormDialog
          responseId={discarding}
          onClose={() => setDiscarding(null)}
          onDiscarded={refresh}
        />
      ) : null}
      <FormDetail
        patientId={patientId}
        encounterId={encounterId}
        sex={sex}
        responseId={opened}
        canWrite={canStart}
        onClose={close}
        onChanged={refresh}
      />
    </>
  )

  return (
    // Como las demás partes de la atención («Consulta», «Plan»): su título y, a la derecha, lo que agrega.
    <section
      ref={sectionRef}
      aria-labelledby={titleId}
      className="flex flex-col gap-1 rounded-sm bg-card px-6 py-4 max-sm:px-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={titleId} tabIndex={-1} className="font-heading text-base font-medium outline-none">
          Fichas para esta atención
        </h2>
        {canStart ? other : null}
      </div>
      <ul className="flex flex-col divide-y text-sm">
        {list.map((offer) => {
          const state = offerStateWords(offer)
          const action = offerActionWords(offer)
          // Ver la de hoy no escribe nada; empezarla o seguirla, sí.
          const allowed = canStart || action === "Ver la de hoy"
          const today = offer.today
            ? (forms.data?.data ?? []).find((form) => form.id === offer.today?.responseId)
            : null
          // La quita quien la escribe (quien lleva la atención), como al descartarla desde la ficha.
          const removal =
            canStart && today && writesForm(today, me)
              ? offerRemoval(today, proposalsOf(clio, today.id).length)
              : null
          return (
            <li key={offer.templateId} className="flex flex-col gap-2 py-3">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">
                    {offer.title}
                    {state ? (
                      <span className="font-normal text-muted-foreground"> · {state}</span>
                    ) : null}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {offerWhyWords(offer)}
                    {offer.previous
                      ? ` · la anterior, del ${dayOf(offer.previous.finalizedAt)}${offer.previous.unfinished ? ", que quedó a medias" : ""}, se ve debajo de cada pregunta`
                      : ""}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  {removal ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="min-h-11 sm:min-h-8"
                      disabled={busy}
                      aria-label={`${removal === "Quitar" ? "Quitar" : "Descartar"} ${offer.title} de esta atención`}
                      onClick={() => {
                        if (removal === "Quitar") remove.mutate(offer)
                        else if (offer.today) setDiscarding(offer.today.responseId)
                      }}
                    >
                      {removal}
                    </Button>
                  ) : null}
                  {allowed ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="min-h-11 sm:min-h-8"
                      disabled={busy}
                      // Con varias ofrecidas, cada botón dice de cuál es y por qué aparece.
                      aria-label={offerButtonName(offer)}
                      data-offer={offer.templateId}
                      onClick={() => act(offer)}
                    >
                      {action}
                    </Button>
                  ) : null}
                </span>
              </div>
              {/* Lo que propuso Clío al dictar: aquí solo se avisa; se acepta en la ficha, en cada pregunta. */}
              {offer.today?.status === "borrador" ? (
                <ClioFormNotice
                  responseId={offer.today.responseId}
                  title={offer.title}
                  onOpen={() => act(offer)}
                />
              ) : null}
            </li>
          )
        })}
      </ul>
      {drawers}
    </section>
  )
}
