/**
 * El producto de cada clínica en la administración (lienzo «Administración en
 * negro»): la administración es neutra y el color solo dice de qué app es cada
 * clínica, odentIA en celeste y latidIA en lila. Va como un punto con su nombre,
 * nunca como pastilla, para no confundirse con los estados.
 */
import { CLINICAL_PRODUCTS, type ClinicalProduct, productWords } from "@odentia/clinical"
import { cn } from "@odentia/ui"
import { ToggleGroup, ToggleGroupItem } from "@odentia/ui/components/toggle-group"
import { useQuery } from "@tanstack/react-query"
import { api } from "../lib/api"

/** «Todos» o un producto. */
export type ProductChoice = ClinicalProduct | "todos"

const DOT: Record<ClinicalProduct, string> = {
  dental: "bg-[var(--product-dental)]",
  medical: "bg-[var(--product-medical)]",
}
const INK: Record<ClinicalProduct, string> = {
  dental: "text-[var(--product-dental-foreground)]",
  medical: "text-[var(--product-medical-foreground)]",
}
/** Lo que es la clínica, para la ficha: «latidIA · consultorio médico». */
const KIND: Record<ClinicalProduct, string> = {
  dental: "clínica dental",
  medical: "consultorio médico",
}

/** El punto de color de un producto. */
export function ProductDot({ product, className }: { product: ClinicalProduct; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", DOT[product], className)} />
}

/** «● odentIA», o con `kind` «● latidIA · consultorio médico». */
export function ProductMark({ product, kind = false, className }: { product: ClinicalProduct; kind?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-semibold", INK[product], className)}>
      <ProductDot product={product} />
      {productWords(product).name}
      {kind ? ` · ${KIND[product]}` : null}
    </span>
  )
}

/** El producto de cada clínica, para marcar y filtrar las filas que solo traen su id. */
export function useOrgProducts() {
  return useQuery({
    queryKey: ["admin-organization-products"],
    queryFn: () => api<Record<string, ClinicalProduct>>("/api/admin/organizations/products"),
    staleTime: 60_000,
  })
}

/** ¿Esta fila entra con lo elegido? Sin saber su producto, solo entra en «Todos». */
export function matchesProduct(choice: ProductChoice, product: ClinicalProduct | undefined): boolean {
  return choice === "todos" || product === choice
}

/** Cuántas filas hay de cada producto, para el filtro. */
export function countByProduct<T>(rows: readonly T[], productOf: (row: T) => ClinicalProduct | undefined) {
  const counts = { todos: rows.length, dental: 0, medical: 0 } satisfies Record<ProductChoice, number>
  for (const row of rows) {
    const product = productOf(row)
    if (product) counts[product] += 1
  }
  return counts
}

/** Todos, odentIA o latidIA, con cuántas hay de cada uno. Empieza en «Todos». */
export function ProductFilter({
  value,
  onChange,
  counts,
  className,
}: {
  value: ProductChoice
  onChange: (value: ProductChoice) => void
  counts?: Partial<Record<ProductChoice, number>>
  className?: string
}) {
  const options: ProductChoice[] = ["todos", ...CLINICAL_PRODUCTS]
  return (
    <ToggleGroup
      aria-label="Producto"
      value={[value]}
      onValueChange={(next: unknown[]) => {
        const picked = next[0]
        // Tocar otra vez lo elegido no deja el filtro vacío.
        if (picked === "todos" || picked === "dental" || picked === "medical") onChange(picked)
      }}
      spacing={1}
      className={cn("flex-wrap rounded-3xl border bg-muted p-1", className)}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option}
          value={option}
          className="h-auto min-h-9 gap-1.5 rounded-3xl px-3.5 py-1.5 font-semibold text-foreground hover:bg-background/60 aria-pressed:bg-background aria-pressed:shadow-xs aria-pressed:hover:bg-background"
        >
          {option === "todos" ? "Todos" : (
            <>
              <ProductDot product={option} />
              {productWords(option).name}
            </>
          )}
          {counts?.[option] !== undefined ? <span className="font-medium text-muted-foreground tabular-nums">{counts[option]}</span> : null}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
