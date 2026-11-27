import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  toast,
} from "@odentia/ui"
import {
  DataTable,
  FilterBar,
  type FilterDef,
  PageHeader,
  PageNotice,
  PageShell,
  PersonAvatar,
  ListSearchScope,
  useScopedListSearch,
  ViewTabs,
} from "@odentia/ui-patterns"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { BookmarkPlus, Send, Users } from "lucide-react"
import { useMemo, useState } from "react"
import {
  type Clienta,
  type Perfil,
  perfil,
  plural,
  quienEs,
  RUBROS,
  SEG,
  SEG_IDS,
  type Seg,
  soles,
} from "./datos"
import { cambiar, useDb } from "./estado"
import { DeArgos, SegBadge } from "./piezas"
import { ir, useRuta } from "./ruta"

type Fila = { c: Clienta; k: Perfil }

function cumple(q: Record<string, string | undefined>, { c, k }: Fila): boolean {
  if (q.grupo && k.seg !== q.grupo) return false
  if (q.talla && c.datos.talla?.valor !== q.talla && !k.sizes.some((s) => s[0] === q.talla))
    return false
  if (q.cat && !k.cats.some((x) => x[0] === q.cat)) return false
  if (q.dist && c.dist !== q.dist) return false
  if (q.promo === "si" && c.consent.estado !== "si") return false
  if (q.promo === "no" && c.consent.estado === "si") return false
  return true
}

/** Clientes: cada clienta con el grupo que Argos le calculó y lo que anotó de ella. */
export function ClientesPage() {
  const ruta = useRuta()
  const R = RUBROS[ruta.rubro]
  const d = useDb(ruta.rubro)
  const owner = !ruta.ventas
  // Los filtros viven en la pantalla (el prototipo no tiene direcciones propias para ellos).
  const s = useScopedListSearch({})
  const q: Record<string, string | undefined> = {
    grupo: s.get("grupo"),
    talla: s.get("talla"),
    cat: s.get("cat"),
    dist: s.get("dist"),
    promo: s.get("promo"),
    orden: s.get("sort"),
  }
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState("")

  const visibles = d.cl.filter((c) => !c.oculta).length
  // La tabla recibe la misma lista mientras no cambie lo elegido: una lista nueva en cada dibujo la
  // haría medirse otra vez sin parar.
  const all: Fila[] = useMemo(
    () => d.cl.filter((c) => !c.oculta).map((c) => ({ c, k: perfil(c) })),
    // biome-ignore lint/correctness/useExhaustiveDependencies: el estado cambia en su lugar
    [d, visibles, d.merged],
  )
  const sinGrupo = { ...q, grupo: undefined }
  const clave = JSON.stringify(q)
  const rows = useMemo(
    () =>
      all
        .filter((f) => cumple(q, f))
        .sort((a, b) =>
          q.orden === "gasto" ? b.k.total - a.k.total : (a.k.last ?? 9999) - (b.k.last ?? 9999),
        ),
    // biome-ignore lint/correctness/useExhaustiveDependencies: `clave` resume lo elegido
    [all, clave],
  )
  const anyFilter = !!(q.grupo || q.talla || q.cat || q.dist || q.promo)
  const uniq = (xs: string[]) =>
    [...new Set(xs)].sort((a, b) => a.localeCompare(b, "es", { numeric: true }))
  const filters: FilterDef[] = [
    {
      key: "talla",
      label: R.field,
      type: "select",
      options: uniq(R.sizes).map((v) => ({ value: v, label: v })),
    },
    {
      key: "cat",
      label: "Categoría",
      type: "select",
      options: uniq(R.P.map((p) => p.cat)).map((v) => ({ value: v, label: v })),
    },
    {
      key: "dist",
      label: "Distrito",
      type: "select",
      options: uniq(all.map((f) => f.c.dist)).map((v) => ({ value: v, label: v })),
    },
    {
      key: "promo",
      label: "Promociones",
      type: "select",
      options: [
        { value: "si", label: "Aceptan promociones" },
        { value: "no", label: "No las reciben" },
      ],
    },
  ]
  const anotados = d.cl.reduce(
    (n, c) => n + Object.values(c.datos).filter((x) => x?.quien === "Argos").length,
    0,
  )

  const columns = useMemo<ColumnDef<Fila>[]>(
    () => [
      {
        id: "clienta",
        header: "Clienta",
        meta: { view: { role: "title" } },
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-3">
            <PersonAvatar name={row.original.c.name} className="size-9" decorative />
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-semibold">{row.original.c.name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {quienEs(row.original.c, row.original.k, R).split(" · ").slice(1).join(" · ")}
              </span>
            </span>
          </span>
        ),
      },
      {
        id: "grupo",
        header: "Grupo",
        meta: { view: { primary: true } },
        cell: ({ row }) => <SegBadge seg={row.original.k.seg} />,
      },
      {
        id: "talla",
        header: R.field,
        meta: { view: { tableOnly: true } },
        cell: ({ row }) => {
          const t = row.original.c.datos.talla
          return t ? (
            <span className="flex items-center gap-2">
              {t.valor}
              {t.dudas ? <Badge variant="warning">Por confirmar</Badge> : null}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )
        },
      },
      {
        id: "compra",
        header: "Última compra",
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          const l = row.original.k.last
          return (
            <span className="tabular-nums">
              {l == null ? "Sin compras" : l === 0 ? "Hoy" : `Hace ${l} días`}
            </span>
          )
        },
      },
      {
        id: "gasto",
        header: "Gastó",
        meta: { view: { tableOnly: true } },
        cell: ({ row }) => <span className="tabular-nums">{soles(row.original.k.total)}</span>,
      },
      {
        id: "promo",
        header: "Promociones",
        meta: { view: { tableOnly: true } },
        cell: ({ row }) => {
          const e = row.original.c.consent.estado
          return e === "si" ? (
            <Badge variant="success">Acepta</Badge>
          ) : e === "baja" ? (
            <Badge variant="destructive">Pidió que no</Badge>
          ) : (
            <Badge variant="outline">Sin permiso</Badge>
          )
        },
      },
    ],
    [R],
  )
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })
  const parecida = d.cl.find(
    (c) => c.parecida && !c.oculta && !d.merged && !d.distinct && c.id === "c1",
  )

  return (
    <ListSearchScope value={s}>
      <PageShell className="flex flex-col gap-5">
        <PageHeader
          title="Clientes"
          subtitle={
            <DeArgos className="text-sm">
              {plural(all.length, "clienta", "clientas")} · Argos las perfila solo: {anotados} datos
              anotados de sus chats y pedidos
            </DeArgos>
          }
          primary={
            owner && anyFilter
              ? {
                  label: `Avisar a ${rows.length === 1 ? "ella" : `estas ${rows.length}`}`,
                  icon: <Send aria-hidden />,
                  onClick: () => {
                    const n = rows.filter(
                      (f) => f.c.consent.estado === "si" && f.c.ch.includes("wa"),
                    ).length
                    toast.success(
                      `Argos le encarga a Sofi escribirles a ${plural(n, "clienta", "clientas")} hoy a las 16:00, dentro del tope. Meta: ${soles(n * 0.2339)}.`,
                    )
                  },
                }
              : undefined
          }
          secondary={{
            label: "Guardar como grupo",
            icon: <BookmarkPlus aria-hidden />,
            disabled: !anyFilter,
            onClick: () => {
              setName(
                [q.grupo && SEG[q.grupo as Seg].label, q.cat, q.talla, q.dist]
                  .filter(Boolean)
                  .join(" · ") || "Mi grupo",
              )
              setSaving(true)
            },
          }}
        />
        {parecida ? (
          <PageNotice
            tone="aviso"
            label="Por mirar"
            action={
              <Button size="sm" variant="outline" onClick={() => ir(`/clientes/${parecida.id}`)}>
                Comparar
              </Button>
            }
          >
            Argos cree que dos fichas de «{parecida.name}» son la misma clienta. Unirlas lo decide
            una persona; no frena ninguna venta.
          </PageNotice>
        ) : null}
        <ViewTabs
          label="Grupo de la clienta"
          value={(q.grupo ?? "todas") as string}
          onValueChange={(v) => s.setParam("grupo", v === "todas" ? undefined : v)}
          options={[
            {
              value: "todas",
              label: "Todas",
              count: all.filter((f) => cumple(sinGrupo, f)).length,
            },
            ...SEG_IDS.map((g) => ({
              value: g,
              label: SEG[g].label,
              count: all.filter((f) => f.k.seg === g && cumple(sinGrupo, f)).length,
            })).filter((o) => all.some((f) => f.k.seg === o.value)),
          ]}
        />
        <FilterBar
          filters={filters}
          sortOptions={[
            { value: "reciente", label: "Compró hace menos" },
            { value: "gasto", label: "Gastó más" },
          ]}
          searchLabel="Buscar en clientes"
          searchPlaceholder="Buscar por nombre o teléfono"
          showSearch={false}
        />
        {d.grupos.length ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">Tus grupos</span>
            {d.grupos.map((g) => (
              <Button
                key={g.id}
                size="sm"
                variant="outline"
                onClick={() =>
                  s.setParams({
                    grupo: undefined,
                    talla: undefined,
                    cat: undefined,
                    dist: undefined,
                    promo: undefined,
                    ...g.q,
                  })
                }
              >
                <Users aria-hidden />
                {g.name}
                <span className="text-muted-foreground">
                  {all.filter((f) => cumple(g.q, f)).length}
                </span>
              </Button>
            ))}
          </div>
        ) : null}
        <DataTable table={table} onRowClick={(f) => ir(`/clientes/${f.c.id}`)} />
        <Dialog open={saving} onOpenChange={setSaving}>
          <DialogContent>
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault()
                const qq = Object.fromEntries(
                  Object.entries({
                    grupo: q.grupo,
                    talla: q.talla,
                    cat: q.cat,
                    dist: q.dist,
                    promo: q.promo,
                  }).filter(([, v]) => v),
                ) as Record<string, string>
                cambiar(ruta.rubro, (x) =>
                  x.grupos.push({
                    id: `g${x.grupos.length + 1}`,
                    name: name.trim() || "Mi grupo",
                    q: qq,
                  }),
                )
                setSaving(false)
                toast.success(
                  `Grupo «${name.trim() || "Mi grupo"}» guardado. Argos lo pone al día solo.`,
                )
              }}
            >
              <DialogHeader>
                <DialogTitle>Guardar como grupo</DialogTitle>
                <DialogDescription>
                  Argos lo pone al día solo: entra quien cumpla, sale quien no. Hoy son{" "}
                  {plural(rows.length, "clienta", "clientas")}.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-2">
                <Label htmlFor="grupo-nombre">Nombre</Label>
                <Input
                  id="grupo-nombre"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
              </div>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setSaving(false)}>
                  Cancelar
                </Button>
                <Button type="submit">Guardar grupo</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </PageShell>
    </ListSearchScope>
  )
}
