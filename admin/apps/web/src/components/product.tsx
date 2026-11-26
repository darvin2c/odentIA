/**
 * El producto de cada clínica en la administración (lienzo «Administración en
 * negro»): la administración es neutra y el color solo dice de qué app es cada
 * clínica, odentIA en celeste, latidIA en lila y vistIA en verde. Va como un punto con su nombre,
 * nunca como pastilla, para no confundirse con los estados.
 */
import { CLINICAL_PRODUCTS, type ClinicalProduct, isClinicalProduct, productWords } from "@odentia/clinical"
import { cn } from "@odentia/ui"
import { ToggleGroup, ToggleGroupItem } from "@odentia/ui/components/toggle-group"
import { useQuery } from "@tanstack/react-query"
import { z } from "zod"
import { api } from "../lib/api"

/** «Todos» o un producto. */
export type ProductChoice = ClinicalProduct | "todos"

const DOT: Record<ClinicalProduct, string> = {
  dental: "bg-[var(--product-dental)]",
  medical: "bg-[var(--product-medical)]",
  optical: "bg-[var(--product-optical)]",
}
const INK: Record<ClinicalProduct, string> = {
  dental: "text-[var(--product-dental-foreground)]",
  medical: "text-[var(--product-medical-foreground)]",
  optical: "text-[var(--product-optical-foreground)]",
}
/** Lo que es la clínica, para la ficha: «latidIA · consultorio médico». */
const KIND: Record<ClinicalProduct, string> = {
  dental: "clínica dental",
  medical: "consultorio médico",
  optical: "óptica",
}

/** El punto de color de un producto. */
export function ProductDot({ product, className }: { product: ClinicalProduct; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", DOT[product], className)} />
}

/** Un esquema con una entrada por producto, para lo que la API cuenta de cada uno. */
export function perProduct<T extends z.ZodType>(shape: T) {
  return z.object(Object.fromEntries(CLINICAL_PRODUCTS.map((product) => [product, shape])) as Record<ClinicalProduct, T>)
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

/** El nombre de cada app que es otro sistema, como lo ve el equipo. */
export const APP_NAMES: Record<string, string> = { gestoria: "gestorIA" }

/** «● gestorIA»: la app de una cuenta que no es una clínica, con el mismo trazo que el producto. */
export function AppMark({ app, className = "" }: { app: string; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-semibold text-foreground ${className}`}
    >
      <span
        aria-hidden
        className="inline-block size-2 shrink-0 rounded-full border border-foreground"
      />
      {APP_NAMES[app] ?? app}
    </span>
  )
}

/**
 * La app a la que escribieron un correo: «● odentIA» por su producto o «● gestorIA» si es otro
 * sistema. Una que esta pantalla no conoce no se dice.
 */
export function MailAppMark({ app, className }: { app: string | null; className?: string }) {
  if (isClinicalProduct(app)) return <ProductMark product={app} {...(className ? { className } : {})} />
  if (app && APP_NAMES[app]) return <AppMark app={app} {...(className ? { className } : {})} />
  return null
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
  const counts = {
    todos: rows.length,
    ...(Object.fromEntries(CLINICAL_PRODUCTS.map((product) => [product, 0])) as Record<ClinicalProduct, number>),
  } satisfies Record<ProductChoice, number>
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
        if (picked === "todos" || isClinicalProduct(picked)) onChange(picked)
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

/** Cómo se supo de qué app es una conversación (lo dice el servidor, `saas_chat.product_source`). */
export const CHAT_APP_SOURCES = ["anuncio", "enlace", "lo_dijo", "persona", "cliente"] as const
export type ChatAppSource = (typeof CHAT_APP_SOURCES)[number]

const CHAT_APP_SOURCE_WORDS: Record<ChatAppSource, string> = {
  anuncio: "por el anuncio",
  enlace: "por el enlace",
  lo_dijo: "lo dijo",
  persona: "la eligió el equipo",
  cliente: "de su ficha",
}

/** La app de una conversación como la manda la API: nula si todavía no se sabe. */
export const chatAppSchema = z
  .object({
    product: z.string(),
    // Un origen que esta pantalla no conoce no se dice: mejor nada que algo falso.
    source: z
      .string()
      .transform((value): ChatAppSource | null =>
        (CHAT_APP_SOURCES as readonly string[]).includes(value) ? (value as ChatAppSource) : null,
      ),
  })
  .nullable()
  .default(null)
export type ChatApp = z.infer<typeof chatAppSchema>

/**
 * «● latidIA · por el anuncio», o «App por saber» mientras no se sepa: el Grupo Sallca vende todas
 * sus apps por el mismo número y la conversación dice de cuál le hablan. Con cliente no repite
 * «de su ficha».
 */
export function ChatAppMark({ app, className }: { app: ChatApp; className?: string }) {
  if (!app || !isClinicalProduct(app.product))
    return <span className={cn("text-xs font-semibold text-muted-foreground", className)}>App por saber</span>
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs", className)}>
      <ProductMark product={app.product} />
      {app.source === null || app.source === "cliente" ? null : <span className="text-muted-foreground">· {CHAT_APP_SOURCE_WORDS[app.source]}</span>}
    </span>
  )
}
