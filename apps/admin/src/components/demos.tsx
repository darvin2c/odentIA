import { CLINICAL_PRODUCTS, type ClinicalProduct } from "@odentia/clinical"
import {
  Badge,
  Button,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Skeleton,
  toast,
} from "@odentia/ui"
import {
  ConfirmDialog,
  DetailDrawer,
  ErrorState,
  FormDrawer,
  common,
  submitErrorMessage,
  submitForm,
  useAppForm,
  useFormSubmitError,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { z } from "zod"
import { api } from "../lib/api"
import { platformUrl } from "../lib/host"
import { ProductMark } from "./product"

/**
 * Las demos para presentar en la administración (ADR 0096; lienzo «Demos
 * para presentar», tableros 1 a 4b): crearlas, ver cómo se arman, abrirlas,
 * volver a empezar y borrarlas. Lo que dicen sale del servidor
 * (`/api/admin/demos`); crear, volver a empezar y borrar son de la
 * administración, y el servidor lo exige.
 */

const progressSchema = z.object({ step: z.string(), done: z.number(), total: z.number() })

export const demoSchema = z.object({
  id: z.string(),
  organizationId: z.string().nullable(),
  product: z.enum(CLINICAL_PRODUCTS),
  kind: z.string(),
  kindName: z.string(),
  size: z.string(),
  sizeName: z.string(),
  months: z.number(),
  countryCode: z.string(),
  countryName: z.string(),
  name: z.string(),
  slug: z.string(),
  presenter: z.object({ id: z.string(), name: z.string() }),
  status: z.enum(["pendiente", "creando", "lista", "fallida"]),
  progress: progressSchema.nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  readyAt: z.string().nullable(),
  lastUsedAt: z.string(),
  expiresAt: z.string(),
  expiresSoon: z.boolean(),
})
export type DemoItem = z.infer<typeof demoSchema>

const showcaseSchema = z.object({
  today: z.string(),
  agendaToday: z.number(),
  unconfirmed: z.number(),
  openTopics: z.number(),
  byAgent: z.number(),
  controlsDue: z.number(),
  controlsLabel: z.string(),
  agendaThrough: z.string().nullable(),
})

const demoDetailSchema = z.object({
  demo: demoSchema.extend({ showcase: showcaseSchema.nullable() }).nullable(),
})
export type DemoDetail = NonNullable<z.infer<typeof demoDetailSchema>["demo"]>

const optionsSchema = z.object({
  products: z.array(
    z.object({
      product: z.enum(CLINICAL_PRODUCTS),
      kinds: z.array(
        z.object({
          key: z.string(),
          name: z.string(),
          hint: z.string(),
          names: z.record(z.string(), z.array(z.string())),
        }),
      ),
    }),
  ),
  sizes: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      professionals: z.number(),
      branches: z.number(),
      patients: z.number(),
    }),
  ),
  months: z.array(z.number()),
  countries: z.array(z.object({ code: z.string(), name: z.string() })),
  presenters: z.array(z.object({ id: z.string(), name: z.string(), email: z.string() })),
})

/** Los pasos del armado, como los dice el avance (tablero 4). */
const STEPS: Array<{ key: string; title: string; detail: (demo: DemoItem) => string }> = [
  {
    key: "equipo",
    title: "La clínica y su equipo",
    detail: (demo) =>
      `${demo.sizeName}: sedes, ${demo.product === "dental" ? "unidades" : "consultorios"}, quien atiende y su horario`,
  },
  {
    key: "tarifario",
    title: "El tarifario",
    detail: (demo) => `Los servicios de ${demo.kindName} con precios de ${demo.countryName}`,
  },
  {
    key: "historia",
    title: "La historia",
    detail: (demo) =>
      `${demo.months} meses de citas, atenciones, cobros y conversaciones, día por día`,
  },
  {
    key: "agentes",
    title: "Lo que hicieron los agentes",
    detail: () => "Sofi, Clío y Argos, con lo que costó cada uno",
  },
  {
    key: "hoy",
    title: "Hoy y las próximas dos semanas",
    detail: () => "La agenda de hoy, lo que espera en la Bandeja y los controles que vencen",
  },
  {
    key: "operacion",
    title: "Lo que el equipo ya usa",
    detail: () =>
      "Inventario con sus compras, promociones, comisiones, oportunidades y lo que Sofi ya sabe responder",
  },
]

/** Las demos, al día mientras alguna se arma. */
export function useDemos(enabled = true) {
  return useQuery({
    queryKey: ["admin-demos"],
    enabled,
    queryFn: async () =>
      z.object({ items: z.array(demoSchema) }).parse(await api<unknown>("/api/admin/demos")).items,
    refetchInterval: (query) =>
      query.state.data?.some((demo) => demo.status === "pendiente" || demo.status === "creando")
        ? 3_000
        : false,
  })
}

/** «Pediatría · mediano · 12 meses · al día», la línea de una demo en su tarjeta. */
export function demoLine(demo: DemoItem): string {
  return `${demo.kindName} · ${demo.sizeName.toLowerCase()} · ${demo.months} meses · ${demo.status === "lista" ? "al día" : demo.status === "fallida" ? "no se pudo crear" : "creándose"}`
}

const shortDay = (iso: string) =>
  new Intl.DateTimeFormat("es", { day: "numeric", month: "short" })
    .format(new Date(iso))
    .replaceAll(".", "")

/** La etiqueta de una demo: «Demo», «Creando… 40 %», «No se pudo crear» o «Se borra el 4 dic». */
export function DemoBadge({ demo }: { demo: DemoItem }) {
  if (demo.status === "pendiente" || demo.status === "creando") {
    const percent = demo.progress
      ? Math.round((demo.progress.done / Math.max(1, demo.progress.total)) * 100)
      : 0
    return <Badge variant="secondary">Creando… {percent} %</Badge>
  }
  if (demo.status === "fallida") return <Badge variant="destructive">No se pudo crear</Badge>
  if (demo.expiresSoon)
    return <Badge variant="warning">Se borra el {shortDay(demo.expiresAt)}</Badge>
  return <Badge variant="outline">Demo</Badge>
}

/** La tarjeta de una demo que todavía no es clínica: se arma o falló (tablero 1). */
export function PendingDemoCard({ demo, onOpen }: { demo: DemoItem; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex h-full w-full flex-col gap-1.5 rounded-xl border border-dashed bg-card p-3 text-left text-sm hover:border-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <ProductMark product={demo.product} />
      <span className="flex flex-wrap items-center gap-2 font-medium">
        <span className="min-w-0 flex-1 truncate">{demo.name}</span>
        <DemoBadge demo={demo} />
      </span>
      <span className="text-xs text-muted-foreground">
        {demo.kindName} · {demo.sizeName.toLowerCase()} · {demo.months} meses · la presenta{" "}
        {demo.presenter.name}
      </span>
    </button>
  )
}

/** Un nombre de ejemplo del tipo y el país, para «Otro». */
const pickName = (names: string[] | undefined) =>
  names && names.length > 0 ? (names[Math.floor(Math.random() * names.length)] as string) : ""

type DemoOptions = z.infer<typeof optionsSchema>
type DemoKindOption = DemoOptions["products"][number]["kinds"][number]

const kindsOf = (options: DemoOptions | undefined, product: ClinicalProduct) =>
  options?.products.find((item) => item.product === product)?.kinds ?? []
/** El tipo que se propone para un producto: el segundo de la lista, o el único. */
const proposedKind = (kinds: DemoKindOption[]) => kinds[1] ?? kinds[0]

const DEMO_NAME_WORDS = "El nombre va de 3 a 80 letras"

/** La receta de una demo, con los mismos límites que la ruta (`admin-demos.ts`). */
const createDemoSchema = z.object({
  product: z.enum(CLINICAL_PRODUCTS),
  kind: z.string().trim().min(1, "Elige el tipo de demo"),
  size: z.string().min(1, "Elige el tamaño"),
  months: z.string().min(1, "Elige cuántos meses de historia"),
  countryCode: z.string().min(1, "Elige el país"),
  name: z.string().trim().min(3, DEMO_NAME_WORDS).max(80, DEMO_NAME_WORDS),
  presenterUserId: z.string().min(1, "Elige quién la presenta"),
})

interface CreateDemoValues {
  product: ClinicalProduct
  kind: string
  size: string
  months: string
  countryCode: string
  name: string
  presenterUserId: string
}

const EMPTY_DEMO: CreateDemoValues = {
  product: "medical",
  kind: "",
  size: "mediano",
  months: "12",
  countryCode: "PE",
  name: "",
  presenterUserId: "",
}

/** «Crear demo» (tablero 3): la receta de la demo; la arma el worker. */
export function CreateDemoDrawer({
  open,
  onClose,
  onCreated,
  currentUserId,
}: {
  open: boolean
  onClose: () => void
  onCreated: (id: string) => void
  currentUserId: string | null
}) {
  const queryClient = useQueryClient()
  const options = useQuery({
    queryKey: ["admin-demo-options"],
    enabled: open,
    queryFn: async () => optionsSchema.parse(await api<unknown>("/api/admin/demos/options")),
  })
  const create = useMutation({
    mutationFn: async (body: Omit<CreateDemoValues, "months"> & { months: number }) =>
      api<{ id: string }>("/api/admin/demos", { method: "POST", body: JSON.stringify(body) }),
  })
  const form = useAppForm({
    defaultValues: EMPTY_DEMO,
    validators: { onSubmit: createDemoSchema },
    onSubmit: async ({ value, formApi }) => {
      const created = await create.mutateAsync({
        ...value,
        name: value.name.trim(),
        months: Number(value.months),
      })
      void queryClient.invalidateQueries({ queryKey: ["admin-demos"] })
      toast.success("La demo se está armando")
      formApi.reset(value)
      onCreated(created.id)
    },
  })
  // La receta propuesta se arma una vez, cuando llegan las opciones: el tipo, un nombre y quien presenta.
  const proposed = useRef(false)
  useEffect(() => {
    const data = options.data
    if (!data || proposed.current) return
    proposed.current = true
    const kind = proposedKind(kindsOf(data, EMPTY_DEMO.product))
    form.reset({
      ...EMPTY_DEMO,
      kind: kind?.key ?? "",
      name: pickName(kind?.names[EMPTY_DEMO.countryCode]),
      presenterUserId:
        data.presenters.find((item) => item.id === currentUserId)?.id ?? data.presenters[0]?.id ?? "",
    })
  }, [options.data, currentUserId, form])
  const product = useStore(form.store, (state) => state.values.product)
  const kinds = useMemo(() => kindsOf(options.data, product), [options.data, product])
  const kindWord = product === "dental" ? "Tipo de clínica" : "Tipo de consultorio"
  const kindOptionOf = (key: string) => kinds.find((item) => item.key === key)
  // El tipo y el nombre siguen al producto y al país: el nombre sale del tipo, y se puede cambiar.
  const followProduct = (next: ClinicalProduct) => {
    const nextKinds = kindsOf(options.data, next)
    const kind =
      nextKinds.find((item) => item.key === form.getFieldValue("kind")) ?? proposedKind(nextKinds)
    // El nombre se elige aquí con el tipo nuevo: el aviso del tipo leería los del producto anterior.
    form.setFieldValue("kind", kind?.key ?? "", { dontRunListeners: true })
    form.setFieldValue("name", pickName(kind?.names[form.getFieldValue("countryCode")]))
  }

  return (
    <FormDrawer
      {...useFormSurface(form)}
      open={open}
      onClose={onClose}
      title="Crear demo"
      description="Una clínica inventada, con historia, para presentar el producto. Se arma sola en menos de un par de minutos y puedes cerrar esto."
      // Sin las opciones no hay receta que pedir: se espera a que lleguen.
      submitDisabled={!options.data}
      submitLabel="Crear demo"
      cancelLabel={common.actions.cancel}
    >
      {options.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : options.isError ? (
        <ErrorState error={options.error} onRetry={() => void options.refetch()} />
      ) : (
        <div className="flex flex-col gap-5">
          <form.AppField
            name="product"
            listeners={{ onChange: ({ value }) => followProduct(value) }}
          >
            {(field) => (
              <field.Group legend="Producto">
                {(control) => (
                  <RadioGroup
                    aria-label="Producto"
                    name={control.name}
                    aria-invalid={control.invalid || undefined}
                    aria-describedby={control.describedBy}
                    value={field.state.value}
                    onValueChange={(value) => {
                      if (value === "dental" || value === "medical") field.handleChange(value)
                      field.handleBlur()
                    }}
                    className="grid grid-cols-2 gap-2"
                  >
                    {CLINICAL_PRODUCTS.map((option) => (
                      <Label
                        key={option}
                        className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 font-normal has-data-checked:border-foreground"
                      >
                        <RadioGroupItem value={option} />
                        <ProductMark product={option} className="text-sm" />
                      </Label>
                    ))}
                  </RadioGroup>
                )}
              </field.Group>
            )}
          </form.AppField>

          <form.AppField
            name="kind"
            listeners={{
              onChange: ({ value }) =>
                form.setFieldValue(
                  "name",
                  pickName(kindOptionOf(value)?.names[form.getFieldValue("countryCode")]),
                ),
            }}
          >
            {(field) => (
              <field.Group legend={kindWord}>
                {(control) => (
                  <RadioGroup
                    aria-label={kindWord}
                    name={control.name}
                    aria-invalid={control.invalid || undefined}
                    aria-describedby={control.describedBy}
                    value={field.state.value}
                    onValueChange={(value) => {
                      field.handleChange(value == null ? "" : String(value))
                      field.handleBlur()
                    }}
                    className="grid gap-2 sm:grid-cols-2"
                  >
                    {kinds.map((option) => (
                      <Label
                        key={option.key}
                        className="flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2.5 font-normal has-data-checked:border-foreground"
                      >
                        <RadioGroupItem
                          value={option.key}
                          className="mt-0.5"
                          aria-invalid={control.invalid || undefined}
                        />
                        <span className="flex flex-col">
                          <span className="text-sm font-medium">{option.name}</span>
                          <span className="text-xs text-muted-foreground">{option.hint}</span>
                        </span>
                      </Label>
                    ))}
                  </RadioGroup>
                )}
              </field.Group>
            )}
          </form.AppField>

          <form.AppField name="size">
            {(field) => (
              <field.Group legend="Tamaño">
                {(control) => (
                  <RadioGroup
                    aria-label="Tamaño"
                    name={control.name}
                    aria-invalid={control.invalid || undefined}
                    aria-describedby={control.describedBy}
                    value={field.state.value}
                    onValueChange={(value) => {
                      field.handleChange(value == null ? "" : String(value))
                      field.handleBlur()
                    }}
                    className="grid gap-2"
                  >
                    {(options.data?.sizes ?? []).map((option) => (
                      <Label
                        key={option.key}
                        className="flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2.5 font-normal has-data-checked:border-foreground"
                      >
                        <RadioGroupItem
                          value={option.key}
                          className="mt-0.5"
                          aria-invalid={control.invalid || undefined}
                        />
                        <span className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-sm font-medium">{option.name}</span>
                          <span className="text-xs text-muted-foreground">
                            {option.professionals}{" "}
                            {option.professionals === 1 ? "profesional" : "profesionales"}
                            {option.branches > 1 ? ` · ${option.branches} sedes` : ""} · unos{" "}
                            {option.patients.toLocaleString("es")} pacientes
                          </span>
                        </span>
                      </Label>
                    ))}
                  </RadioGroup>
                )}
              </field.Group>
            )}
          </form.AppField>

          <div className="grid grid-cols-2 gap-3">
            <form.AppField name="months">
              {(field) => (
                <field.SelectField
                  id="demo-months"
                  label="Historia"
                  options={(options.data?.months ?? []).map((value) => ({
                    value: String(value),
                    label: `${value} meses`,
                  }))}
                />
              )}
            </form.AppField>
            <form.AppField
              name="countryCode"
              listeners={{
                onChange: ({ value }) =>
                  form.setFieldValue(
                    "name",
                    pickName(kindOptionOf(form.getFieldValue("kind"))?.names[value]),
                  ),
              }}
            >
              {(field) => (
                <field.SelectField
                  id="demo-country"
                  label="País"
                  options={(options.data?.countries ?? []).map((item) => ({
                    value: item.code,
                    label: item.name,
                  }))}
                />
              )}
            </form.AppField>
          </div>

          <form.AppField name="name">
            {(field) => (
              <field.Control
                id="demo-name"
                label="Nombre"
                description="Sale del tipo. Puedes poner el de la clínica que visitas: «Pediatría del Dr. Ruiz». Su dirección sale del nombre, sin «demo»."
              >
                {(control) => (
                  <div className="flex gap-2">
                    <Input
                      {...control.props}
                      value={field.state.value}
                      maxLength={80}
                      onChange={(event) => field.handleChange(event.target.value)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        field.handleChange(
                          pickName(
                            kindOptionOf(form.getFieldValue("kind"))?.names[
                              form.getFieldValue("countryCode")
                            ],
                          ),
                        )
                      }
                    >
                      Otro
                    </Button>
                  </div>
                )}
              </field.Control>
            )}
          </form.AppField>

          <form.AppField name="presenterUserId">
            {(field) => (
              <field.SelectField
                id="demo-presenter"
                label="La presenta"
                description="Alguien del equipo de la administración. Entra como propietario y la ve en «Elige tu clínica»; el resto del equipo de la demo no tiene cuenta."
                options={(options.data?.presenters ?? []).map((item) => ({
                  value: item.id,
                  label: item.id === currentUserId ? `${item.name} (tú)` : item.name,
                }))}
              />
            )}
          </form.AppField>
        </div>
      )}
    </FormDrawer>
  )
}

/** «Mientras se crea» (tablero 4): los pasos, el avance y, al terminar, «Abrir la demo». */
export function DemoProgressDrawer({
  demoId,
  onClose,
}: {
  demoId: string | null
  onClose: () => void
}) {
  const demos = useDemos(Boolean(demoId))
  const queryClient = useQueryClient()
  const openDemo = useOpenDemo()
  const demo = demos.data?.find((item) => item.id === demoId) ?? null
  const retry = useMutation({
    mutationFn: async (id: string) => api(`/api/admin/demos/${id}/reset`, { method: "POST" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["admin-demos"] }),
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  const done = demo?.progress?.done ?? 0
  const total = demo?.progress?.total ?? STEPS.length
  const percent = Math.round((done / Math.max(1, total)) * 100)
  const ready = demo?.status === "lista" && demo.organizationId
  return (
    <DetailDrawer
      open={Boolean(demoId)}
      onClose={onClose}
      title={
        demo
          ? ready
            ? `${demo.name} está lista`
            : demo.status === "fallida"
              ? `${demo.name} no se pudo crear`
              : `Creando ${demo.name}`
          : "Creando la demo"
      }
      description={
        demo
          ? `${demo.kindName} · ${demo.sizeName.toLowerCase()} · ${demo.months} meses · ${demo.countryName}`
          : undefined
      }
      closeLabel="Cerrar"
      actions={
        demo?.status === "fallida" ? (
          <Button type="button" disabled={retry.isPending} onClick={() => retry.mutate(demo.id)}>
            Intentar de nuevo
          </Button>
        ) : (
          <Button type="button" disabled={!ready} onClick={() => demo && openDemo.mutate(demo)}>
            Abrir la demo
          </Button>
        )
      }
    >
      {!demo ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <div className="flex flex-col gap-5">
          {demo.status === "fallida" ? (
            <p className="rounded-xl bg-destructive/10 p-3 text-sm">
              No quedó nada a medias: «Intentar de nuevo» la arma otra vez con lo mismo.
              {demo.error ? ` Motivo: ${demo.error}` : ""}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="flex justify-between text-sm">
                <b>{ready ? "Lista" : `Paso ${Math.min(done + 1, total)} de ${total}`}</b>
                <span className="text-muted-foreground">
                  {ready ? "" : "menos de un par de minutos"}
                </span>
              </p>
              <div
                role="progressbar"
                aria-label="Avance"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="h-2 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full bg-foreground transition-[width]"
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>
          )}
          <ol className="flex flex-col gap-1">
            {STEPS.map((step, index) => {
              const state =
                ready || index < done
                  ? "hecho"
                  : index === done && demo.status === "creando"
                    ? "ahora"
                    : "despues"
              return (
                <li key={step.key} className="flex items-start gap-3 py-2">
                  <span
                    aria-hidden
                    className={`flex size-6 shrink-0 items-center justify-center rounded-full ${state === "hecho" ? "bg-foreground text-background" : state === "ahora" ? "border-2 border-foreground" : "border"}`}
                  >
                    {state === "hecho" ? <Check className="size-3.5" /> : null}
                  </span>
                  <span className={state === "despues" ? "text-muted-foreground" : ""}>
                    <span className="block text-sm font-medium text-foreground">{step.title}</span>
                    <span className="block text-sm text-muted-foreground">{step.detail(demo)}</span>
                    <span className="sr-only">
                      {state === "hecho" ? "Hecho" : state === "ahora" ? "En curso" : "Pendiente"}
                    </span>
                  </span>
                </li>
              )
            })}
          </ol>
          <p className="rounded-xl bg-muted p-3 text-sm text-muted-foreground">
            Puedes cerrar esto y seguir. La demo aparece en Clínicas con su avance y se abre cuando
            está lista.
          </p>
        </div>
      )}
    </DetailDrawer>
  )
}

/** La demo de una clínica, para su ficha. */
export function useDemoOfOrganization(organizationId: string) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ["admin-demo-of", organizationId],
    queryFn: async () =>
      demoDetailSchema.parse(await api<unknown>(`/api/admin/demos/organization/${organizationId}`))
        .demo,
    // Mientras se vuelve a armar, la franja dice cómo va y se pone al día sola.
    refetchInterval: (state) =>
      state.state.data?.status === "pendiente" || state.state.data?.status === "creando" ? 3_000 : false,
  })
  const status = query.data?.status
  useEffect(() => {
    // Ya armada de nuevo: lo demás de la ficha (miembros, pacientes, gastos) es otro.
    if (status === "lista") void queryClient.invalidateQueries({ queryKey: ["admin-organization", organizationId] })
  }, [status, organizationId, queryClient])
  return query
}

/**
 * La franja de la demo arriba de las pestañas (tablero 2): con qué se armó,
 * quién la presenta, que está al día, y «Volver a empezar» y «Borrar demo»
 * con su confirmación (tablero 4b).
 */
export function DemoBand({
  demo,
  isAdmin,
  onDeleted,
}: {
  demo: DemoDetail
  isAdmin: boolean
  onDeleted: () => void
}) {
  const queryClient = useQueryClient()
  const [confirm, setConfirm] = useState<"reset" | "delete" | null>(null)
  const reset = useMutation({
    mutationFn: async () => api(`/api/admin/demos/${demo.id}/reset`, { method: "POST" }),
    onSuccess: () => {
      setConfirm(null)
      toast.success("Se vuelve a armar")
      void queryClient.invalidateQueries({ queryKey: ["admin-demos"] })
      void queryClient.invalidateQueries({ queryKey: ["admin-demo-of", demo.organizationId] })
    },
  })
  const remove = useMutation({
    mutationFn: async (confirmName: string) =>
      api(`/api/admin/demos/${demo.id}`, {
        method: "DELETE",
        body: JSON.stringify({ confirmName }),
      }),
  })
  // Borrar pide el nombre escrito tal cual: el mismo control que hace el servidor.
  const deleteForm = useAppForm({
    defaultValues: { confirmName: "" },
    validators: {
      onSubmit: z.object({
        confirmName: z
          .string()
          .refine((value) => value.trim() === demo.name, "Escribe el nombre de la demo para borrarla"),
      }),
    },
    onSubmit: async ({ value, formApi }) => {
      await remove.mutateAsync(value.confirmName)
      formApi.reset()
      setConfirm(null)
      toast.success(`«${demo.name}» se borró`)
      void queryClient.invalidateQueries({ queryKey: ["admin-demos"] })
      void queryClient.invalidateQueries({ queryKey: ["admin-organizations"] })
      onDeleted()
    },
  })
  const deleteError = useFormSubmitError(deleteForm)
  const deleting = useStore(deleteForm.store, (state) => state.isSubmitting)
  const building = demo.status === "pendiente" || demo.status === "creando"
  return (
    <section
      aria-label="Demo"
      className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4"
    >
      <div className="flex min-w-72 flex-1 flex-col gap-1">
        <p className="text-sm font-medium">
          Demo de {demo.kindName} · {demo.sizeName.toLowerCase()} · {demo.months} meses ·{" "}
          {demo.countryName}
        </p>
        <p className="text-sm text-muted-foreground">
          {building
            ? "Se está volviendo a armar: la clínica de antes sigue hasta que termine."
            : `La presenta ${demo.presenter.name}. Al día hoy: cada noche suma el día que pasó. Sin cobro; sus mensajes no salen a nadie.`}
          {demo.expiresSoon
            ? ` Nadie la abre desde el ${shortDay(demo.lastUsedAt)}: se borra el ${shortDay(demo.expiresAt)} si nadie la abre.`
            : ""}
        </p>
      </div>
      {isAdmin ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={building}
            onClick={() => setConfirm("reset")}
          >
            Volver a empezar
          </Button>
          <Button
            type="button"
            variant="outline"
            className="text-destructive"
            disabled={building}
            onClick={() => {
              deleteForm.reset()
              setConfirm("delete")
            }}
          >
            Borrar demo
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirm === "reset"}
        title={`¿Volver a empezar «${demo.name}»?`}
        description={`Se borra lo que se hizo en las presentaciones (citas reservadas, cobros, mensajes a Sofi) y se arma otra vez: ${demo.kindName}, ${demo.sizeName.toLowerCase()}, ${demo.months} meses, hasta hoy. La dirección y quien la presenta siguen iguales.`}
        confirmLabel="Volver a empezar"
        variant="default"
        pending={reset.isPending}
        error={reset.isError ? submitErrorMessage(reset.error) : null}
        onConfirm={() => reset.mutate()}
        onClose={() => {
          reset.reset()
          setConfirm(null)
        }}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        title={`¿Borrar «${demo.name}»?`}
        description="Se borran sus pacientes inventados, su historia y su dirección. No se puede deshacer."
        confirmLabel="Borrar demo"
        pending={deleting}
        error={deleteError}
        onConfirm={() => void submitForm(deleteForm)}
        onClose={() => {
          deleteForm.reset()
          setConfirm(null)
        }}
      >
        <deleteForm.AppField name="confirmName">
          {(field) => (
            <field.TextField
              id="demo-confirm-name"
              label="Escribe el nombre para confirmar"
              description={`Escribe «${demo.name}» tal cual`}
              autoComplete="off"
            />
          )}
        </deleteForm.AppField>
      </ConfirmDialog>
    </section>
  )
}

/** «Lo que tiene hoy para mostrar» (tablero 2), en el Resumen de la ficha de una demo. */
export function DemoShowcase({ demo }: { demo: DemoDetail }) {
  const showcase = demo.showcase
  if (!showcase) return null
  const day = new Intl.DateTimeFormat("es", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${showcase.today}T12:00:00Z`))
  return (
    <section
      aria-labelledby="demo-hoy"
      className="flex flex-col gap-3.5 rounded-xl border bg-card p-4"
    >
      <div>
        <h2 id="demo-hoy" className="text-base font-medium">
          Lo que tiene hoy para mostrar
        </h2>
        <p className="text-xs text-muted-foreground">
          {day.charAt(0).toUpperCase() + day.slice(1)} · se pone al día cada noche
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="flex flex-col gap-0.5 rounded-xl border p-3">
          <p className="text-xs text-muted-foreground">Agenda de hoy</p>
          <p className="text-xl font-semibold tabular-nums">{showcase.agendaToday} citas</p>
          <p className="text-xs text-muted-foreground">
            {showcase.unconfirmed} por confirmar entre hoy y mañana
          </p>
        </div>
        <div className="flex flex-col gap-0.5 rounded-xl border p-3">
          <p className="text-xs text-muted-foreground">Bandeja</p>
          <p className="text-xl font-semibold tabular-nums">{showcase.openTopics} por atender</p>
          <p className="text-xs text-muted-foreground">{showcase.byAgent} las atiende Sofi</p>
        </div>
        <div className="flex flex-col gap-0.5 rounded-xl border p-3">
          <p className="text-xs text-muted-foreground">{showcase.controlsLabel}</p>
          <p className="text-xl font-semibold tabular-nums">{showcase.controlsDue} vencen</p>
          <p className="text-xs text-muted-foreground">este mes</p>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        La historia inventada no gasta IA: «Nos costó» suma lo que Sofi y Clío hicieron de verdad en
        las presentaciones, más el espacio y el servidor.
      </p>
    </section>
  )
}

/** «Abrir la demo»: cuenta como uso (así no se borra sola) y abre la clínica en su dominio. */
export function useOpenDemo() {
  return useMutation({
    mutationFn: async (demo: { id: string; slug: string; product: ClinicalProduct }) => {
      // La pestaña se abre en el clic, antes de esperar al servidor: así el navegador no la bloquea.
      const tab = window.open(platformUrl(demo.slug, "/home", demo.product), "_blank", "noopener")
      await api(`/api/admin/demos/${demo.id}/open`, { method: "POST" }).catch(() => undefined)
      return tab
    },
  })
}
