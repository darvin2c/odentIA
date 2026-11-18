import { productWords } from "@odentia/clinical"
import { Button, toast } from "@odentia/ui"
import {
  common,
  DetailField,
  DetailList,
  FormDrawer,
  PageNotice,
  SubmitButton,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation } from "@tanstack/react-query"
import { FileText } from "lucide-react"
import { useEffect, useState } from "react"
import { z } from "zod"
import { money } from "../../lib/cost-format"
import { useIsAdmin } from "../../lib/session"
import {
  type ClientSale,
  postJson,
  proposalPdfUrl,
  proposalSchema,
  type SalePlan,
  type SaleProposal,
  useClientProposals,
  useClientSale,
  useInvalidateClient,
  usePlans,
} from "./sale-api"
import {
  addDays,
  BILLING_CYCLES,
  CYCLE_WORDS,
  dayWords,
  limaDay,
  PROPOSAL_STATUS_WORDS,
  percentWords,
  proposalStatusWords,
} from "./sale-words"
import { DayField } from "./task-drawer"
import { type WriteChannel, WriteDrawer } from "./write-drawer"

/**
 * La propuesta de una venta (solo Administración: lleva importes y el servidor
 * lo exige). Se arma con un plan del producto del cliente: el precio de lista
 * queda congelado al guardarla; el descuento baja el precio de cada acción (la
 * cuota del plan no cambia), por los meses que se digan; la prueba, el ciclo y
 * la vigencia. Guardada, se ve el PDF tal como sale y se envía por correo (con
 * el PDF adjunto) o por WhatsApp con «Escribir». Enviada, no cambia: otra
 * condición es otra versión.
 */
export interface ProposalDrawerProps {
  clientId: string
  open: boolean
  onClose: () => void
  /** Una propuesta ya guardada: abre su PDF y su envío. */
  proposalId?: string | null
}

export function ProposalDrawer(props: ProposalDrawerProps) {
  if (!props.open) return null
  return <ProposalLoader {...props} />
}

function ProposalLoader({ clientId, onClose, proposalId = null }: ProposalDrawerProps) {
  const isAdmin = useIsAdmin()
  const client = useClientSale(clientId)
  const plans = usePlans(isAdmin && !proposalId)
  const [savedId, setSavedId] = useState<string | null>(proposalId)
  const [saved, setSaved] = useState<SaleProposal | null>(null)
  const proposals = useClientProposals(clientId, isAdmin && savedId !== null)
  const proposal =
    proposals.data?.find((row) => row.id === savedId) ?? (saved?.id === savedId ? saved : null)

  if (!isAdmin) {
    return (
      <FormDrawer
        open
        onClose={onClose}
        title="Propuesta"
        onSubmit={(event) => event.preventDefault()}
        hideSubmit
        cancelLabel={common.actions.close}
      >
        <p className="text-sm text-muted-foreground">
          Las propuestas las arma y las envía alguien con el rol Administración.
        </p>
      </FormDrawer>
    )
  }
  if (savedId) {
    if (!client.data || !proposal) {
      const failed = client.isError || proposals.isError || (proposals.isSuccess && !proposal)
      return (
        <FormDrawer
          open
          onClose={onClose}
          title="Propuesta"
          onSubmit={(event) => event.preventDefault()}
          isLoading={!failed}
          error={failed ? "No pude cargar la propuesta. Cierra y vuelve a intentarlo." : null}
          hideSubmit
          cancelLabel={common.actions.close}
        >
          {null}
        </FormDrawer>
      )
    }
    return (
      <SavedProposal
        clientId={clientId}
        client={client.data}
        proposal={proposal}
        onClose={onClose}
      />
    )
  }
  if (!client.data || !plans.data) {
    return (
      <FormDrawer
        open
        onClose={onClose}
        title="Nueva propuesta"
        onSubmit={(event) => event.preventDefault()}
        isLoading={client.isPending || plans.isPending}
        error={
          client.isError || plans.isError
            ? "No pude cargar los planes. Cierra y vuelve a intentarlo."
            : null
        }
        hideSubmit
        cancelLabel={common.actions.close}
      >
        {null}
      </FormDrawer>
    )
  }
  return (
    <NewProposal
      clientId={clientId}
      client={client.data}
      plans={plans.data.filter((plan) => plan.product === client.data.product && plan.isActive)}
      onClose={onClose}
      onSaved={(row) => {
        setSaved(row)
        setSavedId(row.id)
      }}
    />
  )
}

/* ---------- Armar ---------- */

const optionalInt = (label: string, min: number, max: number) =>
  z
    .string()
    .trim()
    .refine(
      (value) =>
        value === "" || (/^\d+$/.test(value) && Number(value) >= min && Number(value) <= max),
      `${label} va de ${min} a ${max}`,
    )

const proposalFormSchema = z.object({
  planId: z.string().min(1, "Elige el plan"),
  discountPercent: z
    .string()
    .trim()
    .refine(
      (value) =>
        value === "" ||
        (/^\d+([.,]\d{1,2})?$/.test(value) && Number(value.replace(",", ".")) <= 90),
      "El descuento va de 0 a 90 %",
    ),
  discountMonths: optionalInt("El descuento", 1, 36),
  trialDays: optionalInt("La prueba", 1, 365),
  trialCredit: z
    .string()
    .trim()
    .refine(
      (value) => value === "" || /^\d+([.,]\d{1,2})?$/.test(value),
      "Escribe el saldo como 100 o 100,50",
    ),
  billingCycle: z.enum(BILLING_CYCLES),
  validUntil: z.string().min(1, "Elige hasta qué día vale"),
})
type ProposalForm = z.infer<typeof proposalFormSchema>

const bpsOf = (percent: string) =>
  percent.trim() ? Math.round(Number(percent.replace(",", ".")) * 100) : 0
const centsOf = (amount: string) =>
  amount.trim() ? Math.round(Number(amount.replace(",", ".")) * 100) : null
const intOf = (value: string) => (value.trim() ? Number(value) : null)

/** Lo que pide aprobación: más descuento o más prueba de lo que da un vendedor (la regla del servidor). */
function overSeller(plan: SalePlan | undefined, value: ProposalForm): boolean {
  if (!plan) return false
  return (
    bpsOf(value.discountPercent) > plan.sellerDiscountBps ||
    (intOf(value.trialDays) ?? 0) > plan.trialDays ||
    (centsOf(value.trialCredit) ?? 0) > plan.trialCreditCents
  )
}

function NewProposal({
  clientId,
  client,
  plans,
  onClose,
  onSaved,
}: {
  clientId: string
  client: ClientSale
  plans: SalePlan[]
  onClose: () => void
  onSaved: (row: SaleProposal) => void
}) {
  const invalidate = useInvalidateClient(clientId)
  const today = limaDay()
  const initialPlan = plans.find((plan) => plan.isDefault) ?? plans[0]
  const form = useAppForm({
    defaultValues: {
      planId: initialPlan?.id ?? "",
      discountPercent: "",
      discountMonths: "",
      trialDays: "",
      trialCredit: "",
      billingCycle: "mensual",
      validUntil: addDays(today, 14),
    } as ProposalForm,
    validators: { onSubmit: proposalFormSchema },
    onSubmit: async ({ value }) => {
      const discountBps = bpsOf(value.discountPercent)
      const row = proposalSchema.parse(
        await postJson(`/api/admin/clients/${encodeURIComponent(clientId)}/proposals`, {
          planId: value.planId,
          discountBps,
          discountMonths: discountBps > 0 ? intOf(value.discountMonths) : null,
          trialDays: intOf(value.trialDays),
          trialCreditCents: centsOf(value.trialCredit),
          billingCycle: value.billingCycle,
          validUntil: value.validUntil,
        }),
      )
      invalidate()
      toast.success(
        `Propuesta v${row.version} guardada como ${PROPOSAL_STATUS_WORDS[row.displayStatus].toLowerCase()}`,
      )
      onSaved(row)
    },
  })
  const surface = useFormSurface(form, {
    fieldMap: { discountBps: "discountPercent", trialCreditCents: "trialCredit" },
  })
  const values = useStore(form.store, (state) => state.values)
  const plan = plans.find((each) => each.id === values.planId)
  const discounted = bpsOf(values.discountPercent) > 0

  if (plans.length === 0) {
    return (
      <FormDrawer
        open
        onClose={onClose}
        title="Nueva propuesta"
        onSubmit={(event) => event.preventDefault()}
        hideSubmit
        cancelLabel={common.actions.close}
      >
        <p className="text-sm text-muted-foreground">
          No hay un plan activo de {productWords(client.product).name}. Créalo en Cobros y planes y
          vuelve a armar la propuesta.
        </p>
      </FormDrawer>
    )
  }

  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title="Nueva propuesta"
      description={`Para ${client.name}. Queda como borrador: nada sale hasta que la envíes.`}
      submitLabel="Guardar borrador"
      cancelLabel={common.actions.cancel}
    >
      <div className="flex flex-col gap-4">
        <form.AppField name="planId">
          {(field) => (
            <field.SelectField
              id="propuesta-plan"
              label="Plan"
              description={
                plan
                  ? `Precio de lista: ${money(plan.priceCents, plan.currency)} cada mes. Queda fijo en esta versión.`
                  : undefined
              }
              options={plans.map((each) => ({
                value: each.id,
                label: `${each.name} · ${money(each.priceCents, each.currency)}`,
              }))}
            />
          )}
        </form.AppField>
        <div className="grid gap-4 sm:grid-cols-2">
          <form.AppField name="discountPercent">
            {(field) => (
              <field.TextField
                id="propuesta-descuento"
                label="Descuento (%)"
                description={
                  plan
                    ? `Baja el precio de cada acción; la cuota no cambia. Hasta ${percentWords(plan.maxDiscountBps)}.`
                    : "Baja el precio de cada acción; la cuota no cambia."
                }
                inputMode="decimal"
                placeholder="0"
                maxLength={5}
              />
            )}
          </form.AppField>
          {discounted ? (
            <form.AppField name="discountMonths">
              {(field) => (
                <field.TextField
                  id="propuesta-meses"
                  label="Por cuántos meses"
                  description="Vacío: mientras dure la suscripción."
                  inputMode="numeric"
                  maxLength={2}
                />
              )}
            </form.AppField>
          ) : null}
          <form.AppField name="trialDays">
            {(field) => (
              <field.TextField
                id="propuesta-prueba"
                label="Días de prueba"
                description={
                  plan
                    ? `Vacío: la del plan. Hasta ${plan.trialMaxDays} días.`
                    : "Vacío: la del plan."
                }
                inputMode="numeric"
                maxLength={3}
              />
            )}
          </form.AppField>
          <form.AppField name="trialCredit">
            {(field) => (
              <field.TextField
                id="propuesta-saldo"
                label={`Saldo de prueba${plan ? ` (${plan.currency})` : ""}`}
                description={
                  plan
                    ? `Vacío: el del plan. Hasta ${money(plan.trialMaxCreditCents, plan.currency)}.`
                    : "Vacío: el del plan."
                }
                inputMode="decimal"
                maxLength={10}
              />
            )}
          </form.AppField>
          <form.AppField name="billingCycle">
            {(field) => (
              <field.SelectField
                id="propuesta-ciclo"
                label="Cada cuánto paga"
                options={BILLING_CYCLES.map((cycle) => ({
                  value: cycle,
                  label: CYCLE_WORDS[cycle],
                }))}
              />
            )}
          </form.AppField>
          <DayField
            form={form}
            name="validUntil"
            id="propuesta-vigencia"
            label="Vale hasta"
            min={today}
          />
        </div>
        {overSeller(plan, values) && plan ? (
          <PageNotice tone="aviso" label="Pide aprobación">
            Pasa de lo que da un vendedor (hasta {percentWords(plan.sellerDiscountBps)} de descuento
            y la prueba del plan). La armas desde Administración, así que no espera otra aprobación.
          </PageNotice>
        ) : null}
      </div>
    </FormDrawer>
  )
}

/* ---------- Guardada: el PDF y el envío ---------- */

/** El mensaje que acompaña a la propuesta: se puede cambiar antes de enviarlo. */
function proposalMessage(client: ClientSale, proposal: SaleProposal, channel: WriteChannel) {
  const brand = productWords(client.product).name
  const person = client.contacts.find((contact) => contact.isPrimary) ?? client.contacts[0]
  const hello = person ? `Hola ${person.name.split(/\s+/)[0]},` : "Hola,"
  // «el plan Plan odentIA» cuando el nombre ya empieza con «Plan».
  const plan = /^plan\s/i.test(proposal.plan.name)
    ? proposal.plan.name
    : `plan ${proposal.plan.name}`
  const body =
    channel === "correo"
      ? `${hello}\n\nLe envío la propuesta de ${brand} para ${client.name}, con el ${plan}. Vale hasta el ${dayWords(proposal.validUntil)}.\n\nVa en el PDF adjunto. Cualquier duda, respondo aquí mismo.`
      : `${hello} le escribo de ${brand}. Le preparé la propuesta para ${client.name} con el ${plan}; vale hasta el ${dayWords(proposal.validUntil)}. ¿Se la envío por correo con el detalle?`
  return { subject: `Propuesta de ${brand} para ${client.name}`, body }
}

function SavedProposal({
  clientId,
  client,
  proposal,
  onClose,
}: {
  clientId: string
  client: ClientSale
  proposal: SaleProposal
  onClose: () => void
}) {
  const invalidate = useInvalidateClient(clientId)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [writing, setWriting] = useState<WriteChannel | null>(null)
  const pdf = useMutation({
    mutationFn: () => proposalPdfUrl(proposal.id),
    onSuccess: (url) => {
      setPdfUrl(url)
      window.open(url, "_blank", "noopener")
    },
  })
  // El PDF vive en la memoria de la pestaña mientras el cajón está abierto.
  useEffect(() => () => (pdfUrl ? URL.revokeObjectURL(pdfUrl) : undefined), [pdfUrl])
  const approve = useMutation({
    mutationFn: () =>
      postJson(`/api/admin/clients/proposals/${encodeURIComponent(proposal.id)}/approve`),
    onSuccess: () => {
      invalidate()
      toast.success(`Propuesta v${proposal.version} aprobada: ya se puede enviar`)
    },
  })
  const sendable =
    (proposal.status === "borrador" || proposal.status === "enviada") &&
    proposal.displayStatus !== "vencida" &&
    proposal.replacedBy == null
  const message = writing ? proposalMessage(client, proposal, writing) : null

  return (
    <>
      <FormDrawer
        open
        onClose={onClose}
        title={`Propuesta v${proposal.version}`}
        description={client.name}
        onSubmit={(event) => event.preventDefault()}
        hideSubmit
        cancelLabel={common.actions.close}
      >
        <div className="flex flex-col gap-5">
          <DetailList>
            <DetailField label="Estado">{proposalStatusWords(proposal)}</DetailField>
            <DetailField label="Plan">{proposal.plan.name}</DetailField>
            <DetailField label="Precio de lista">{`${money(proposal.listPriceCents, proposal.currency)} cada mes`}</DetailField>
            <DetailField label="Descuento">
              {proposal.discountBps > 0
                ? `${percentWords(proposal.discountBps)} en el precio de cada acción${proposal.discountMonths ? `, por ${proposal.discountMonths} ${proposal.discountMonths === 1 ? "mes" : "meses"}` : ""}`
                : "Sin descuento"}
            </DetailField>
            <DetailField label="Prueba">
              {[
                proposal.trialDays ? `${proposal.trialDays} días` : "La del plan",
                proposal.trialCreditCents !== null
                  ? `saldo de ${money(proposal.trialCreditCents, proposal.currency)}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </DetailField>
            <DetailField label="Paga">{CYCLE_WORDS[proposal.billingCycle]}</DetailField>
            <DetailField label="Vale hasta">{dayWords(proposal.validUntil)}</DetailField>
          </DetailList>
          <div className="flex flex-wrap gap-2">
            <SubmitButton
              type="button"
              variant="outline"
              pending={pdf.isPending}
              onClick={() => pdf.mutate()}
            >
              <FileText aria-hidden />
              Ver el PDF
            </SubmitButton>
            {pdfUrl ? (
              <a
                href={pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="self-center text-sm underline underline-offset-4"
              >
                Abrir otra vez
              </a>
            ) : null}
          </div>
          {pdf.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {submitErrorMessage(pdf.error)}
            </p>
          ) : null}
          {proposal.status === "por_aprobar" ? (
            <PageNotice
              tone="aviso"
              label="Pide aprobación"
              action={
                <SubmitButton
                  type="button"
                  size="sm"
                  pending={approve.isPending}
                  onClick={() => approve.mutate()}
                >
                  Aprobar
                </SubmitButton>
              }
            >
              Pasa de lo que da un vendedor: se envía cuando Administración la apruebe.
            </PageNotice>
          ) : null}
          {approve.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {submitErrorMessage(approve.error)}
            </p>
          ) : null}
          {sendable ? (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">
                {proposal.status === "enviada" ? "Volver a enviarla" : "Enviarla"}
              </span>
              <div className="flex flex-wrap gap-2">
                <Button type="button" onClick={() => setWriting("correo")}>
                  Enviar por correo
                </Button>
                <Button type="button" variant="outline" onClick={() => setWriting("whatsapp")}>
                  Enviar por WhatsApp
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Por correo va con el PDF adjunto. Al salir, la propuesta queda «Enviada» y ya no
                cambia.
              </p>
            </div>
          ) : proposal.replacedBy != null ? (
            <p className="text-sm text-muted-foreground">
              Ya salió la v{proposal.replacedBy}: esta no se envía ni se acepta.
            </p>
          ) : proposal.displayStatus === "vencida" ? (
            <p className="text-sm text-muted-foreground">
              Venció: para otra vigencia, arma una versión nueva.
            </p>
          ) : proposal.status === "aceptada" || proposal.status === "no_aceptada" ? (
            <p className="text-sm text-muted-foreground">
              {proposal.status === "aceptada" ? "La aceptó" : "No la aceptó"}
              {proposal.acceptedNote ? `: ${proposal.acceptedNote}` : "."}
            </p>
          ) : null}
        </div>
      </FormDrawer>
      {writing && message ? (
        <WriteDrawer
          clientId={clientId}
          open
          onClose={() => setWriting(null)}
          channel={writing}
          proposalId={proposal.id}
          subject={message.subject}
          body={message.body}
          title={`Enviar la propuesta v${proposal.version}`}
        />
      ) : null}
    </>
  )
}
