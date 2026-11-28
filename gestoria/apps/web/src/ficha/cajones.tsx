import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  FieldGroup,
  Kbd,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "@odentia/ui"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@odentia/ui/components/command"
import {
  clearSubmitErrors,
  DetailDrawer,
  ErrorState,
  FormDrawer,
  RadioChips,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Search } from "lucide-react"
import { useState } from "react"
import { z } from "zod"
import { MoneyInput } from "../campos"
import { CATALOG_KEY } from "../catalogo"
import { api } from "../lib/api"
import type { RubroTemplate } from "../lib/ficha"
import { when } from "../lib/pedidos"
import { MOVEMENT_NAMES, type Movement, money, readMoney, variantName } from "../lib/tienda"
import { useFichaContext } from "./contexto"
import { PRODUCT_KEY } from "./datos"
import { eventLine, useHistory } from "./lateral"
import { goTo, Swatch } from "./piezas"

/**
 * Lo que la ficha abre aparte (prototipo `ficha/cajones.tsx`): el kardex de cada variante, con su
 * entrada o su ajuste; quién cambió qué; buscar en la ficha («/») y los atajos («?»).
 */

type MovementKind = "entrada" | "ajuste"

/** El kardex: cada movimiento de una variante y, para quien cambia la ficha, una entrada o un ajuste. */
export function KardexDrawer({ onClose }: { onClose: () => void }) {
  const { sheet, store, edit } = useFichaContext()
  const queryClient = useQueryClient()
  const [variantId, setVariantId] = useState(
    () => sheet.variants.find((v) => v.stock > 0)?.id ?? sheet.variants[0]?.id ?? "",
  )
  const variant = sheet.variants.find((v) => v.id === variantId)
  const key = ["kardex", store.id, variantId]
  const kardex = useQuery({
    queryKey: key,
    queryFn: () =>
      api<{ stock: number; movements: Movement[] }>(
        `/api/tiendas/${store.id}/variantes/${variantId}/kardex`,
      ),
    enabled: !!variantId,
  })
  const move = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/api/tiendas/${store.id}/variantes/${variantId}/movimientos`, { method: "POST", body }),
  })
  const [kind, setKind] = useState<MovementKind>("entrada")
  const form = useAppForm({
    defaultValues: { kind: "entrada" as MovementKind, quantity: "", cost: "", reason: "" },
    validators: {
      onSubmit: z
        .object({
          kind: z.enum(["entrada", "ajuste"]),
          quantity: z.string(),
          cost: z.string(),
          reason: z.string(),
        })
        .superRefine((value, ctx) => {
          const n = Number(value.quantity)
          const issue = (path: string, message: string) =>
            ctx.addIssue({ code: "custom", path: [path], message })
          if (value.kind === "entrada") {
            if (!Number.isInteger(n) || n < 1) issue("quantity", "Escribe cuántas entran")
            if (value.cost.trim() && readMoney(value.cost, store.currency) === null)
              issue("cost", "Escribe el costo, como 68 o 68.50, o déjalo vacío")
          } else {
            if (value.quantity.trim() === "" || !Number.isInteger(n) || n < 0)
              issue("quantity", "Escribe cuántas hay de verdad, 0 o más")
            if (value.reason.trim().length < 3)
              issue("reason", "Escribe el motivo del ajuste, como «par dañado»")
          }
        }),
    },
    onSubmit: async ({ value, formApi }) => {
      const n = Number(value.quantity)
      await move.mutateAsync(
        value.kind === "entrada"
          ? {
              kind: value.kind,
              quantity: n,
              unitCostCents: value.cost.trim() ? readMoney(value.cost, store.currency) : null,
              reason: value.reason.trim() || undefined,
            }
          : { kind: value.kind, counted: n, reason: value.reason },
      )
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: key }),
        queryClient.invalidateQueries({ queryKey: PRODUCT_KEY(store.id, sheet.id) }),
        queryClient.invalidateQueries({ queryKey: CATALOG_KEY(store.id), refetchType: "none" }),
      ])
      toast.success(value.kind === "entrada" ? "Entrada anotada" : "Ajuste anotado")
      formApi.reset({ kind: value.kind, quantity: "", cost: "", reason: "" })
    },
  })
  const surface = useFormSurface(form, { fieldMap: { unitCostCents: "cost", counted: "quantity" } })
  const stock = kardex.data?.stock ?? variant?.stock ?? 0
  const names = Object.fromEntries(
    sheet.variants.map((v) => [v.id, `${variantName(v)} · ${v.stock}`]),
  )
  return (
    <form.Subscribe
      selector={(state) =>
        Boolean(
          state.values.quantity.trim() || state.values.cost.trim() || state.values.reason.trim(),
        )
      }
    >
      {(typed) => (
        <FormDrawer
          {...surface}
          isDirty={typed}
          open
          title="Kardex"
          description={`${sheet.name} · ${variant ? variantName(variant) : ""} · quedan ${stock}`}
          onClose={onClose}
          cancelLabel="Cerrar"
          hideSubmit={!edit}
          submitLabel={kind === "entrada" ? "Anotar la entrada" : "Anotar el ajuste"}
        >
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium" id="kardex-variante">
                Variante
              </span>
              <Select
                items={names}
                value={variantId}
                onValueChange={(v) => {
                  setVariantId(String(v ?? ""))
                  clearSubmitErrors(form)
                }}
              >
                <SelectTrigger className="w-full" aria-labelledby="kardex-variante">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sheet.variants.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {names[v.id]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {edit ? (
              <FieldGroup className="gap-4">
                <form.AppField
                  name="kind"
                  listeners={{
                    onChange: ({ value }) => {
                      setKind(value)
                      clearSubmitErrors(form)
                    },
                  }}
                >
                  {(field) => (
                    <field.Group
                      legend="Entrada o ajuste"
                      description="Entrada: llegó mercadería. Ajuste: contaste y no cuadra."
                    >
                      {(control) => (
                        <RadioChips
                          aria-label="Entrada o ajuste"
                          value={field.state.value}
                          options={[
                            { value: "entrada", label: "Entrada" },
                            { value: "ajuste", label: "Ajuste" },
                          ]}
                          onChange={field.handleChange}
                          invalid={control.invalid}
                        />
                      )}
                    </field.Group>
                  )}
                </form.AppField>
                {kind === "entrada" ? (
                  <div className="grid grid-cols-2 gap-3">
                    <form.AppField name="quantity">
                      {(field) => <field.TextField label="Cuántas entran" inputMode="numeric" />}
                    </form.AppField>
                    <form.AppField name="cost">
                      {(field) => (
                        <field.Control
                          label="Costo por unidad"
                          description="Opcional. Con él se ve el margen."
                        >
                          {(control) => (
                            <MoneyInput
                              control={control}
                              currency={store.currency}
                              value={field.state.value}
                              onChange={field.handleChange}
                            />
                          )}
                        </field.Control>
                      )}
                    </form.AppField>
                  </div>
                ) : (
                  <form.AppField name="quantity">
                    {(field) => (
                      <field.TextField
                        label="Cuántas hay de verdad"
                        inputMode="numeric"
                        description={`Hoy dice ${stock}. El ajuste es la diferencia.`}
                      />
                    )}
                  </form.AppField>
                )}
                <form.AppField name="reason">
                  {(field) => (
                    <field.TextareaField
                      label={kind === "ajuste" ? "Motivo" : "Nota (opcional)"}
                      rows={2}
                      maxLength={300}
                      placeholder={
                        kind === "ajuste"
                          ? "par dañado, conteo de fin de mes"
                          : "compra al proveedor"
                      }
                    />
                  )}
                </form.AppField>
              </FieldGroup>
            ) : null}
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">Movimientos</h3>
              {kardex.isPending ? <p className="text-sm text-muted-foreground">Cargando…</p> : null}
              {kardex.isError ? (
                <ErrorState error={kardex.error} onRetry={() => void kardex.refetch()} />
              ) : null}
              {kardex.data && kardex.data.movements.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Todavía sin movimientos: el stock es 0.
                </p>
              ) : null}
              {kardex.data && kardex.data.movements.length > 0 ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-1.5 pr-2 font-semibold">Fecha</th>
                      <th className="py-1.5 pr-2 font-semibold">Movimiento</th>
                      <th className="py-1.5 pr-2 text-right font-semibold">Cant.</th>
                      <th className="py-1.5 text-right font-semibold">Saldo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {kardex.data.movements.map((m) => (
                      <tr key={m.id} className="border-b align-top last:border-0">
                        <td className="py-1.5 pr-2 whitespace-nowrap">{when(m.createdAt)}</td>
                        <td className="py-1.5 pr-2">
                          {MOVEMENT_NAMES[m.kind]}
                          {m.reference ? ` ${m.reference}` : ""}
                          {m.reason ? ` · «${m.reason}»` : ""}
                          {m.unitCostCents !== null
                            ? ` · ${money(m.unitCostCents, store.currency)} c/u`
                            : ""}
                          {m.actorName ? (
                            <span className="text-muted-foreground"> · {m.actorName}</span>
                          ) : null}
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">
                          {m.quantity > 0 ? `+${m.quantity}` : `−${-m.quantity}`}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">{m.balance}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>
          </div>
        </FormDrawer>
      )}
    </form.Subscribe>
  )
}

/** «Quién cambió qué»: cada cambio guardado, con quién y cuándo; arriba, lo que falta guardar. */
export function HistoryDrawer({ pending, onClose }: { pending: number; onClose: () => void }) {
  const { store, sheet, unit, unitOne } = useFichaContext()
  const history = useHistory(store.id, sheet.id)
  const words = { unit, unitOne, money: (c: number) => money(c, store.currency) }
  return (
    <DetailDrawer
      open
      onClose={onClose}
      title="Quién cambió qué"
      description="Cada cambio guardado de la ficha, con quién y cuándo."
      size="lg"
    >
      {pending ? (
        <div className="flex flex-col gap-1.5 rounded-xl border border-dashed p-3 text-sm">
          <span className="font-semibold">Sin guardar todavía</span>
          <span className="text-muted-foreground">
            {pending} {pending === 1 ? "cambio se está guardando" : "cambios se están guardando"}.
          </span>
        </div>
      ) : null}
      {history.isError ? (
        <ErrorState error={history.error} onRetry={() => void history.refetch()} />
      ) : null}
      {history.data ? (
        <ol className="relative flex flex-col gap-4 pl-5 before:absolute before:top-1 before:bottom-1 before:left-[5px] before:w-px before:bg-border">
          {history.data.events.map((e) => (
            <li key={e.id} className="relative flex flex-col text-sm">
              <span
                className="absolute top-1.5 -left-5 size-[11px] rounded-full border-2 border-card bg-muted-foreground/50"
                aria-hidden
              />
              <span>{eventLine(e, words)}</span>
              {e.reason ? (
                <span className="text-muted-foreground">Motivo: «{e.reason}»</span>
              ) : null}
              <span className="text-xs text-muted-foreground">
                {e.actorName ?? "Alguien del equipo"} · {when(e.createdAt)}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </DetailDrawer>
  )
}

/** «Buscar en la ficha» (/): ir a un campo por su nombre. */
export function SearchDialog({
  templates,
  onClose,
}: {
  templates: RubroTemplate[]
  onClose: () => void
}) {
  const { sheet, draft } = useFichaContext()
  const rubro = templates.find((t) => t.id === draft.rubro)
  const fields = draft.rubro === sheet.rubro ? sheet.template : (rubro?.fields ?? [])
  const groups: [string, [string, string][]][] = [
    [
      "Producto",
      [
        ["Fotos", "fotos"],
        ["Nombre", "texto"],
        ["Descripción para vender", "texto"],
        ["Variantes", "variantes"],
        ["Stock por variante", "stock"],
      ],
    ],
    [
      "Precio y Sofi",
      [
        ["Precio", "precio"],
        ["Mínimo", "campo-minimo"],
        ["Lo que Sofi puede ofrecer", "ofertas"],
        ["Precio por cantidad y promociones", "promos"],
        ["Probar cuánto cobraría Sofi", "simulador"],
      ],
    ],
    [
      rubro ? `Datos de ${rubro.label.toLowerCase()}` : "Datos para vender",
      [
        ...fields.map((f) => [f.label, `dato-${f.key}`] as [string, string]),
        ["Preguntas respondidas", "preguntas"],
      ],
    ],
    [
      "Al costado",
      [
        ["Estado", "estado"],
        ["Catálogo web", "web"],
        ["Categoría, código y cómo la buscan", "organizacion"],
        ["Inventario y kardex", "inventario"],
        ["Paquete para la agencia", "paquete"],
        ["Venta cruzada", "cruzada"],
        ["Quién cambió qué", "actividad"],
      ],
    ],
  ]
  return (
    <CommandDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Buscar en la ficha"
      description={`Ir a un campo de ${draft.name}`}
    >
      <Command>
        <CommandInput placeholder="Buscar en la ficha: precio, material, talla…" />
        <CommandList>
          <CommandEmpty>Nada con ese nombre en esta ficha.</CommandEmpty>
          {groups.map(([group, items]) => (
            <CommandGroup key={group} heading={group}>
              {items.map(([label, target]) => (
                <CommandItem
                  key={`${group}${label}`}
                  value={`${label} ${group}`}
                  onSelect={() => {
                    onClose()
                    setTimeout(() => goTo(target), 120)
                  }}
                >
                  <Search className="text-muted-foreground" aria-hidden />
                  {label}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
          {draft.grid?.rowName ? (
            <CommandGroup heading={draft.grid.rowName}>
              {draft.grid.rows.map((r) => (
                <CommandItem
                  key={r.id}
                  value={`${r.value} ${draft.grid?.rowName}`}
                  onSelect={() => {
                    onClose()
                    setTimeout(() => goTo("variantes"), 120)
                  }}
                >
                  <Swatch hex={r.hex} hex2={r.hex2} />
                  {r.value}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}

/** Los atajos de la ficha («?»). */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const rows: [string[], string][] = [
    [["/"], "Buscar en la ficha"],
    [["Ctrl", "Z"], "Deshacer"],
    [["Ctrl", "Mayús", "Z"], "Rehacer"],
    [["?"], "Ver los atajos"],
  ]
  const grid: [string[], string][] = [
    [["Flechas"], "Moverse"],
    [["Mayús", "Flechas"], "Elegir varias"],
    [["Un número"], "Llenar lo elegido"],
    [["Ctrl", "V"], "Pegar desde Excel"],
  ]
  const list = (items: [string[], string][]) => (
    <dl className="flex flex-col gap-2.5 text-sm">
      {items.map(([keys, what]) => (
        <div key={what} className="flex items-center justify-between gap-3">
          <dt>{what}</dt>
          <dd className="flex gap-1">
            {keys.map((k) => (
              <Kbd key={k}>{k}</Kbd>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  )
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Atajos de teclado</DialogTitle>
          <DialogDescription>Funcionan cuando no estás escribiendo en un campo.</DialogDescription>
        </DialogHeader>
        {list(rows)}
        <h3 className="text-sm font-semibold">En la cuadrícula de variantes</h3>
        {list(grid)}
      </DialogContent>
    </Dialog>
  )
}
