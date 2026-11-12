import { CLINICAL_PRODUCTS, type ClinicalProduct } from "@odentia/clinical"
import { Badge, Button, Input, Label, RadioGroup, RadioGroupItem, toast } from "@odentia/ui"
import {
  AgentMark,
  common,
  DatePickerButton,
  ExpandableText,
  type FieldControl,
  FormDrawer,
  LoadingState,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { z } from "zod"
import { api } from "../../lib/api"
import { supportDayTime } from "../../lib/support-words"
import { ProductMark } from "../product"
import { ClientName, type ClientTab, invalidateArm, OpenClientButton } from "./hoy-links"

/**
 * Lo que preparó Kairós y espera el sí de una persona (`/api/admin/kairos`):
 * la tarjeta con su por qué, con qué datos y cuándo vence; Enviar o Aprobar,
 * Cambiar y Ahora no. Aprobar ejecuta la misma operación de la pantalla en el
 * servidor; un correo sale una sola vez y un WhatsApp se abre por su enlace y
 * queda «¿Salió?» hasta que la persona lo dice. Nada se reintenta solo.
 */

/** El tipo y el estado se leen como texto: uno nuevo del servidor no rompe la pantalla. */
export const kairosItemSchema = z.object({
  id: z.string(),
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  product: z.enum(CLINICAL_PRODUCTS).nullable(),
  kind: z.string(),
  title: z.string(),
  reason: z.string(),
  status: z.string(),
  payload: z.record(z.string(), z.unknown()),
  ready: z.boolean(),
  /** Quién redactó el mensaje o el guion: el modelo o, si no está configurado, una plantilla. */
  drafter: z.enum(["modelo", "plantilla"]).nullable().default(null),
  /** Lo que se dice de un borrador hecho con plantilla (lo escribe el servidor); null si no. */
  draftNote: z.string().nullable().default(null),
  adminOnly: z.boolean(),
  expiresAt: z.string(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedByName: z.string().nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
})
export type KairosItem = z.infer<typeof kairosItemSchema>
export const kairosItemsSchema = z.object({
  items: z.array(kairosItemSchema),
  total: z.number().int().nonnegative(),
})

const decisionSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  result: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  outreach: z
    .object({
      id: z.string(),
      channel: z.string(),
      to: z.string().nullable(),
      status: z.string(),
      whatsappUrl: z.string().nullable(),
    })
    .nullable(),
  emailSent: z.boolean().nullable(),
})
type Decision = z.infer<typeof decisionSchema>

/** Lo que solo aprueba Administración (precios, la carga, ligar personas, fusionar): el servidor también lo exige. */
const ADMIN_KINDS = new Set(["propuesta", "plan_carga", "informe", "vinculo", "duplicado"])

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null
const textList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : []

/** La pestaña de la ficha donde vive lo que preparó Kairós. */
export function kairosItemTab(kind: string): ClientTab {
  switch (kind) {
    case "propuesta":
    case "guion":
    case "presentacion_hecha":
      return "venta"
    case "plan_carga":
    case "informe":
      return "alta"
    case "vinculo":
      return "contactos"
    case "mensaje":
      return "historial"
    default:
      return "resumen"
  }
}

const channelOf = (item: KairosItem): "correo" | "whatsapp" | null => {
  const channel = text(item.payload.channel)
  return channel === "correo" || channel === "whatsapp" ? channel : null
}

/** El botón del sí, en palabras de lo que hace. */
function approveLabel(item: KairosItem): string {
  switch (item.kind) {
    case "mensaje":
      return channelOf(item) === "whatsapp" ? "Abrir WhatsApp" : "Enviar"
    case "guion":
      return "Listo"
    case "dato":
      return "Completar"
    case "vinculo":
      return "Ligar"
    case "duplicado":
      return "Revisar las dos"
    case "demo":
      return "Ir a Demos"
    case "presentacion_hecha":
      return "Sí, se hizo"
    default:
      return "Aprobar"
  }
}

/** Lo que se puede cambiar aquí antes del sí; lo demás se cambia en la ficha. */
const CHANGEABLE = new Set(["mensaje", "presentacion_hecha", "dato", "correo_sin_cliente"])

/** «Vence el jue 13 nov, 10:05»; en rojo si le quedan menos de 6 horas (y lo dice la palabra «Vence»). */
function dueWords(expiresAt: string, now: Date): { text: string; urgent: boolean } {
  const left = new Date(expiresAt).getTime() - now.getTime()
  return { text: `Vence el ${supportDayTime(expiresAt)}`, urgent: left < 6 * 3_600_000 }
}

const outreachWords = (item: KairosItem): string | null => {
  const channel = channelOf(item)
  const to = text(item.payload.to)
  if (!channel) return null
  return channel === "whatsapp"
    ? `Por WhatsApp${to ? ` a ${to}` : ""}`
    : `Por correo${to ? ` a ${to}` : ""}`
}

interface DecideInput {
  item: KairosItem
  action: "aprobar" | "descartar"
  edited?: Record<string, unknown>
  /** La pestaña abierta en el clic para el WhatsApp: el navegador no bloquea la que se abre así. */
  tab?: Window | null
}

/** Abre una pestaña vacía en el clic, si el sí va a dar un enlace de WhatsApp. */
export function tabForWhatsApp(item: KairosItem, action: "aprobar" | "descartar"): Window | null {
  if (action !== "aprobar" || item.kind !== "mensaje" || channelOf(item) !== "whatsapp") return null
  try {
    return window.open("about:blank", "_blank")
  } catch {
    return null
  }
}

function openWhatsApp(url: string, tab: Window | null | undefined): void {
  if (tab && !tab.closed) {
    tab.opener = null
    tab.location.href = url
    return
  }
  window.open(url, "_blank", "noopener")
}

/**
 * Aprobar o descartar. El resultado lo dice el servidor: hecho, vencido (lo
 * vuelve a preparar), fallido (con su motivo), el correo enviado o del que no
 * se sabe si salió, o el enlace de WhatsApp que queda «¿Salió?».
 */
export function useKairosDecide() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return useMutation({
    mutationFn: async ({ item, action, edited }: DecideInput): Promise<Decision> =>
      decisionSchema.parse(
        await api<unknown>(`/api/admin/kairos/items/${item.id}/decide`, {
          method: "POST",
          body: JSON.stringify({ action, ...(edited ? { edited } : {}) }),
        }),
      ),
    onError: (_error, { tab }) => {
      tab?.close()
    },
    onSuccess: (decision, { item, action, tab }) => {
      invalidateArm(queryClient, item.clientId)
      if (decision.status === "vencida" || decision.status === "fallida") {
        tab?.close()
        toast.error(decision.error ?? "No se pudo hacer: ya no vale")
        return
      }
      if (action === "descartar") {
        toast.success("Listo: no se hace")
        return
      }
      const outreach = decision.outreach
      if (outreach?.channel === "whatsapp" && outreach.whatsappUrl) {
        const url = outreach.whatsappUrl
        openWhatsApp(url, tab)
        toast.success("Se abrió WhatsApp con el mensaje. Cuando lo envíes, di si salió.", {
          action: {
            label: "Abrir otra vez",
            onClick: () => window.open(url, "_blank", "noopener"),
          },
        })
        return
      }
      tab?.close()
      if (outreach?.channel === "correo") {
        if (decision.emailSent) toast.success(`Enviado${outreach.to ? ` a ${outreach.to}` : ""}`)
        else
          toast.warning("No se sabe si el correo salió: no se reintenta. Revísalo y di si salió.")
        return
      }
      const open = text(decision.result?.open)
      if (open === "fusion") {
        const keepId = text(decision.result?.keepId)
        toast.success("Abre la ficha para decidir si se fusionan")
        if (keepId)
          void navigate({
            to: "/clients/$clientId",
            params: { clientId: keepId },
            search: { tab: undefined },
          })
        return
      }
      if (open === "demos") {
        void navigate({ to: "/demos" })
        return
      }
      toast.success("Hecho")
    },
  })
}

/** Una tarjeta de lo que Kairós dejó listo. */
export function KairosItemCard({
  item,
  isAdmin,
  now,
}: {
  item: KairosItem
  isAdmin: boolean
  now: Date
}) {
  const decide = useKairosDecide()
  const [changing, setChanging] = useState(false)
  const due = dueWords(item.expiresAt, now)
  const facts = textList(item.payload.facts)
  const subject = text(item.payload.subject)
  const body = text(item.payload.body)
  const onlyAdmin = ADMIN_KINDS.has(item.kind) && !isAdmin
  const needsClient = item.kind === "correo_sin_cliente" && !text(item.payload.clientId)
  const run = (action: "aprobar" | "descartar") => {
    const tab = tabForWhatsApp(item, action)
    decide.mutate(
      { item, action, tab },
      { onError: (error) => toast.error(submitErrorMessage(error)) },
    )
  }
  const pending = decide.isPending
  return (
    <li className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start gap-3">
        <AgentMark size="sm" />
        <div className="min-w-0 flex-1 basis-48">
          <p className="font-medium [overflow-wrap:anywhere]">{item.title}</p>
          <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
            {item.clientId && item.clientName ? (
              <ClientName clientId={item.clientId} tab={kairosItemTab(item.kind)}>
                {item.clientName}
              </ClientName>
            ) : (
              <span>Sin cliente todavía</span>
            )}
            {item.product ? <ProductMark product={item.product} /> : null}
          </p>
        </div>
        <Badge variant={due.urgent ? "destructive" : "outline"}>{due.text}</Badge>
      </div>
      <p className="text-sm [overflow-wrap:anywhere]">
        <span className="font-medium">Por qué: </span>
        {item.reason}
      </p>
      {facts.length > 0 ? (
        <div className="text-sm">
          <p className="font-medium">Con qué datos</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground [overflow-wrap:anywhere]">
            {facts.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {item.kind === "mensaje" || item.kind === "guion" ? (
        item.ready && body ? (
          <div className="rounded-lg bg-muted p-3 text-sm">
            {outreachWords(item) ? (
              <p className="text-xs text-muted-foreground">{outreachWords(item)}</p>
            ) : null}
            {subject ? (
              <p className="mt-1 font-medium [overflow-wrap:anywhere]">{subject}</p>
            ) : null}
            <ExpandableText
              text={body}
              lines={3}
              label="el texto completo"
              className="mt-1 whitespace-pre-line"
            />
            {item.drafter === "plantilla" && item.draftNote ? (
              <p className="mt-2 text-xs text-muted-foreground">{item.draftNote}</p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Kairós lo está redactando; cuando esté listo se puede enviar.
          </p>
        )
      ) : null}
      {onlyAdmin ? (
        <p className="text-sm text-muted-foreground">Esto lo aprueba Administración.</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {onlyAdmin ? null : needsClient ? (
          <Button type="button" size="sm" disabled={pending} onClick={() => setChanging(true)}>
            Elegir el cliente
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            disabled={
              pending || ((item.kind === "mensaje" || item.kind === "guion") && !item.ready)
            }
            onClick={() => run("aprobar")}
          >
            {approveLabel(item)}
          </Button>
        )}
        {!onlyAdmin && CHANGEABLE.has(item.kind) && !needsClient && item.ready ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => setChanging(true)}
          >
            Cambiar
          </Button>
        ) : !CHANGEABLE.has(item.kind) && item.kind !== "demo" && item.clientId ? (
          <OpenClientButton
            clientId={item.clientId}
            tab={kairosItemTab(item.kind)}
            label={item.kind === "propuesta" ? "Cambiar en la ficha" : "Abrir ficha"}
          />
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => run("descartar")}
        >
          Ahora no
        </Button>
      </div>
      {CHANGEABLE.has(item.kind) ? (
        <KairosChangeDrawer item={item} open={changing} onClose={() => setChanging(false)} />
      ) : null}
    </li>
  )
}

/* ---------- Cambiar ---------- */

const OUTCOMES = [
  { value: "se_hizo", label: "Se hizo" },
  { value: "no_se_conecto", label: "No se conectó" },
  { value: "reprogramar", label: "Hay que reprogramarla" },
] as const
const PROFESSIONALS = [
  { value: "", label: "Sin cambiar" },
  { value: "1", label: "1" },
  { value: "2-3", label: "De 2 a 3" },
  { value: "4-9", label: "De 4 a 9" },
  { value: "10+", label: "10 o más" },
]
const TOOLS = [
  { value: "", label: "Sin cambiar" },
  { value: "nada", label: "Nada" },
  { value: "cuaderno_excel", label: "Cuaderno o Excel" },
  { value: "otro_software", label: "Otro programa" },
]

interface ChangeValues {
  edited: {
    subject: string
    body: string
    outcome: string
    nextDueOn: string
    clientId: string
    fields: { city: string; professionals: string; currentTool: string }
  }
}

function valuesOf(item: KairosItem): ChangeValues {
  const fields = (
    item.payload.fields && typeof item.payload.fields === "object" ? item.payload.fields : {}
  ) as Record<string, unknown>
  return {
    edited: {
      subject: text(item.payload.subject) ?? "",
      body: text(item.payload.body) ?? "",
      outcome: text(item.payload.outcome) ?? "se_hizo",
      nextDueOn: text(item.payload.nextDueOn) ?? "",
      clientId: text(item.payload.clientId) ?? "",
      fields: {
        city: text(fields.city) ?? "",
        professionals: text(fields.professionals) ?? "",
        currentTool: text(fields.currentTool) ?? "",
      },
    },
  }
}

/** Solo lo que ese tipo deja cambiar (el servidor rechaza lo demás). */
function editedOf(item: KairosItem, values: ChangeValues): Record<string, unknown> {
  const edited = values.edited
  switch (item.kind) {
    case "mensaje":
      return channelOf(item) === "correo"
        ? { subject: edited.subject.trim(), body: edited.body }
        : { body: edited.body }
    case "presentacion_hecha":
      return {
        outcome: edited.outcome,
        body: edited.body,
        ...(edited.nextDueOn ? { nextDueOn: edited.nextDueOn } : {}),
      }
    case "dato": {
      const fields: Record<string, string> = {}
      if (edited.fields.city.trim()) fields.city = edited.fields.city.trim()
      if (edited.fields.professionals) fields.professionals = edited.fields.professionals
      if (edited.fields.currentTool) fields.currentTool = edited.fields.currentTool
      return { fields }
    }
    case "correo_sin_cliente":
      return { clientId: edited.clientId }
    default:
      return {}
  }
}

const changeSchema = (kind: string) =>
  z.object({
    edited: z.object({
      subject: z.string().max(200, "Usa como máximo 200 caracteres"),
      body:
        kind === "mensaje" || kind === "presentacion_hecha"
          ? z
              .string()
              .trim()
              .min(1, kind === "mensaje" ? "Escribe el mensaje" : "Escribe qué pasó")
              .max(5000, "Usa como máximo 5000 caracteres")
          : z.string(),
      outcome: z.string(),
      nextDueOn: z.string(),
      clientId:
        kind === "correo_sin_cliente"
          ? z.string().min(1, "Elige el cliente de este correo")
          : z.string(),
      fields: z.object({
        city: z.string().max(120, "Usa como máximo 120 caracteres"),
        professionals: z.string(),
        currentTool: z.string(),
      }),
    }),
  })

/** «Cambiar»: lo mismo que preparó Kairós, editable, y el mismo sí al final. */
function KairosChangeDrawer({
  item,
  open,
  onClose,
}: {
  item: KairosItem
  open: boolean
  onClose: () => void
}) {
  const decide = useKairosDecide()
  const form = useAppForm({
    defaultValues: valuesOf(item),
    validators: { onSubmit: changeSchema(item.kind) },
    onSubmit: async ({ value, formApi }) => {
      const tab = tabForWhatsApp(item, "aprobar")
      await decide.mutateAsync({ item, action: "aprobar", edited: editedOf(item, value), tab })
      formApi.reset(value)
      onClose()
    },
  })
  const channel = channelOf(item)
  const title =
    item.kind === "mensaje"
      ? "Cambiar el mensaje"
      : item.kind === "presentacion_hecha"
        ? "¿Cómo fue la presentación?"
        : item.kind === "dato"
          ? "Cambiar los datos"
          : "¿De qué cliente es este correo?"
  const submitLabel =
    item.kind === "mensaje"
      ? channel === "whatsapp"
        ? "Abrir WhatsApp"
        : "Enviar"
      : item.kind === "correo_sin_cliente"
        ? "Asignar"
        : "Guardar"
  return (
    <FormDrawer
      {...useFormSurface(form)}
      open={open}
      onClose={onClose}
      title={title}
      description={item.clientName ? `${item.title} · ${item.clientName}` : item.title}
      submitLabel={submitLabel}
      cancelLabel={common.actions.cancel}
    >
      <div className="flex flex-col gap-5">
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <AgentMark size="sm" />
          <span>Kairós lo preparó así. {item.reason}</span>
        </p>
        {item.drafter === "plantilla" && item.draftNote ? (
          <p className="text-sm text-muted-foreground">{item.draftNote}</p>
        ) : null}
        {item.kind === "mensaje" ? (
          <>
            <p className="text-sm">{outreachWords(item)}</p>
            {channel === "correo" ? (
              <form.AppField name="edited.subject">
                {(field) => <field.TextField id="kairos-asunto" label="Asunto" maxLength={200} />}
              </form.AppField>
            ) : null}
            <form.AppField name="edited.body">
              {(field) => (
                <field.TextareaField id="kairos-texto" label="Mensaje" rows={8} maxLength={5000} />
              )}
            </form.AppField>
            {channel === "whatsapp" ? (
              <p className="text-sm text-muted-foreground">
                Se abre WhatsApp con este texto; lo envías tú. Después di si salió.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Sale una sola vez. Si no se sabe si salió, no se reintenta.
              </p>
            )}
          </>
        ) : null}
        {item.kind === "presentacion_hecha" ? (
          <>
            <form.AppField name="edited.outcome">
              {(field) => <field.RadioGroupField legend="Cómo fue" options={OUTCOMES} />}
            </form.AppField>
            <form.AppField name="edited.body">
              {(field) => (
                <field.TextareaField
                  id="kairos-que-paso"
                  label="Qué pasó"
                  rows={4}
                  maxLength={5000}
                />
              )}
            </form.AppField>
            <form.AppField name="edited.nextDueOn">
              {(field) => (
                <field.Control
                  id="kairos-proximo"
                  label={
                    <>
                      Próximo paso{" "}
                      <span className="font-normal text-muted-foreground">(opcional)</span>
                    </>
                  }
                >
                  {(control) => (
                    <DatePickerButton
                      id={control.id}
                      aria-invalid={control.invalid || undefined}
                      aria-describedby={control.describedBy}
                      onBlur={control.onBlur}
                      value={field.state.value}
                      onChange={(day) => {
                        field.handleChange(day)
                        field.handleBlur()
                      }}
                      emptyLabel="Sin fecha"
                    />
                  )}
                </field.Control>
              )}
            </form.AppField>
          </>
        ) : null}
        {item.kind === "dato" ? (
          <>
            <p className="text-sm text-muted-foreground">
              Kairós solo completa lo que está vacío: nunca cambia lo que escribió una persona.
            </p>
            <form.AppField name="edited.fields.city">
              {(field) => <field.TextField id="kairos-ciudad" label="Ciudad" maxLength={120} />}
            </form.AppField>
            <form.AppField name="edited.fields.professionals">
              {(field) => (
                <field.SelectField
                  id="kairos-profesionales"
                  label="Cuántos profesionales son"
                  options={PROFESSIONALS}
                />
              )}
            </form.AppField>
            <form.AppField name="edited.fields.currentTool">
              {(field) => (
                <field.SelectField
                  id="kairos-herramienta"
                  label="Con qué trabajan hoy"
                  options={TOOLS}
                />
              )}
            </form.AppField>
          </>
        ) : null}
        {item.kind === "correo_sin_cliente" ? (
          <form.AppField name="edited.clientId">
            {(field) => (
              <field.Group legend="Cliente">
                {(control) => (
                  <EmailClientPicker
                    item={item}
                    control={control}
                    value={field.state.value}
                    onChange={(clientId) => {
                      field.handleChange(clientId)
                      field.handleBlur()
                    }}
                  />
                )}
              </field.Group>
            )}
          </form.AppField>
        ) : null}
      </div>
    </FormDrawer>
  )
}

const pickedSchema = z.object({
  items: z.array(
    z.object({ id: z.string(), name: z.string(), product: z.enum(CLINICAL_PRODUCTS) }),
  ),
})

/** Buscar el cliente de un correo que llegó: por nombre de la clínica o de la persona. */
function EmailClientPicker({
  item,
  control,
  value,
  onChange,
}: {
  item: KairosItem
  control: FieldControl
  value: string
  onChange: (clientId: string) => void
}) {
  const [query, setQuery] = useState(text(item.payload.fromName) ?? "")
  const [search, setSearch] = useState(query.trim())
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [query])
  const found = useQuery({
    queryKey: ["admin", "clients", "picker", search],
    enabled: search.length >= 2,
    queryFn: async () =>
      pickedSchema.parse(
        await api<unknown>(`/api/admin/clients?view=todos&limit=8&q=${encodeURIComponent(search)}`),
      ).items,
  })
  const from = [text(item.payload.fromName), text(item.payload.from)].filter(Boolean).join(" · ")
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg bg-muted p-3 text-sm">
        <p className="font-medium [overflow-wrap:anywhere]">{from || "Remitente sin nombre"}</p>
        {text(item.payload.subject) ? (
          <p className="text-muted-foreground [overflow-wrap:anywhere]">
            {text(item.payload.subject)}
          </p>
        ) : null}
        <p className="mt-1 text-xs text-muted-foreground">
          El correo y sus adjuntos se leen en la ficha, no aquí.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="kairos-buscar-cliente">Buscar por nombre</Label>
        <Input
          id="kairos-buscar-cliente"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="La clínica o la persona"
          autoComplete="off"
        />
      </div>
      {search.length < 2 ? (
        <p className="text-sm text-muted-foreground">Escribe al menos dos letras.</p>
      ) : found.isPending ? (
        <LoadingState message="Buscando clientes…" />
      ) : found.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {submitErrorMessage(found.error)}
        </p>
      ) : found.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">Ningún cliente se llama así.</p>
      ) : (
        <RadioGroup
          name={control.name}
          aria-label="Cliente"
          aria-invalid={control.invalid || undefined}
          aria-describedby={control.describedBy}
          value={value}
          onValueChange={(next) => onChange(String(next ?? ""))}
          className="flex flex-col gap-2"
        >
          {found.data.map((client) => (
            <Label
              key={client.id}
              className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 font-normal has-data-checked:border-foreground"
            >
              <RadioGroupItem value={client.id} />
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{client.name}</span>
              <ProductMark product={client.product} />
            </Label>
          ))}
        </RadioGroup>
      )}
    </div>
  )
}

/* ---------- ¿Salió? ---------- */

/**
 * Los envíos aprobados de los que no se sabe si salieron: el WhatsApp abierto
 * por su enlace y el correo que quedó incierto. Los responde una persona con
 * «Salió» o «No salió» (la misma operación de los envíos de la ficha); nada se
 * reintenta solo. Vive en los ítems ya decididos, así que sigue aquí al
 * recargar.
 */
export function useKairosUnconfirmed() {
  return useQuery({
    queryKey: ["admin", "kairos", "items", "hecho", "por-confirmar"],
    queryFn: async () =>
      kairosItemsSchema
        .parse(await api<unknown>("/api/admin/kairos/items?status=hecho&limit=100"))
        .items.filter((item) => item.status === "incierta" && text(item.result?.outreachId)),
  })
}

export function KairosUnconfirmed({ product }: { product?: ClinicalProduct | undefined }) {
  const unconfirmed = useKairosUnconfirmed()
  const rows = (unconfirmed.data ?? []).filter((item) => !product || item.product === product)
  if (rows.length === 0) return null
  return (
    <section aria-labelledby="kairos-salio" className="space-y-3">
      <h2 id="kairos-salio" className="text-base font-semibold">
        ¿Salió?
      </h2>
      <p className="text-sm text-muted-foreground">
        No se sabe si estos mensajes llegaron. Dilo tú: nada se vuelve a enviar solo.
      </p>
      <ul className="divide-y rounded-xl border bg-card">
        {rows.map((item) => (
          <UnconfirmedRow key={item.id} item={item} />
        ))}
      </ul>
    </section>
  )
}

function UnconfirmedRow({ item }: { item: KairosItem }) {
  const queryClient = useQueryClient()
  const outreachId = text(item.result?.outreachId) ?? ""
  const channel = text(item.result?.channel) ?? channelOf(item)
  const resolve = useMutation({
    mutationFn: async (outcome: "salio" | "no_salio") =>
      api(`/api/admin/clients/outreach/${outreachId}/resolve`, {
        method: "POST",
        body: JSON.stringify({ outcome }),
      }),
    onSuccess: (_data, outcome) => {
      invalidateArm(queryClient, item.clientId)
      toast.success(outcome === "salio" ? "Anotado: salió" : "Anotado: no salió")
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  return (
    <li className="flex flex-wrap items-center gap-3 p-4">
      <div className="min-w-0 flex-1 basis-60">
        <p className="flex flex-wrap items-center gap-x-2 font-medium [overflow-wrap:anywhere]">
          {item.clientId && item.clientName ? (
            <ClientName clientId={item.clientId} tab="historial">
              {item.clientName}
            </ClientName>
          ) : (
            <span>{item.clientName ?? "Sin cliente"}</span>
          )}
          {item.product ? <ProductMark product={item.product} /> : null}
        </p>
        <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {channel === "whatsapp" ? "WhatsApp abierto" : "Correo que no se sabe si salió"} ·{" "}
          {item.title}
          {item.decidedAt
            ? ` · ${item.decidedByName ? `lo aprobó ${item.decidedByName} ` : ""}el ${supportDayTime(item.decidedAt)}`
            : ""}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={resolve.isPending || !outreachId}
          onClick={() => resolve.mutate("salio")}
        >
          Salió
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={resolve.isPending || !outreachId}
          onClick={() => resolve.mutate("no_salio")}
        >
          No salió
        </Button>
      </div>
    </li>
  )
}
