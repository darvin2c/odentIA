/**
 * Nuevo proveedor en dos campos (tablero 13): nombre y teléfono a la vista;
 * documento, correo y dirección plegados en «Más datos». El tipo de documento
 * se elige de una lista para que «RUC» y «ruc» no cuenten como distintos.
 */
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  Textarea,
  toast,
} from "@odentia/ui"
import { FormDrawer, isValidE164, PhoneInput, regionCountry, toE164 } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import * as React from "react"
import {
  createSupplier,
  fetchSuppliers,
  inventoryErrorMessage,
  inventoryKeys,
  type SupplierBody,
  type SupplierItem,
  updateSupplier,
} from "../../lib/inventory"
import { isAmbiguousMutationError } from "../../lib/query-error"
import { ChoiceSelect } from "../ui/choice-select"
import { Optional } from "./fields"
import { useInventory } from "./inventory-scope"

const OTHER = "__otro__"

/** El teléfono guardado como lo entiende el campo (E.164), si se puede leer. */
function phoneValue(phone: string | null | undefined): string | null {
  if (!phone) return null
  if (isValidE164(phone)) return phone
  return toE164(phone, regionCountry())
}

/**
 * Los tipos de documento que se ofrecen: el documento fiscal de la clínica
 * (así lo llama su país: RUC, NIT, RFC…) y los que ya usan sus proveedores,
 * en mayúsculas. El perfil del país todavía no trae la lista tributaria.
 */
export function useSupplierDocTypes(): string[] {
  const { fiscalDocType } = useInventory()
  const suppliers = useQuery({ queryKey: inventoryKeys.suppliers(), queryFn: () => fetchSuppliers() })
  return React.useMemo(() => {
    const seen = new Set<string>()
    for (const value of [fiscalDocType, ...(suppliers.data ?? []).map((item) => item.docType)]) {
      const text = value?.trim().toLocaleUpperCase("es")
      if (text) seen.add(text)
    }
    return [...seen]
  }, [fiscalDocType, suppliers.data])
}

type FieldKey = "name" | "phone" | "doc" | "email" | "address"

function fieldOfMessage(message: string): FieldKey | null {
  if (/documento/i.test(message)) return "doc"
  if (/correo/i.test(message)) return "email"
  if (/teléfono/i.test(message)) return "phone"
  if (/dirección/i.test(message)) return "address"
  if (/nombre/i.test(message)) return "name"
  return null
}

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
  const ids = React.useId()
  const docTypes = useSupplierDocTypes()
  const [initial] = React.useState(() => ({
      name: supplier?.name ?? "",
      phone: phoneValue(supplier?.phone),
      docType: supplier?.docType?.trim().toLocaleUpperCase("es") ?? "",
      docNumber: supplier?.docNumber ?? "",
      email: supplier?.email ?? "",
      address: supplier?.address ?? "",
  }))
  const [values, setValues] = React.useState(initial)
  const [otherType, setOtherType] = React.useState(false)
  const [errors, setErrors] = React.useState<Partial<Record<FieldKey, string>>>({})
  const [formError, setFormError] = React.useState<string | null>(null)
  const [moreOpen, setMoreOpen] = React.useState(Boolean(supplier?.docNumber || supplier?.email || supplier?.address))
  const set = <K extends keyof typeof initial>(key: K, value: (typeof initial)[K]) => setValues((current) => ({ ...current, [key]: value }))
  const dirty = JSON.stringify(values) !== JSON.stringify(initial)
  // Sin tipos conocidos, o con uno que no está en la lista, se escribe.
  const typeOptions = values.docType && !docTypes.includes(values.docType) ? [...docTypes, values.docType] : docTypes
  const writing = otherType || typeOptions.length === 0

  const mutation = useMutation({
    mutationFn: (body: SupplierBody) => (supplier ? updateSupplier(supplier.id, body) : createSupplier(body)),
    onSuccess: (saved) => {
      toast.success(supplier ? "Cambios guardados" : `${saved.name} quedó entre tus proveedores`)
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
      onSaved?.({ ...saved, orders: supplier?.orders ?? 0 })
      onClose()
    },
    onError: (error) => {
      const message = inventoryErrorMessage(error, { repeatable: Boolean(supplier) })
      const field = isAmbiguousMutationError(error) ? null : fieldOfMessage(message)
      if (field) {
        setErrors({ [field]: message })
        if (field !== "name" && field !== "phone") setMoreOpen(true)
        setFormError(null)
      } else setFormError(message)
    },
  })

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (mutation.isPending || (!supplier && isAmbiguousMutationError(mutation.error))) return
    const found: Partial<Record<FieldKey, string>> = {}
    if (!values.name.trim()) found.name = "Escribe el nombre o la razón social."
    if (values.docNumber.trim() && !values.docType.trim()) found.doc = "Elige el tipo de documento junto con su número."
    if (values.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) found.email = "Escribe un correo válido, como ventas@proveedor.com."
    setErrors(found)
    if (Object.keys(found).length > 0) {
      if (found.doc || found.email) setMoreOpen(true)
      return
    }
    const next: SupplierBody = {
      name: values.name.trim(),
      phone: values.phone,
      docType: values.docType.trim().toLocaleUpperCase("es") || null,
      docNumber: values.docNumber.trim() || null,
      email: values.email.trim() || null,
      address: values.address.trim() || null,
    }
    // Al editar viaja solo lo que cambió: un teléfono viejo que el campo no lee no se borra.
    const body: SupplierBody = supplier
      ? Object.fromEntries(
          Object.entries(next).filter(([key, value]) => value !== (key === "phone" ? initial.phone : (initial[key as keyof typeof initial] || null))),
        )
      : next
    setFormError(null)
    mutation.mutate(body)
  }

  const errorOf = (key: FieldKey) => (errors[key] ? <FieldError>{errors[key]}</FieldError> : null)

  return (
    <FormDrawer
      open
      onClose={onClose}
      title={supplier ? "Editar proveedor" : "Nuevo proveedor"}
      error={formError}
      isDirty={dirty}
      isSubmitting={mutation.isPending}
      submitDisabled={!supplier && isAmbiguousMutationError(mutation.error)}
      submitLabel="Guardar"
      cancelLabel="Cancelar"
      onSubmit={submit}
    >
      <FieldGroup>
        <Field data-invalid={errors.name ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-nombre`}>Nombre o razón social</FieldLabel>
          <Input
            id={`${ids}-nombre`}
            autoFocus={!supplier}
            maxLength={200}
            value={values.name}
            aria-invalid={errors.name ? true : undefined}
            onChange={(event) => set("name", event.target.value)}
          />
          {errorOf("name")}
        </Field>
        <Field data-invalid={errors.phone ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-telefono`}>
            Celular o teléfono <Optional />
          </FieldLabel>
          <PhoneInput id={`${ids}-telefono`} value={values.phone} invalid={Boolean(errors.phone)} aria-describedby={`${ids}-telefono-ayuda`} onChange={(next) => set("phone", next)} />
          <FieldDescription id={`${ids}-telefono-ayuda`}>Para «Copiar el pedido» y escribirle.</FieldDescription>
          {errorOf("phone")}
        </Field>

        <Collapsible className="flex flex-col gap-4" open={moreOpen} onOpenChange={setMoreOpen}>
          <CollapsibleTrigger
            render={
              <Button type="button" variant="link" className="group h-auto min-h-11 self-start p-0 sm:min-h-8">
                Más datos <span className="font-normal text-muted-foreground">documento, correo y dirección</span>
                <ChevronDown aria-hidden className="transition-transform group-data-[panel-open]:rotate-180 motion-reduce:transition-none" />
              </Button>
            }
          />
          <CollapsibleContent className="flex flex-col gap-6">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
              <Field data-invalid={errors.doc ? true : undefined}>
                <FieldLabel htmlFor={`${ids}-tipo`}>Documento</FieldLabel>
                {typeOptions.length > 0 ? (
                  <ChoiceSelect
                    id={`${ids}-tipo`}
                    value={writing ? OTHER : values.docType}
                    placeholder="Tipo"
                    aria-invalid={Boolean(errors.doc)}
                    onChange={(event) => {
                      const next = event.target.value
                      if (next === OTHER) {
                        setOtherType(true)
                        set("docType", "")
                        return
                      }
                      setOtherType(false)
                      set("docType", next)
                    }}
                  >
                    <option value="">Sin documento</option>
                    {typeOptions.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                    <option value={OTHER}>Otro…</option>
                  </ChoiceSelect>
                ) : null}
                {writing ? (
                  <Input
                    id={typeOptions.length > 0 ? undefined : `${ids}-tipo`}
                    aria-label="Tipo de documento"
                    maxLength={20}
                    placeholder="RUC, NIT, RFC…"
                    value={values.docType}
                    aria-describedby={`${ids}-tipo-ayuda`}
                    onChange={(event) => set("docType", event.target.value)}
                  />
                ) : null}
                {writing ? <FieldDescription id={`${ids}-tipo-ayuda`}>Como se llama en tu país el documento tributario.</FieldDescription> : null}
              </Field>
              <Field data-invalid={errors.doc ? true : undefined}>
                <FieldLabel htmlFor={`${ids}-numero`}>Número</FieldLabel>
                <Input
                  id={`${ids}-numero`}
                  maxLength={50}
                  inputMode="numeric"
                  value={values.docNumber}
                  aria-invalid={errors.doc ? true : undefined}
                  onChange={(event) => set("docNumber", event.target.value)}
                />
                {errorOf("doc")}
              </Field>
            </div>
            <Field data-invalid={errors.email ? true : undefined}>
              <FieldLabel htmlFor={`${ids}-correo`}>
                Correo <Optional />
              </FieldLabel>
              <Input
                id={`${ids}-correo`}
                type="email"
                maxLength={200}
                autoComplete="off"
                value={values.email}
                aria-invalid={errors.email ? true : undefined}
                onChange={(event) => set("email", event.target.value)}
              />
              {errorOf("email")}
            </Field>
            <Field data-invalid={errors.address ? true : undefined}>
              <FieldLabel htmlFor={`${ids}-direccion`}>
                Dirección <Optional />
              </FieldLabel>
              <Textarea id={`${ids}-direccion`} maxLength={500} value={values.address} onChange={(event) => set("address", event.target.value)} />
              {errorOf("address")}
            </Field>
          </CollapsibleContent>
        </Collapsible>
      </FieldGroup>
    </FormDrawer>
  )
}
