/**
 * Nuevo proveedor en dos campos (tablero 13): nombre y teléfono a la vista;
 * documento, correo y dirección plegados en «Más datos». El tipo de documento
 * se elige de la lista del país de la clínica (`supplierDocChoices`): se guarda
 * su código y no se escribe a mano.
 */
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, FieldGroup, toast } from "@odentia/ui"
import { FormDrawer, isValidE164, regionCountry, toE164, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import * as React from "react"
import { z } from "zod"
import {
  createSupplier,
  inventoryKeys,
  inventoryUnconfirmedMessage,
  type SupplierBody,
  type SupplierItem,
  supplierDocChoices,
  updateSupplier,
} from "../../lib/inventory"
import { useClinicalProfile } from "../../lib/org"
import { isAmbiguousMutationError } from "../../lib/query-error"
import { ChoiceSelect } from "../ui/choice-select"
import { Optional } from "./fields"

/** El teléfono guardado como lo entiende el campo (E.164), si se puede leer. */
function phoneValue(phone: string | null | undefined): string | null {
  if (!phone) return null
  if (isValidE164(phone)) return phone
  return toE164(phone, regionCountry())
}

// Los mismos topes que la ruta (`supplierInput`).
const supplierSchema = z
  .object({
    name: z.string().trim().min(1, "Escribe el nombre o la razón social.").max(200, "El nombre admite hasta 200 caracteres."),
    phone: z.string().nullable(),
    docType: z.string(),
    docNumber: z.string().trim().max(50, "El número admite hasta 50 caracteres."),
    email: z
      .string()
      .trim()
      .max(200, "El correo admite hasta 200 caracteres.")
      .refine((value) => !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), "Escribe un correo válido, como ventas@proveedor.com."),
    address: z.string().trim().max(500, "La dirección admite hasta 500 caracteres."),
  })
  .superRefine((value, ctx) => {
    if (value.docNumber && !value.docType.trim())
      ctx.addIssue({ code: "custom", path: ["docType"], message: "Elige el tipo de documento junto con su número." })
  })

type SupplierValues = z.input<typeof supplierSchema>

/** Lo que va plegado en «Más datos»: con un error ahí, se abre. */
const MORE_FIELDS = ["docType", "docNumber", "email", "address"] as const

export function SupplierFormDrawer({
  supplier,
  onClose,
  onSaved,
}: {
  supplier: SupplierItem | null
  onClose: () => void
  onSaved?: (saved: SupplierItem) => void
}) {
  const queryClient = useQueryClient()
  const profile = useClinicalProfile()
  const [initial] = React.useState<SupplierValues>(() => ({
    name: supplier?.name ?? "",
    phone: phoneValue(supplier?.phone),
    docType: supplier?.docType?.trim().toLocaleUpperCase("es") ?? "",
    docNumber: supplier?.docNumber ?? "",
    email: supplier?.email ?? "",
    address: supplier?.address ?? "",
  }))
  const [moreOpen, setMoreOpen] = React.useState(Boolean(supplier?.docNumber || supplier?.email || supplier?.address))
  // La lista del país; un tipo antiguo que no está en ella se conserva tal cual.
  const typeOptions = supplierDocChoices(profile, initial.docType || null)

  const mutation = useMutation({
    mutationFn: (body: SupplierBody) => (supplier ? updateSupplier(supplier.id, body) : createSupplier(body)),
    onSuccess: (saved) => {
      toast.success(supplier ? "Cambios guardados" : `${saved.name} quedó entre tus proveedores`)
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
      onSaved?.({ ...saved, orders: supplier?.orders ?? 0 })
      onClose()
    },
  })
  // Crear sin clave: tras una respuesta que no llegó, otro envío podría duplicarlo.
  const blocked = !supplier && isAmbiguousMutationError(mutation.error)

  const form = useAppForm({
    defaultValues: initial,
    validators: { onSubmit: supplierSchema },
    onSubmit: async ({ value }) => {
      const next: SupplierBody = {
        name: value.name.trim(),
        phone: value.phone,
        docType: value.docType || null,
        docNumber: value.docNumber.trim() || null,
        email: value.email.trim() || null,
        address: value.address.trim() || null,
      }
      // Al editar viaja solo lo que cambió: un teléfono viejo que el campo no lee no se borra.
      const body: SupplierBody = supplier
        ? Object.fromEntries(
            Object.entries(next).filter(([key, item]) => item !== (key === "phone" ? initial.phone : (initial[key as keyof SupplierValues] || null))),
          )
        : next
      await mutation.mutateAsync(body)
    },
  })
  const surface = useFormSurface(form, { formMessage: (error) => inventoryUnconfirmedMessage(error, { repeatable: Boolean(supplier) }) })

  // Un error de lo plegado (del cliente o del servidor) abre «Más datos»: nunca queda escondido.
  const hiddenError = useStore(form.store, (state) =>
    MORE_FIELDS.some((name) => Object.values(state.fieldMeta[name]?.errorMap ?? {}).some(Boolean)),
  )
  React.useEffect(() => {
    if (hiddenError) setMoreOpen(true)
  }, [hiddenError])

  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title={supplier ? "Editar proveedor" : "Nuevo proveedor"}
      submitDisabled={blocked}
      // Mientras no se pueda volver a guardar, el porqué sigue a la vista aunque se escriba.
      error={blocked ? inventoryUnconfirmedMessage(mutation.error, { repeatable: false }) : surface.error}
      // Enter tampoco reenvía: el aviso de que no se pudo confirmar sigue a la vista.
      onSubmit={(event) => (blocked ? event.preventDefault() : surface.onSubmit(event))}
      submitLabel="Guardar"
      cancelLabel="Cancelar"
    >
      <FieldGroup>
        <form.AppField name="name">
          {(field) => <field.TextField label="Nombre o razón social" autoFocus={!supplier} maxLength={200} />}
        </form.AppField>
        <form.AppField name="phone">
          {(field) => (
            <field.PhoneField
              label={
                <>
                  Celular o teléfono <Optional />
                </>
              }
              description="Para «Copiar el pedido» y escribirle."
            />
          )}
        </form.AppField>

        <Collapsible className="flex flex-col gap-4" open={moreOpen} onOpenChange={setMoreOpen}>
          <CollapsibleTrigger
            render={
              <Button type="button" variant="link" className="group h-auto min-h-11 self-start p-0 sm:min-h-8">
                Más datos <span className="font-normal text-muted-foreground">documento, correo y dirección</span>
                <ChevronDown aria-hidden className="transition-transform group-data-[panel-open]:rotate-180 motion-reduce:transition-none" />
              </Button>
            }
          />
          {/* Montado aunque esté plegado: lo que el servidor diga de estos campos llega a ellos. */}
          <CollapsibleContent keepMounted className="flex flex-col gap-6">
            {/* Ancho para «Carné de extranjería» o «Documento tributario» sin cortarse. */}
            <div className="grid gap-4 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
              <form.AppField name="docType">
                {(field) => (
                  <field.Control label="Documento">
                    {(control) => (
                      <ChoiceSelect
                        {...control.props}
                        value={field.state.value}
                        placeholder="Tipo"
                        onChange={(event) => field.handleChange(event.target.value)}
                      >
                        <option value="">Sin documento</option>
                        {typeOptions.map((type) => (
                          <option key={type.value} value={type.value}>
                            {type.label}
                          </option>
                        ))}
                      </ChoiceSelect>
                    )}
                  </field.Control>
                )}
              </form.AppField>
              <form.AppField name="docNumber">
                {(field) => <field.TextField label="Número" maxLength={50} inputMode="numeric" />}
              </form.AppField>
            </div>
            <form.AppField name="email">
              {(field) => (
                <field.TextField
                  label={
                    <>
                      Correo <Optional />
                    </>
                  }
                  type="email"
                  maxLength={200}
                  autoComplete="off"
                />
              )}
            </form.AppField>
            <form.AppField name="address">
              {(field) => (
                <field.TextareaField
                  label={
                    <>
                      Dirección <Optional />
                    </>
                  }
                  maxLength={500}
                />
              )}
            </form.AppField>
          </CollapsibleContent>
        </Collapsible>
      </FieldGroup>
    </FormDrawer>
  )
}
