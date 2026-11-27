import { Badge, cn, useIsMobile } from "@odentia/ui"
import { DataTable, DataTableSkeleton, PageHeader, PageShell } from "@odentia/ui-patterns"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Camera, FileSpreadsheet, ImagePlus, Sparkles, Upload } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { AddFromPhotos } from "./agregar"
import { ESTADOS, foto, type Producto, RUBROS } from "./datos"
import { SofiDot, Swatch } from "./ficha/piezas"
import { priceSpan, soldOut, totalStock } from "./precio"
import { ir, useRuta } from "./ruta"
import { resumen, saber } from "./sofi"
import { useDb, useTienda } from "./tienda"

/** El catálogo: cada producto con su foto, precio, variantes, stock, estado y lo que Sofi sabe. */
export function CatalogPage() {
  const ruta = useRuta()
  const d = useDb()
  const owner = useTienda((s) => s.rol === "dueno")
  const R = RUBROS[ruta.rubro]
  const isMobile = useIsMobile()
  const [adding, setAdding] = useState(false)
  // La primera vez se ve cómo carga: el mismo hueco que dejará la tabla, sin saltos.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 420)
    return () => clearTimeout(t)
  }, [])

  const columns = useMemo<ColumnDef<Producto>[]>(
    () => [
      {
        id: "foto",
        header: "Foto",
        meta: { view: { role: "media" } },
        cell: ({ row }) => {
          const m = row.original.media.find((x) => x.kind === "foto") ?? row.original.media[0]
          return m ? (
            <img
              src={foto(m.kind === "video" ? (m.poster ?? "") : m.src)}
              alt=""
              className="size-11 rounded-lg bg-muted object-cover"
            />
          ) : (
            <span className="flex size-11 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <ImagePlus className="size-4" aria-hidden />
            </span>
          )
        },
      },
      {
        id: "producto",
        header: "Producto",
        meta: { view: { role: "title" } },
        cell: ({ row }) => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-semibold">{row.original.name}</span>
            <span className="truncate text-xs text-muted-foreground">{row.original.cat}</span>
          </span>
        ),
      },
      {
        id: "precio",
        header: "Precio",
        meta: { view: { primary: true } },
        cell: ({ row }) => <span className="tabular-nums">{priceSpan(row.original)}</span>,
      },
      {
        id: "variantes",
        header: R.col ? `${R.row} y ${R.col.toLowerCase()}` : R.row,
        meta: { view: { tableOnly: true } },
        cell: ({ row }) => {
          const p = row.original
          const axis = R.col && p.sizes.length > 1 ? `${p.sizes[0]} a ${p.sizes.at(-1)}` : ""
          return (
            <span className="flex min-w-0 items-center gap-2">
              <span className="flex -space-x-1">
                {p.colors.map((c) => (
                  <Swatch key={c.id} color={c} className="size-4 ring-2 ring-card" />
                ))}
              </span>
              <span className="truncate text-sm">
                {p.colors.map((c) => c.name).join(", ")}
                {axis ? <span className="text-muted-foreground"> · {axis}</span> : null}
              </span>
            </span>
          )
        },
      },
      {
        id: "stock",
        header: "Queda",
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          const n = totalStock(row.original)
          const out = soldOut(row.original)
          return n === 0 ? (
            <Badge variant="outline">Agotado</Badge>
          ) : (
            <span className="tabular-nums">
              {n} {n === 1 ? R.unitOne : R.unit}
              {out ? <span className="text-muted-foreground"> · {out} sin stock</span> : null}
            </span>
          )
        },
      },
      {
        id: "estado",
        header: "Estado",
        meta: { view: { tableOnly: true } },
        cell: ({ row }) => {
          const e = ESTADOS.find((x) => x.id === row.original.estado)!
          return (
            <Badge
              variant={e.id === "disponible" ? "success" : e.id === "no" ? "outline" : "secondary"}
            >
              {e.label}
            </Badge>
          )
        },
      },
      {
        id: "sofi",
        header: "Sofi",
        meta: { view: { tableOnly: true } },
        cell: ({ row }) => {
          const s = resumen(saber(row.original, R, d.tpl))
          return (
            <span className="flex items-center gap-2 text-sm">
              <SofiDot done={s.done} total={s.total} vendeSola={s.vendeSola} />
              <span className={cn(!s.vendeSola && "text-warning")}>
                {s.completo
                  ? "Responde todo"
                  : s.vendeSola
                    ? "Vende sola"
                    : `Le faltan ${s.needMiss.length}`}
              </span>
            </span>
          )
        },
      },
    ],
    [R, d.tpl],
  )
  const table = useReactTable({ data: d.products, columns, getCoreRowModel: getCoreRowModel() })
  const variants = d.products.reduce((n, p) => n + p.colors.length * p.sizes.length, 0)
  const out = d.products.filter((p) => totalStock(p) === 0).length

  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader
        title="Catálogo"
        subtitle={`${d.products.length} productos · ${variants} variantes${out ? ` · ${out} agotado` : ""}`}
        primary={
          owner
            ? isMobile
              ? {
                  label: "Tomar fotos",
                  icon: <Camera aria-hidden />,
                  onClick: () => ir("/catalogo/camara"),
                }
              : {
                  label: "Agregar desde fotos",
                  icon: <Sparkles aria-hidden />,
                  onClick: () => setAdding(true),
                }
            : undefined
        }
        secondary={
          owner
            ? {
                label: "Cargar muchos",
                icon: <Upload aria-hidden />,
                onClick: () => ir("/catalogo/cargar"),
              }
            : undefined
        }
        menu={
          owner
            ? [
                ...(isMobile
                  ? [
                      {
                        label: "Agregar desde fotos",
                        icon: <Sparkles aria-hidden />,
                        onSelect: () => setAdding(true),
                      },
                    ]
                  : []),
                { label: "Subir una hoja", icon: <FileSpreadsheet aria-hidden /> },
              ]
            : undefined
        }
      />
      {ready ? (
        <DataTable table={table} onRowClick={(p) => ir(`/catalogo/${p.id}`)} />
      ) : (
        <DataTableSkeleton
          columnCount={7}
          rowCount={Math.max(2, d.products.length)}
          label="Cargando el catálogo"
        />
      )}
      {adding ? <AddFromPhotos onClose={() => setAdding(false)} /> : null}
    </PageShell>
  )
}
