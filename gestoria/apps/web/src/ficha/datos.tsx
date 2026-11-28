import {
  Button,
  cn,
  FieldGroup,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  toast,
} from "@odentia/ui"
import {
  FormDrawer,
  RadioChips,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { MessageCircleQuestion, Plus, Settings2, Trash2 } from "lucide-react"
import { useEffect, useId, useState } from "react"
import { z } from "zod"
import { api } from "../lib/api"
import {
  type ProductRubro,
  type RubroTemplate,
  type RubroValue,
  readNumber,
  type Sheet,
  type SheetQuestion,
  type TemplateField,
  type TemplateFieldType,
} from "../lib/ficha"
import { when } from "../lib/pedidos"
import { useFichaContext } from "./contexto"
import { DataProposal, RubroProposal } from "./ia"
import { FieldProblem, Section, Sub, useTyped } from "./piezas"

/**
 * Los datos del rubro (tablero 10; prototipo `ficha/datos-card.tsx`): lo que sus clientas
 * preguntan, según la plantilla de la tienda, cada uno con «No aplica». Lo que falta nunca frena la
 * venta: dice «Sofi lo necesita». Abajo, las preguntas respondidas y lo que Sofi no supo (tablero
 * 12): Ventas responde y propone; el Dueño o el Administrador lo guardan en la ficha.
 */

export const TEMPLATES_KEY = (storeId: string) => ["plantillas", storeId]
export const PRODUCT_KEY = (storeId: string, productId: string) => ["producto", storeId, productId]

/** Las plantillas de los rubros de la tienda (`GET /plantillas`), para la ficha y el catálogo. */
export function useTemplates(storeId: string) {
  return useQuery({
    queryKey: TEMPLATES_KEY(storeId),
    queryFn: () => api<{ rubros: RubroTemplate[] }>(`/api/tiendas/${storeId}/plantillas`),
    staleTime: 60_000,
  })
}

const isEmpty = (v: RubroValue | null | undefined) =>
  v === undefined ||
  v === null ||
  v === "" ||
  (typeof v === "object" && !("noAplica" in v) && Object.keys(v).length === 0)
const isNotApplicable = (v: RubroValue | null | undefined) =>
  !!v && typeof v === "object" && "noAplica" in v

/** Un número escrito con su unidad (h, kg, cm): se guarda al leerse. */
function NumberText({
  value,
  unit,
  onChange,
  id,
  label,
  disabled,
  className,
}: {
  value: number | null
  unit?: string
  onChange: (v: number | null) => void
  id?: string
  label?: string
  disabled?: boolean
  className?: string
}) {
  const [text, setText] = useTyped(
    value,
    (v) => (v === null ? "" : String(v).replace(".", ",")),
    readNumber,
  )
  return (
    <InputGroup className={cn("w-32", className)}>
      <InputGroupInput
        id={id}
        aria-label={label}
        inputMode="decimal"
        disabled={disabled}
        value={text}
        className="tabular-nums"
        onChange={(e) => {
          const next = e.target.value.replace(/[^0-9.,]/g, "")
          setText(next)
          if (!next.trim()) onChange(null)
          else {
            const n = readNumber(next)
            if (n !== null) onChange(n)
          }
        }}
      />
      {unit ? <InputGroupAddon align="inline-end">{unit}</InputGroupAddon> : null}
    </InputGroup>
  )
}

/** «MM/AAAA» como se escribe, y se guarda como «AAAA-MM» (ISO 8601). */
function MonthText({
  value,
  onChange,
  id,
  disabled,
}: {
  value: string | null
  onChange: (v: string | null) => void
  id: string
  disabled?: boolean
}) {
  const shown = (v: string | null) => {
    if (!v) return ""
    const [y, m] = v.split("-")
    return `${m}/${y}`
  }
  const [text, setText] = useTyped(value, shown, (t) => {
    const m = /^(\d{1,2})\s*[/.-]\s*(\d{4})$/.exec(t.trim())
    return m ? `${m[2]}-${m[1]?.padStart(2, "0")}` : null
  })
  const [bad, setBad] = useState(false)
  return (
    <div className="flex flex-col gap-1">
      <Input
        id={id}
        className="w-36"
        placeholder="MM/AAAA"
        inputMode="numeric"
        disabled={disabled}
        value={text}
        aria-invalid={bad || undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const t = text.trim()
          if (!t) {
            setBad(false)
            return onChange(null)
          }
          const m = /^(\d{1,2})\s*[/.-]\s*(\d{4})$/.exec(t)
          const month = Number(m?.[1])
          setBad(!m || month < 1 || month > 12)
          if (m && month >= 1 && month <= 12) onChange(`${m[2]}-${String(month).padStart(2, "0")}`)
        }}
      />
      {bad ? <FieldProblem message="Escríbelo como 06/2028" /> : null}
    </div>
  )
}

function Field({ field }: { field: TemplateField }) {
  const { draft, edit, change, errors } = useFichaContext()
  const id = useId()
  const value = draft.rubroData[field.key]
  const empty = isEmpty(value)
  const notApplicable = isNotApplicable(value)
  const sizes =
    draft.grid?.columnName !== null && draft.grid ? draft.grid.columns.map((c) => c.value) : []
  const set = (next: RubroValue | null, group?: string) =>
    change(
      `${field.label}: ${typeof next === "string" ? next || "vacío" : next === null ? "vacío" : "cambió"}`,
      (d) => {
        if (next === null) delete d.rubroData[field.key]
        else d.rubroData[field.key] = next
      },
      { group },
    )
  const error = errors[`rubroData.${field.key}`]

  let control: React.ReactNode = null
  if (notApplicable)
    control = <p className="text-sm text-muted-foreground">No aplica a este producto.</p>
  else if (field.type === "opcion")
    control = (
      <RadioChips
        aria-labelledby={`${id}-l`}
        value={typeof value === "string" ? value : null}
        options={(field.options ?? []).map((o) => ({ value: o, label: o }))}
        disabled={!edit}
        onChange={(o) => set(o)}
      />
    )
  else if (field.type === "texto")
    control = (
      <Textarea
        id={id}
        rows={2}
        maxLength={500}
        value={typeof value === "string" ? value : ""}
        disabled={!edit}
        onChange={(e) => set(e.target.value || null, `dato-${field.key}`)}
      />
    )
  else if (field.type === "numero")
    control = (
      <NumberText
        id={id}
        unit={field.unit}
        value={typeof value === "number" ? value : null}
        disabled={!edit}
        onChange={(n) => set(n, `dato-${field.key}`)}
      />
    )
  else if (field.type === "fecha")
    control = (
      <MonthText
        id={id}
        value={typeof value === "string" ? value : null}
        disabled={!edit}
        onChange={(v) => set(v)}
      />
    )
  else if (field.type === "por_talla") {
    const map = (value && typeof value === "object" && !notApplicable ? value : {}) as Record<
      string,
      number
    >
    control = sizes.length ? (
      <fieldset
        className="m-0 grid min-w-0 grid-cols-[repeat(auto-fill,minmax(5rem,1fr))] gap-2 border-0 p-0"
        aria-labelledby={`${id}-l`}
      >
        {sizes.map((size) => (
          <div key={size} className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span aria-hidden>{size}</span>
            <NumberText
              className="w-full"
              label={`${field.label} de la ${size}`}
              unit={field.unit}
              value={map[size] ?? null}
              disabled={!edit}
              onChange={(n) => {
                const next = { ...map }
                if (n === null) delete next[size]
                else next[size] = n
                set(Object.keys(next).length ? next : null, `dato-${field.key}`)
              }}
            />
          </div>
        ))}
      </fieldset>
    ) : (
      <p className="text-sm text-muted-foreground">Primero pon sus tallas en «Variantes».</p>
    )
  } else if (field.type === "tabla") {
    const map = (value && typeof value === "object" && !notApplicable ? value : {}) as Record<
      string,
      (number | null)[]
    >
    const columns = field.columns ?? []
    control = sizes.length ? (
      <fieldset
        className="m-0 min-w-0 overflow-x-auto rounded-xl border p-0"
        aria-labelledby={`${id}-l`}
      >
        <table className="w-full text-sm">
          <thead className="bg-surface-muted text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">Talla</th>
              {columns.map((c) => (
                <th key={c} className="px-3 py-2 text-left font-semibold">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sizes.map((size) => (
              <tr key={size} className="border-t">
                <th className="px-3 py-1.5 text-left font-medium">{size}</th>
                {columns.map((c, ci) => (
                  <td key={c} className="px-2 py-1.5">
                    <NumberText
                      className="w-24"
                      unit={field.unit}
                      label={`${c} de la ${size}`}
                      value={map[size]?.[ci] ?? null}
                      disabled={!edit}
                      onChange={(n) => {
                        const row = columns.map((_, j) => (j === ci ? n : (map[size]?.[j] ?? null)))
                        const next = { ...map, [size]: row }
                        if (row.every((x) => x === null)) delete next[size]
                        set(Object.keys(next).length ? next : null, `dato-${field.key}`)
                      }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </fieldset>
    ) : (
      <p className="text-sm text-muted-foreground">Primero pon sus tallas en «Variantes».</p>
    )
  }

  return (
    <div id={`dato-${field.key}`} className="flex scroll-mt-24 flex-col gap-2 rounded-xl">
      <div className="flex min-h-5 flex-wrap items-center gap-2">
        <label htmlFor={id} id={`${id}-l`} className="text-sm font-medium">
          {field.label}
        </label>
        {empty && field.needed ? (
          <span className="text-xs font-medium text-warning">Sofi lo necesita</span>
        ) : null}
        {edit ? (
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto text-muted-foreground"
            aria-pressed={notApplicable}
            onClick={() => set(notApplicable ? null : { noAplica: true })}
          >
            {notApplicable ? "Sí aplica" : "No aplica"}
          </Button>
        ) : null}
      </div>
      {control}
      {empty ? <DataProposal field={field} /> : null}
      <FieldProblem message={error} />
    </div>
  )
}

const TYPE_NAMES: Record<TemplateFieldType, string> = {
  opcion: "Una opción",
  texto: "Un texto",
  numero: "Un número",
  por_talla: "Uno por talla",
  tabla: "Una tabla por talla",
  fecha: "Una fecha",
}

/**
 * Ajustar la plantilla del rubro desde la ficha (tablero 10): qué pide cada producto de la tienda
 * y qué necesita Sofi. Vale para todos sus productos de ese rubro.
 */
function TemplateDrawer({ template, onClose }: { template: RubroTemplate; onClose: () => void }) {
  const { store, sheet } = useFichaContext()
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: (fields: unknown[]) =>
      api(`/api/tiendas/${store.id}/plantillas/${template.id}`, {
        method: "PATCH",
        body: { fields },
      }),
  })
  const form = useAppForm({
    defaultValues: {
      fields: template.fields.map((f) => ({
        key: f.key,
        label: f.label,
        choice: f.needed ? "need" : "suma",
      })),
      newLabel: "",
      newType: "texto" as TemplateFieldType,
      newOptions: "",
    },
    validators: {
      onSubmit: z
        .object({
          fields: z.array(z.object({ key: z.string(), label: z.string(), choice: z.string() })),
          newLabel: z.string(),
          newType: z.enum(["opcion", "numero", "texto", "por_talla", "tabla", "fecha"]),
          newOptions: z.string(),
        })
        .refine((v) => !(v.newLabel.trim() && v.newType === "opcion" && !v.newOptions.trim()), {
          message: "Escribe las opciones, separadas por comas",
          path: ["newOptions"],
        }),
    },
    onSubmit: async ({ value }) => {
      const kept = value.fields
        .filter((f) => f.choice !== "quitar")
        .map((f) => ({ key: f.key, needed: f.choice === "need" }))
      const extra = value.newLabel.trim()
        ? [
            {
              label: value.newLabel.trim(),
              type: value.newType,
              needed: false,
              ...(value.newType === "opcion"
                ? {
                    options: value.newOptions
                      .split(",")
                      .map((o) => o.trim())
                      .filter(Boolean),
                  }
                : {}),
              ...(value.newType === "tabla" ? { columns: ["Medida"] } : {}),
            },
          ]
        : []
      await save.mutateAsync([...kept, ...extra])
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: TEMPLATES_KEY(store.id) }),
        queryClient.invalidateQueries({ queryKey: PRODUCT_KEY(store.id, sheet.id) }),
      ])
      toast.success(`Plantilla de ${template.label.toLowerCase()} guardada`)
      onClose()
    },
  })
  const surface = useFormSurface(form, {
    fieldMap: (key) => (key.startsWith("fields.") ? "newLabel" : undefined),
  })
  return (
    <FormDrawer
      {...surface}
      open
      title={`Plantilla de ${template.label.toLowerCase()}`}
      description={`Lo que pide cada producto de ${template.label.toLowerCase()} de ${store.name}. Sofi lo usa al responder.`}
      onClose={onClose}
      submitLabel="Guardar la plantilla"
    >
      <FieldGroup className="gap-1">
        <form.AppField name="fields" mode="array">
          {(list) => (
            <div className="flex flex-col divide-y">
              {list.state.value.map((f, i) => (
                <form.AppField key={f.key} name={`fields[${i}].choice`}>
                  {(field) => (
                    <div
                      className={cn(
                        "flex flex-col gap-2 py-3 first:pt-0",
                        field.state.value === "quitar" && "opacity-60",
                      )}
                    >
                      <span className="text-sm font-medium" id={`tpl-${f.key}`}>
                        {f.label}
                      </span>
                      <RadioChips
                        aria-labelledby={`tpl-${f.key}`}
                        value={field.state.value}
                        options={[
                          { value: "need", label: "Sofi lo necesita" },
                          { value: "suma", label: "Suma" },
                          { value: "quitar", label: "Quitar" },
                        ]}
                        onChange={(v) => field.handleChange(v ?? "suma")}
                      />
                    </div>
                  )}
                </form.AppField>
              ))}
            </div>
          )}
        </form.AppField>
        <div className="flex flex-col gap-4 border-t pt-4">
          <form.AppField name="newLabel">
            {(field) => (
              <field.TextField
                label="Agregar un dato"
                placeholder="Ej.: ¿Es vegano?"
                maxLength={60}
              />
            )}
          </form.AppField>
          <form.Subscribe selector={(s) => [s.values.newLabel, s.values.newType] as const}>
            {([label, type]) =>
              label.trim() ? (
                <>
                  <form.AppField name="newType">
                    {(field) => (
                      <field.Group legend="Cómo se responde">
                        {() => (
                          <Select
                            items={TYPE_NAMES}
                            value={field.state.value}
                            onValueChange={(v) =>
                              field.handleChange((v ?? "texto") as TemplateFieldType)
                            }
                          >
                            <SelectTrigger className="w-full" aria-label="Cómo se responde">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {(["texto", "opcion", "numero", "por_talla", "fecha"] as const).map(
                                (t) => (
                                  <SelectItem key={t} value={t}>
                                    {TYPE_NAMES[t]}
                                  </SelectItem>
                                ),
                              )}
                            </SelectContent>
                          </Select>
                        )}
                      </field.Group>
                    )}
                  </form.AppField>
                  {type === "opcion" ? (
                    <form.AppField name="newOptions">
                      {(field) => (
                        <field.TextField
                          label="Sus opciones"
                          placeholder="Sí, No"
                          description="Separadas por comas."
                        />
                      )}
                    </form.AppField>
                  ) : null}
                </>
              ) : null
            }
          </form.Subscribe>
        </div>
      </FieldGroup>
    </FormDrawer>
  )
}

/** Lo que Sofi no supo y las preguntas respondidas de la ficha. */
function Questions() {
  const { sheet, store, edit } = useFichaContext()
  const queryClient = useQueryClient()
  const answers = store.permissions.includes("ventas.atender")
  const [adding, setAdding] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const done = (product: Sheet, message: string) => {
    queryClient.setQueryData(PRODUCT_KEY(store.id, sheet.id), { product })
    void queryClient.invalidateQueries({ queryKey: ["historial", store.id, sheet.id] })
    toast.success(message)
  }
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown; message: string }) =>
      api<{ product: Sheet }>(`/api/tiendas/${store.id}${path}`, {
        method: "POST",
        body: body ?? {},
      }),
    onSuccess: (result, vars) => done(result.product, vars.message),
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  // Lo que espera respuesta: lo respondido (también en «Te toca», sin guardar) ya no espera.
  const open = sheet.questions.filter((q) => !q.savedAt && !q.answer)
  const proposed = sheet.questions.filter((q) => !q.savedAt && q.answer && q.saveRequested)
  const saved = sheet.questions.filter((q) => q.savedAt)

  const answerBox = (q: SheetQuestion) => {
    const text = drafts[q.id] ?? q.answer ?? ""
    return (
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!text.trim()) return
          act.mutate({
            path: `/preguntas/${q.id}/respuesta`,
            body: { answer: text.trim(), save: true },
            message: edit
              ? "Guardado en la ficha: Sofi ya lo sabe"
              : "Propuesta enviada: la guarda el Dueño",
          })
        }}
      >
        <Textarea
          aria-label={`Tu respuesta a «${q.question}»`}
          rows={2}
          maxLength={1000}
          placeholder="Tu respuesta. Sofi la usará la próxima vez."
          value={text}
          onChange={(e) => setDrafts({ ...drafts, [q.id]: e.target.value })}
        />
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={!text.trim() || act.isPending}>
            {edit ? "Guardar en la ficha" : "Proponer la respuesta"}
          </Button>
        </div>
      </form>
    )
  }

  return (
    <>
      {open.length && (answers || edit) ? (
        <>
          <Sub id="no-supo">Lo que Sofi no supo</Sub>
          <ul className="flex flex-col gap-2">
            {open.map((q) => (
              <li
                key={q.id}
                className="flex flex-col gap-2 rounded-xl border border-warning/40 p-3 text-sm"
              >
                <span className="flex items-start gap-2">
                  <MessageCircleQuestion
                    className="mt-0.5 size-4 shrink-0 text-warning"
                    aria-hidden
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium">{q.question}</span>
                    <span className="text-xs text-muted-foreground">
                      {q.askedBy ?? "Sofi"} · {when(q.askedAt)}
                      {q.test ? " · en una prueba" : ""}
                    </span>
                  </span>
                </span>
                {answers || edit ? answerBox(q) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {proposed.length ? (
        <>
          <Sub>Propuestas para guardar</Sub>
          <ul className="flex flex-col gap-2">
            {proposed.map((q) => (
              <li
                key={q.id}
                className="flex flex-col gap-2 rounded-xl bg-surface-muted px-3 py-2.5 text-sm"
              >
                <span className="font-medium">{q.question}</span>
                <span>{q.answer}</span>
                <span className="text-xs text-muted-foreground">
                  Propuso {q.answeredBy ?? "alguien del equipo"}
                  {edit ? "" : " · la guarda el Dueño o un Administrador"}
                </span>
                {edit ? (
                  <div className="flex justify-end gap-2">
                    <Button
                      size="sm"
                      disabled={act.isPending}
                      onClick={() =>
                        act.mutate({
                          path: `/preguntas/${q.id}/guardar`,
                          message: "Guardado en la ficha: Sofi ya lo sabe",
                        })
                      }
                    >
                      Guardar en la ficha
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <Sub
        id="preguntas"
        action={
          edit && !adding ? (
            <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
              <Plus aria-hidden />
              Pregunta
            </Button>
          ) : null
        }
      >
        Preguntas respondidas
      </Sub>
      {saved.length === 0 && !adding ? (
        <p className="text-sm text-muted-foreground">
          Cuando Sofi no sepa algo, aparece arriba para responderlo, y la respuesta queda aquí.
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {saved.map((q) => (
          <li
            key={q.id}
            className="group flex items-start gap-3 rounded-xl bg-surface-muted px-3 py-2.5 text-sm"
          >
            <MessageCircleQuestion
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-medium">{q.question}</span>
              <span>{q.answer}</span>
              <span className="text-xs text-muted-foreground">
                {q.savedBy ?? q.answeredBy ?? "La tienda"} · {q.savedAt ? when(q.savedAt) : ""}
              </span>
            </span>
            {edit ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Sacar de la ficha «${q.question}»`}
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
                disabled={act.isPending}
                onClick={() =>
                  act.mutate({
                    path: `/preguntas/${q.id}/quitar`,
                    message: "Sacada de la ficha: Sofi ya no la usa",
                  })
                }
              >
                <Trash2 aria-hidden />
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {adding ? <NewQuestion onClose={() => setAdding(false)} onDone={done} /> : null}
    </>
  )
}

function NewQuestion({
  onClose,
  onDone,
}: {
  onClose: () => void
  onDone: (product: Sheet, message: string) => void
}) {
  const { store, sheet } = useFichaContext()
  const add = useMutation({
    mutationFn: (body: { question: string; answer: string }) =>
      api<{ product: Sheet }>(`/api/tiendas/${store.id}/productos/${sheet.id}/preguntas`, {
        method: "POST",
        body,
      }),
  })
  const form = useAppForm({
    defaultValues: { question: "", answer: "" },
    validators: {
      onSubmit: z.object({
        question: z.string().trim().min(3, "Escribe la pregunta de la clienta"),
        answer: z.string().trim().min(1, "Escribe tu respuesta"),
      }),
    },
    onSubmit: async ({ value }) => {
      const { product } = await add.mutateAsync({
        question: value.question.trim(),
        answer: value.answer.trim(),
      })
      onDone(product, "Respuesta guardada: Sofi la usará la próxima vez")
      onClose()
    },
  })
  const surface = useFormSurface(form)
  return (
    <FormDrawer
      {...surface}
      open
      title="Una pregunta que ya te hacen"
      description="Respóndela una vez y queda en la ficha: Sofi la usa la próxima vez."
      onClose={onClose}
      submitLabel="Guardar la respuesta"
    >
      <FieldGroup className="gap-5">
        <form.AppField name="question">
          {(field) => (
            <field.TextField
              label="La pregunta"
              placeholder="¿Se puede lavar en lavadora?"
              maxLength={300}
              autoFocus
            />
          )}
        </form.AppField>
        <form.AppField name="answer">
          {(field) => <field.TextareaField label="Tu respuesta" rows={3} maxLength={1000} />}
        </form.AppField>
      </FieldGroup>
    </FormDrawer>
  )
}

/** Los datos del rubro, con su plantilla y las preguntas. */
export function DataCard({ templates }: { templates: RubroTemplate[] }) {
  const { draft, sheet, edit, change } = useFichaContext()
  const [adjusting, setAdjusting] = useState(false)
  const rubro = templates.find((t) => t.id === draft.rubro) ?? null
  // Lo que se ve es la plantilla de la tienda de ese rubro; si recién se eligió, la de la tienda.
  const fields = draft.rubro === sheet.rubro ? sheet.template : (rubro?.fields ?? [])
  const filled = fields.filter((f) => !isEmpty(draft.rubroData[f.key])).length
  const answered = sheet.questions.filter((q) => q.savedAt).length
  return (
    <Section
      id="datos"
      title={rubro ? `Datos de ${rubro.label.toLowerCase()}` : "Datos para vender"}
      summary={
        rubro
          ? `${filled} de ${fields.length} · ${answered} ${answered === 1 ? "pregunta respondida" : "preguntas respondidas"}`
          : "Elige el rubro"
      }
      contains={["dato-", "preguntas", "no-supo"]}
      action={
        edit && rubro ? (
          <Button size="sm" variant="ghost" onClick={() => setAdjusting(true)}>
            <Settings2 aria-hidden />
            Plantilla
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium" id="rubro-l">
          Rubro
        </span>
        <RadioChips
          aria-labelledby="rubro-l"
          value={draft.rubro}
          disabled={!edit}
          options={templates.map((t) => ({ value: t.id, label: t.label }))}
          onChange={(v) =>
            v &&
            v !== draft.rubro &&
            change(`Rubro: ${templates.find((t) => t.id === v)?.label ?? v}`, (d) => {
              // Lo del rubro de antes queda guardado sin mostrarse: si vuelve, vuelve con sus datos.
              d.rubro = v as ProductRubro
            })
          }
        />
        <RubroProposal labelOf={(id) => templates.find((t) => t.id === id)?.label ?? id} />
        {!draft.rubro ? (
          <p className="text-sm text-muted-foreground">
            Con el rubro, la ficha pide lo que sus clientas preguntan (cómo calza, la tela, el
            contenido…), y Sofi lo usa al responder.
          </p>
        ) : null}
      </div>
      {rubro ? (
        <div className="flex flex-col gap-5">
          {fields.map((f) => (
            <Field key={f.key} field={f} />
          ))}
        </div>
      ) : null}
      <Questions />
      {adjusting && rubro ? (
        <TemplateDrawer template={rubro} onClose={() => setAdjusting(false)} />
      ) : null}
    </Section>
  )
}
