import { toast } from "@odentia/ui"
import { ToggleGroup, ToggleGroupItem } from "@odentia/ui/components/toggle-group"
import {
  common,
  FormDrawer,
  PageNotice,
  SpeechInput,
  SubmitButton,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation } from "@tanstack/react-query"
import { ExternalLink } from "lucide-react"
import { useState } from "react"
import { z } from "zod"
import { useIsAdmin } from "../../lib/session"
import { FORMAT_HINT, FormatTools } from "./formatted-body"
import {
  resolveOutreach,
  type SaleContact,
  SendUnknownError,
  sendOutreach,
  useClientSale,
  useInvalidateClient,
} from "./sale-api"

/**
 * «Escribir» a un cliente (lienzo de la ficha). Correo: sale con el nombre y
 * la dirección de quien escribe (o hola@ de la marca; Soporte, siempre desde
 * soporte@), y la respuesta vuelve
 * a esa dirección; si se corta a mitad, el
 * servidor dice que no se sabe si salió (502 `SEND_UNKNOWN`) y aquí no se
 * vuelve a enviar: la persona revisa y marca «Salió» o «No salió». WhatsApp:
 * no hay bandeja de Sallca, así que se abre el chat con el texto puesto en otra
 * pestaña y queda «¿Salió?» hasta que la persona lo diga. Nada sale solo.
 */
export type WriteChannel = "correo" | "whatsapp"

/**
 * Desde dónde sale un correo de «Escribir», como lo decide el servidor
 * (`outreachSender`): Soporte siempre desde soporte@ de la marca; los demás,
 * con su nombre y su dirección (o hola@ si aún no tienen).
 */
export function writeEmailHint({ proposal, support }: { proposal: boolean; support: boolean }) {
  if (proposal) return "Sale con la marca del producto y la propuesta en PDF adjunta."
  if (support) return "Sale desde soporte@ de la marca, como todo Soporte; su respuesta vuelve ahí."
  return "Sale con tu nombre y tu dirección de la marca (o desde hola@ si aún no tienes una); su respuesta vuelve ahí."
}

export interface WriteDrawerProps {
  clientId: string
  open: boolean
  onClose: () => void
  channel?: WriteChannel
  contactId?: string | null
  subject?: string
  body?: string
  /** La propuesta que viaja con el mensaje: por correo va su PDF adjunto. */
  proposalId?: string | null
  /** El borrador de Kairós del que sale el mensaje. */
  kairosItemId?: string | null
  title?: string
}

export function WriteDrawer(props: WriteDrawerProps) {
  if (!props.open) return null
  return <WriteSurface {...props} />
}

const OTHER = "__otro"

type Phase = { kind: "form" } | OutreachCheck

const writeSchema = z
  .object({
    channel: z.enum(["correo", "whatsapp"]),
    contactId: z.string(),
    to: z.string(),
    subject: z.string(),
    body: z
      .string()
      .trim()
      .min(1, "Escribe el mensaje")
      .max(5000, "Usa como máximo 5000 caracteres"),
  })
  .superRefine((value, ctx) => {
    if (value.contactId === OTHER && !value.to.trim())
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message:
          value.channel === "whatsapp"
            ? "Escribe el celular con el código del país"
            : "Escribe el correo",
      })
    if (value.channel === "correo" && !value.subject.trim())
      ctx.addIssue({ code: "custom", path: ["subject"], message: "Escribe el asunto" })
    if (value.subject.length > 200)
      ctx.addIssue({ code: "custom", path: ["subject"], message: "Usa como máximo 200 caracteres" })
  })

const addressOf = (contact: SaleContact, channel: WriteChannel) =>
  channel === "whatsapp" ? contact.phone : contact.email

/** La persona que viene elegida: la pedida, o la principal con dónde escribirle, o la primera que lo tenga. */
function pickContact(
  contacts: SaleContact[],
  channel: WriteChannel,
  wanted?: string | null,
): string {
  const usable = contacts.filter((contact) => contact.id && addressOf(contact, channel))
  if (wanted && usable.some((contact) => contact.id === wanted)) return wanted
  return (usable.find((contact) => contact.isPrimary) ?? usable[0])?.id ?? OTHER
}

/** Las personas llegan antes de armar el formulario: así la elegida viene puesta desde el primer pintado. */
function WriteSurface(props: WriteDrawerProps) {
  const client = useClientSale(props.clientId)
  if (!client.data) {
    return (
      <FormDrawer
        open
        onClose={props.onClose}
        title={props.title ?? "Escribir"}
        onSubmit={(event) => event.preventDefault()}
        isLoading={client.isPending}
        error={client.isError ? "No pude cargar sus personas. Cierra y vuelve a intentarlo." : null}
        hideSubmit
        cancelLabel={common.actions.close}
      >
        {null}
      </FormDrawer>
    )
  }
  return (
    <WriteForm
      {...props}
      clientName={client.data.name}
      contacts={client.data.contacts.filter((contact) => contact.id !== null)}
    />
  )
}

function WriteForm({
  clientId,
  onClose,
  channel = "whatsapp",
  contactId,
  subject = "",
  body = "",
  proposalId = null,
  kairosItemId = null,
  title,
  clientName,
  contacts,
}: WriteDrawerProps & { clientName: string; contacts: SaleContact[] }) {
  const invalidate = useInvalidateClient(clientId)
  const isAdmin = useIsAdmin()
  const [phase, setPhase] = useState<Phase>({ kind: "form" })

  const form = useAppForm({
    defaultValues: {
      channel: channel as WriteChannel,
      contactId: pickContact(contacts, channel, contactId),
      to: "",
      subject,
      body,
    },
    validators: { onSubmit: writeSchema },
    onSubmit: async ({ value }) => {
      const other = value.contactId === OTHER
      try {
        const result = await sendOutreach(clientId, {
          channel: value.channel,
          contactId: other ? null : value.contactId,
          to: other ? value.to.trim() : null,
          subject: value.channel === "correo" ? value.subject.trim() : null,
          body: value.body.trim(),
          proposalId,
          kairosItemId,
        })
        invalidate()
        if (result.outreach.channel === "whatsapp" && result.url) {
          // La pestaña se abre ahora; si el navegador la bloquea, el enlace queda abajo.
          window.open(result.url, "_blank", "noopener")
          setPhase({
            kind: "whatsapp",
            outreachId: result.outreach.id,
            url: result.url,
            to: result.outreach.to,
          })
          return
        }
        toast.success(`Correo enviado a ${result.outreach.to}`)
        onClose()
      } catch (error) {
        if (!(error instanceof SendUnknownError)) throw error
        invalidate()
        setPhase({ kind: "incierto", outreachId: error.outreachId, message: error.message })
      }
    },
  })
  const surface = useFormSurface(form, { fieldMap: { to: "to", contactId: "contactId" } })
  const values = useStore(form.store, (state) => state.values)
  const usable = contacts.filter((contact) => addressOf(contact, values.channel))
  const contactOptions = [
    ...usable.map((contact) => ({
      value: contact.id as string,
      label: `${contact.name} · ${addressOf(contact, values.channel)}`,
    })),
    { value: OTHER, label: values.channel === "whatsapp" ? "Otro número" : "Otro correo" },
  ]

  if (phase.kind !== "form") {
    return (
      <OutreachCheckDrawer
        phase={phase}
        onClose={onClose}
        onResolved={() => {
          invalidate()
          onClose()
        }}
      />
    )
  }

  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title={title ?? (proposalId ? "Enviar la propuesta" : "Escribir")}
      description={`A ${clientName}.`}
      submitLabel={values.channel === "whatsapp" ? "Abrir WhatsApp" : "Enviar correo"}
      cancelLabel={common.actions.cancel}
    >
      <div className="flex flex-col gap-4">
        <form.AppField name="channel">
          {(field) => (
            <field.Group legend="Por dónde">
              {() => (
                <ToggleGroup
                  aria-label="Por dónde"
                  value={[field.state.value]}
                  onValueChange={(next: unknown[]) => {
                    const picked = next[0]
                    if (picked !== "correo" && picked !== "whatsapp") return
                    field.handleChange(picked)
                    // La persona elegida puede no tener dónde escribirle por el otro canal.
                    form.setFieldValue(
                      "contactId",
                      pickContact(contacts, picked, form.state.values.contactId),
                    )
                  }}
                  spacing={1}
                  className="flex-wrap justify-start"
                >
                  {(["whatsapp", "correo"] as const).map((option) => (
                    <ToggleGroupItem
                      key={option}
                      value={option}
                      className="h-auto min-h-9 rounded-3xl border px-3 py-1.5 text-sm aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:font-semibold"
                    >
                      {option === "whatsapp" ? "WhatsApp" : "Correo"}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              )}
            </field.Group>
          )}
        </form.AppField>
        <form.AppField name="contactId">
          {(field) => (
            <field.SelectField id="escribir-persona" label="A quién" options={contactOptions} />
          )}
        </form.AppField>
        {values.contactId === OTHER ? (
          <form.AppField name="to">
            {(field) => (
              <field.TextField
                id="escribir-a"
                label={values.channel === "whatsapp" ? "Celular" : "Correo"}
                description={
                  values.channel === "whatsapp"
                    ? "Con el código del país, como +51987654321."
                    : undefined
                }
                type={values.channel === "whatsapp" ? "tel" : "email"}
                autoComplete="off"
                maxLength={254}
              />
            )}
          </form.AppField>
        ) : null}
        {values.channel === "correo" ? (
          <form.AppField name="subject">
            {(field) => <field.TextField id="escribir-asunto" label="Asunto" maxLength={200} />}
          </form.AppField>
        ) : null}
        <form.AppField name="body">
          {(field) => (
            <div className="flex flex-col gap-1.5">
              <field.TextareaField
                id="escribir-texto"
                label="Mensaje"
                description={
                  values.channel === "correo"
                    ? `${writeEmailHint({ proposal: Boolean(proposalId), support: !isAdmin })} ${FORMAT_HINT}`
                    : "Se abre WhatsApp con este texto; lo envías tú desde ahí."
                }
                rows={7}
                maxLength={5000}
              />
              {values.channel === "correo" ? (
                <FormatTools
                  textareaId="escribir-texto"
                  value={field.state.value}
                  onChange={field.handleChange}
                />
              ) : null}
              <div>
                <SpeechInput
                  lang="es-PE"
                  size="icon"
                  type="button"
                  aria-label="Dictar el mensaje"
                  onTranscriptionChange={(text) =>
                    field.handleChange(`${field.state.value ? `${field.state.value} ` : ""}${text}`)
                  }
                />
              </div>
            </div>
          )}
        </form.AppField>
        {values.channel === "whatsapp" && proposalId ? (
          <p className="text-xs text-muted-foreground">
            Por WhatsApp no va el PDF: si hace falta, envíalo por correo.
          </p>
        ) : null}
      </div>
    </FormDrawer>
  )
}

/** Lo que espera que una persona diga si salió: el WhatsApp abierto o el correo incierto. */
export type OutreachCheck =
  | { kind: "whatsapp"; outreachId: string; url: string; to: string }
  | { kind: "incierto"; outreachId: string | null; message: string }

/**
 * «¿Salió?»: el WhatsApp que se abrió por su enlace o el correo que no se sabe
 * si salió (502 `SEND_UNKNOWN`). La persona dice «Salió» o «No salió» con la
 * misma operación de los envíos; nada se vuelve a enviar solo. Lo usan
 * «Escribir» y «Responder».
 */
export function OutreachCheckDrawer({
  phase,
  onClose,
  onResolved,
}: {
  phase: OutreachCheck
  onClose: () => void
  /** Después de anotarlo (la pantalla refresca lo suyo y cierra). */
  onResolved: () => void
}) {
  const resolve = useMutation({
    mutationFn: async ({
      outreachId,
      outcome,
    }: {
      outreachId: string
      outcome: "salio" | "no_salio"
    }) => resolveOutreach(outreachId, outcome),
    onSuccess: (_data, { outcome }) => {
      toast.success(
        outcome === "salio" ? "Anotado: salió. Queda en su historial." : "Anotado: no salió.",
      )
      onResolved()
    },
  })
  return (
    <FormDrawer
      open
      onClose={onClose}
      title={phase.kind === "whatsapp" ? "¿Salió el WhatsApp?" : "¿Salió el correo?"}
      onSubmit={(event) => event.preventDefault()}
      hideSubmit
      cancelLabel={common.actions.close}
      isSubmitting={resolve.isPending}
    >
      <div className="flex flex-col gap-4">
        {phase.kind === "whatsapp" ? (
          <>
            <p className="text-sm">
              Se abrió WhatsApp con el mensaje para {phase.to} en otra pestaña. Envíalo desde ahí y
              vuelve para decir si salió.
            </p>
            <a
              href={phase.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex w-fit items-center gap-1.5 text-sm font-medium underline underline-offset-4"
            >
              <ExternalLink aria-hidden className="size-4" />
              Abrir WhatsApp otra vez
            </a>
          </>
        ) : (
          <PageNotice tone="alarma" label="No se sabe">
            {phase.message}
          </PageNotice>
        )}
        {phase.outreachId ? (
          <div className="flex flex-wrap gap-2">
            <SubmitButton
              type="button"
              pending={resolve.isPending && resolve.variables?.outcome === "salio"}
              disabled={resolve.isPending}
              onClick={() =>
                phase.outreachId &&
                resolve.mutate({ outreachId: phase.outreachId, outcome: "salio" })
              }
            >
              Salió
            </SubmitButton>
            <SubmitButton
              type="button"
              variant="outline"
              pending={resolve.isPending && resolve.variables?.outcome === "no_salio"}
              disabled={resolve.isPending}
              onClick={() =>
                phase.outreachId &&
                resolve.mutate({ outreachId: phase.outreachId, outcome: "no_salio" })
              }
            >
              No salió
            </SubmitButton>
          </div>
        ) : null}
        {resolve.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {submitErrorMessage(resolve.error)}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {phase.kind === "whatsapp"
            ? "Si cierras sin decirlo, el mensaje queda pendiente en su historial hasta que alguien lo marque."
            : "No se vuelve a enviar solo. Si cierras sin decirlo, queda como incierto en su historial."}
        </p>
      </div>
    </FormDrawer>
  )
}
