/**
 * «Nuevo cliente» (tablero 2 del lienzo de Clientes): la clínica que llegó sin
 * llenar la web —un referido, un evento, un WhatsApp, una que salimos a
 * buscar—. Se piden pocos datos; lo demás se completa en la ficha. Si el
 * servidor encuentra una que puede ser la misma (por correo, por solicitud o
 * por nombre; el teléfono es solo una pista), pregunta «¿Es la misma clínica?»
 * con «Abrir esa» y «Es otra clínica», que vuelve a guardar diciendo que es
 * nueva (`confirmNew`). Nada se une solo.
 *
 * Desde un correo sin cliente (Kairós) llega con el correo y el nombre de
 * quien escribió (`initial`) y, al guardarlo, liga el correo (`onCreated`);
 * si era una que ya existía, «Es esta: ligar el correo» la usa.
 */
import { CLINICAL_PRODUCTS, type ClinicalProduct, productWords } from "@odentia/clinical"
import { Button, toast } from "@odentia/ui"
import { ToggleGroup, ToggleGroupItem } from "@odentia/ui/components/toggle-group"
import {
  AgentMark,
  AgentSurface,
  common,
  FormDrawer,
  submitErrorMessage,
  submitForm,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import * as React from "react"
import { z } from "zod"
import { ApiError, api } from "../../lib/api"
import { CLIENT_ORIGIN_NAMES } from "../../lib/list-search"
import { useIsAdmin } from "../../lib/session"
import { ProductDot } from "../product"
import {
  clientCreatedSchema,
  type DuplicateHint,
  duplicateSchema,
  ORIGIN_WORDS,
  staffSchema,
} from "./client-model"

const formSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Escribe el nombre de la clínica")
      .max(160, "Usa como máximo 160 caracteres"),
    product: z.enum(CLINICAL_PRODUCTS, "Elige el producto"),
    contactName: z
      .string()
      .trim()
      .min(1, "Escribe el nombre de la persona")
      .max(160, "Usa como máximo 160 caracteres"),
    phone: z.string().nullable(),
    email: z.union([
      z.literal(""),
      z.email("Escribe un correo válido, como nombre@clinica.com").max(254),
    ]),
    origin: z.union([z.literal(""), z.enum(CLIENT_ORIGIN_NAMES)]),
    originDetail: z.string().trim().max(300, "Usa como máximo 300 caracteres"),
    ownerUserId: z.string(),
  })
  .superRefine((value, ctx) => {
    if (!value.origin)
      ctx.addIssue({ code: "custom", path: ["origin"], message: "Elige cómo llegó" })
    if (!value.phone && !value.email.trim()) {
      const message = "Escribe el celular o el correo de la persona"
      ctx.addIssue({ code: "custom", path: ["phone"], message })
      ctx.addIssue({ code: "custom", path: ["email"], message })
    }
  })

export type NewClientValues = z.input<typeof formSchema>
type FormValues = NewClientValues

const DEFAULTS: FormValues = {
  name: "",
  product: "dental",
  contactName: "",
  phone: null,
  email: "",
  origin: "",
  originDetail: "",
  ownerUserId: "",
}

/** El servidor señala los datos de la persona como `contact.*`: aquí son campos sueltos. */
const FIELD_MAP = {
  "contact.name": "contactName",
  "contact.phone": "phone",
  "contact.email": "email",
}

const duplicatesOf = (error: unknown): DuplicateHint[] | null => {
  if (
    !(error instanceof ApiError) ||
    error.status !== 409 ||
    error.shape.code !== "CLIENT_MAYBE_DUPLICATE"
  )
    return null
  const parsed = z.array(duplicateSchema).safeParse(error.details.duplicates)
  return parsed.success ? parsed.data : []
}

/**
 * El equipo, para elegir responsable. Solo Administración lo lee (y solo ella
 * elige otro responsable): Soporte no lo pide, que la API le responde 403.
 */
export function useStaff() {
  const isAdmin = useIsAdmin()
  return useQuery({
    enabled: isAdmin,
    queryKey: ["admin", "staff"],
    queryFn: async () =>
      staffSchema
        .parse(await api<unknown>("/api/admin/access/team"))
        .staff.filter((row) => row.active),
    staleTime: 5 * 60_000,
  })
}

export function NewClientDrawer({
  open,
  onClose,
  initial,
  title = "Nuevo cliente",
  onCreated,
}: {
  open: boolean
  onClose: () => void
  /** Lo que ya se sabe (el remitente de un correo). */
  initial?: Partial<NewClientValues>
  title?: string
  /**
   * Lo que sigue al guardarlo, con el cliente nuevo o el que ya existía
   * («Es esta»): ligar el correo. Si falla, el cliente queda y se dice.
   */
  onCreated?: (clientId: string) => Promise<void>
}) {
  const isAdmin = useIsAdmin()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const staff = useStaff()
  const [duplicates, setDuplicates] = React.useState<DuplicateHint[] | null>(null)
  const confirmNew = React.useRef(false)

  const form = useAppForm({
    defaultValues: { ...DEFAULTS, ...initial },
    validators: { onSubmit: formSchema },
    onSubmit: async ({ value, formApi }) => {
      const body = {
        name: value.name.trim(),
        product: value.product,
        contact: {
          name: value.contactName.trim(),
          ...(value.phone ? { phone: value.phone } : {}),
          ...(value.email.trim() ? { email: value.email.trim().toLowerCase() } : {}),
        },
        origin: value.origin,
        ...(value.originDetail.trim() ? { originDetail: value.originDetail.trim() } : {}),
        ...(isAdmin && value.ownerUserId ? { ownerUserId: value.ownerUserId } : {}),
        ...(confirmNew.current ? { confirmNew: true } : {}),
      }
      let raw: unknown
      try {
        raw = await api<unknown>("/api/admin/clients", {
          method: "POST",
          body: JSON.stringify(body),
        })
      } catch (error) {
        const found = duplicatesOf(error)
        if (!found) throw error
        // Puede ser la misma: lo decide la persona, no se guarda nada todavía.
        setDuplicates(found)
        return
      }
      const created = clientCreatedSchema.parse(raw)
      if (onCreated) await follow(created.id, body.name)
      void queryClient.invalidateQueries({ queryKey: ["admin", "clients"] })
      void queryClient.invalidateQueries({ queryKey: ["admin", "kairos"] })
      void queryClient.invalidateQueries({ queryKey: ["admin", "overview"] })
      toast.success(`${body.name} quedó como cliente`)
      // Lo que se parecía solo por el celular no frena: se dice para que se revise.
      for (const hint of created.duplicates) toast.message(hint.words)
      formApi.reset()
      setDuplicates(null)
      confirmNew.current = false
      onClose()
      void navigate({ to: "/clients/$clientId", params: { clientId: created.id } })
    },
  })
  const surface = useFormSurface(form, { fieldMap: FIELD_MAP })
  /** Lo que sigue al cliente (ligar el correo); si falla, el cliente ya quedó y se dice cómo seguir. */
  async function follow(clientId: string, name: string) {
    try {
      await onCreated?.(clientId)
    } catch (error) {
      toast.error(
        `${name}: el correo no se ligó (${submitErrorMessage(error)}). Lígalo desde Kairós.`,
      )
    }
  }

  const close = () => {
    setDuplicates(null)
    confirmNew.current = false
    onClose()
  }
  const openExisting = async (hint: DuplicateHint) => {
    if (onCreated && hint.clientId) await follow(hint.clientId, hint.words)
    close()
    form.reset()
    if (hint.clientId)
      void navigate({ to: "/clients/$clientId", params: { clientId: hint.clientId } })
    else if (hint.requestId)
      void navigate({ to: "/waitlist", search: { solicitud: hint.requestId } })
  }
  const saveAsNew = () => {
    confirmNew.current = true
    setDuplicates(null)
    void submitForm(form, { fieldMap: FIELD_MAP })
  }

  const staffOptions = [
    { value: "", label: "Yo, que lo creo" },
    ...(staff.data ?? []).map((row) => ({ value: row.userId, label: row.name || row.email })),
  ]

  return (
    <FormDrawer
      {...surface}
      open={open}
      onClose={close}
      title={title}
      description="Basta la clínica, una persona y cómo contactarla. Lo demás se completa en su ficha."
      submitLabel="Guardar cliente"
      cancelLabel={common.actions.cancel}
    >
      <div className="flex flex-col gap-4">
        <form.AppField name="name">
          {(field) => (
            <field.TextField
              id="cliente-nombre"
              label="Clínica"
              placeholder="Ej.: Dental Andes"
              maxLength={160}
              autoComplete="off"
              autoFocus
            />
          )}
        </form.AppField>

        {duplicates ? (
          <AgentSurface
            aria-labelledby="cliente-misma"
            className="flex flex-col gap-3 p-4"
            role="group"
          >
            <div className="flex items-start gap-2.5">
              <AgentMark size="sm" />
              <div className="flex min-w-0 flex-col gap-1">
                <h3 id="cliente-misma" className="text-sm font-semibold">
                  ¿Es la misma clínica?
                </h3>
                {duplicates.length ? (
                  <ul className="flex flex-col gap-1 text-sm">
                    {duplicates.map((hint) => (
                      <li
                        key={hint.clientId ?? hint.requestId ?? hint.words}
                        className="flex flex-wrap items-center gap-x-2 gap-y-1"
                      >
                        <span className="min-w-0 [overflow-wrap:anywhere]">
                          {hint.words}
                          {hint.hasAccount ? " · ya tiene cuenta" : ""}
                        </span>
                        {hint.clientId || hint.requestId ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => void openExisting(hint)}
                          >
                            {onCreated && hint.clientId ? "Es esta: ligar el correo" : "Abrir esa"}
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm">
                    Encontré una clínica parecida, pero ya no está a la vista.
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Se busca por correo y por nombre. El celular solo es una pista: nunca une a nadie.
                </p>
              </div>
            </div>
            <div>
              <Button
                type="button"
                variant="secondary"
                onClick={saveAsNew}
                disabled={surface.isSubmitting}
              >
                Es otra clínica: guardarla
              </Button>
            </div>
          </AgentSurface>
        ) : null}

        <form.AppField name="product">
          {(field) => (
            <field.Group legend="Producto" id="cliente-producto">
              {() => (
                <ToggleGroup
                  aria-label="Producto"
                  value={[field.state.value]}
                  onValueChange={(next: unknown[]) => {
                    const picked = next[0]
                    if ((CLINICAL_PRODUCTS as readonly unknown[]).includes(picked))
                      field.handleChange(picked as ClinicalProduct)
                  }}
                  spacing={1}
                  className="flex-wrap justify-start"
                >
                  {CLINICAL_PRODUCTS.map((product) => (
                    <ToggleGroupItem
                      key={product}
                      value={product}
                      className="h-auto min-h-9 gap-1.5 rounded-3xl border px-3 py-1.5 text-sm aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:font-semibold"
                    >
                      <ProductDot product={product} />
                      {productWords(product).name}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              )}
            </field.Group>
          )}
        </form.AppField>

        <form.AppField name="contactName">
          {(field) => (
            <field.TextField
              id="cliente-persona"
              label="Persona"
              placeholder="Con quién hablamos"
              maxLength={160}
              autoComplete="off"
            />
          )}
        </form.AppField>
        <form.AppField name="phone">
          {(field) => (
            <field.PhoneField
              id="cliente-celular"
              label="Celular (WhatsApp)"
              description="El celular o el correo: al menos uno."
              defaultCountry="PE"
            />
          )}
        </form.AppField>
        <form.AppField name="email">
          {(field) => (
            <field.TextField
              id="cliente-correo"
              label="Correo"
              type="email"
              placeholder="Si lo tienes"
              maxLength={254}
              autoComplete="off"
            />
          )}
        </form.AppField>
        <form.AppField name="origin">
          {(field) => (
            <field.SelectField
              id="cliente-origen"
              label="Cómo llegó"
              placeholder="Elige cómo llegó"
              options={CLIENT_ORIGIN_NAMES.map((origin) => ({
                value: origin,
                label: ORIGIN_WORDS[origin],
              }))}
            />
          )}
        </form.AppField>
        <form.AppField name="originDetail">
          {(field) => (
            <field.TextField
              id="cliente-origen-detalle"
              label="Quién la refirió o dónde la conocimos (opcional)"
              placeholder="Ej.: la refirió Clínica Norte"
              maxLength={300}
            />
          )}
        </form.AppField>
        {/* Otro responsable lo pone solo Administración: a Soporte le queda el suyo. */}
        {isAdmin ? (
          <form.AppField name="ownerUserId">
            {(field) => (
              <field.SelectField
                id="cliente-responsable"
                label="Responsable"
                options={staffOptions}
              />
            )}
          </form.AppField>
        ) : (
          <p className="text-sm text-muted-foreground">
            Quedas como responsable. Administración puede pasárselo a otra persona.
          </p>
        )}
      </div>
    </FormDrawer>
  )
}
