import { Button, cn } from "@odentia/ui"
import {
  AiQuestion,
  AiSuggestion,
  AiSuggestionBar,
  AiSuggestionChips,
  PageNotice,
} from "@odentia/ui-patterns"
import { useQueryClient } from "@tanstack/react-query"
import { Sparkles } from "lucide-react"
import { createContext, type ReactNode, useContext, useMemo, useState } from "react"
import type { Sheet, TemplateField } from "../lib/ficha"
import {
  type Cap,
  type ColorValue,
  keyOf,
  type LastLook,
  type Proposal,
  useFichaProposals,
  useProductProposals,
} from "../lib/ia"
import type { FichaStore } from "./borrador"
import { PRODUCT_KEY } from "./datos"
import { Swatch } from "./piezas"

/**
 * Lo que propone la IA en la ficha (prototipo: los ✦ de `ficha/*.tsx`): cada propuesta junto a su
 * campo, con «Usar», «Cambiar» y «Descartar» (`AiSuggestion` de lo común), «Aplicar todos» arriba y
 * lo que no se ve como pregunta en amarillo. Usar guarda primero lo que la persona tenía sin
 * guardar y después le pide al servidor que lo use: la ficha que vuelve reemplaza la de la
 * pantalla. Quien no cambia el catálogo no ve propuestas.
 */

interface FichaIa {
  proposals: Proposal[]
  look: LastLook | null
  cap: Cap | null
  /** Quien cambia el catálogo: ve, usa y pide propuestas. */
  active: boolean
  busy: boolean
  asking: boolean
  ask: () => void
  use: (proposal: Proposal, value?: unknown) => void
  discard: (proposal: Proposal) => void
  applyAll: () => void
  of: (field: string) => Proposal | undefined
}

const IaContext = createContext<FichaIa | null>(null)

export function useFichaIa(): FichaIa {
  const value = useContext(IaContext)
  if (!value) throw new Error("Fuera de la ficha")
  return value
}

export function FichaIaProvider({
  storeId,
  productId,
  edit,
  store,
  children,
}: {
  storeId: string
  productId: string
  edit: boolean
  store: FichaStore
  children: ReactNode
}) {
  const queryClient = useQueryClient()
  const query = useProductProposals(storeId, productId)
  const actions = useFichaProposals(storeId, productId, {
    beforeUse: () => store.flush(),
    onSheet: (sheet: Sheet) =>
      queryClient.setQueryData(PRODUCT_KEY(storeId, productId), { product: sheet }),
  })
  const proposals = edit ? (query.data?.proposals ?? []) : []
  const value = useMemo<FichaIa>(
    () => ({
      proposals,
      look: query.data?.look ?? null,
      cap: query.data?.cap ?? null,
      active: edit,
      busy: actions.use.isPending || actions.discard.isPending || actions.all.isPending,
      asking: actions.look.isPending,
      ask: () => actions.look.mutate(),
      use: (proposal, value) => actions.use.mutate({ id: proposal.id, value }),
      discard: (proposal) => actions.discard.mutate(proposal.id),
      applyAll: () => actions.all.mutate(),
      of: (field) => proposals.find((p) => p.field === field),
    }),
    [proposals, query.data, edit, actions],
  )
  return <IaContext.Provider value={value}>{children}</IaContext.Provider>
}

/** «Proponer con la IA»: mira las fotos del producto. Sin IA o en el tope, dice por qué. */
export function AskButton({
  label = "Completar",
  className,
}: {
  label?: string
  className?: string
}) {
  const ia = useFichaIa()
  if (!ia.active) return null
  const off = ia.cap && !ia.cap.available
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={cn("text-primary", className)}
      disabled={ia.asking || !!off}
      title={off ? (ia.cap?.message ?? undefined) : "La IA mira las fotos y propone; tú decides"}
      onClick={ia.ask}
    >
      <Sparkles aria-hidden className={cn(ia.asking && "motion-safe:animate-pulse")} />
      {ia.asking ? "Mirando las fotos…" : label}
    </Button>
  )
}

/** Arriba de la ficha: cuántas propuestas esperan, «Aplicar todos» y lo que avisa la IA. */
export function IaBar() {
  const ia = useFichaIa()
  if (!ia.active) return null
  const usable = ia.proposals.filter((p) => p.kind !== "pregunta")
  const questions = ia.proposals.length - usable.length
  return (
    <>
      {ia.look?.state === "fallo" && ia.look.failure ? (
        <PageNotice tone="aviso" label="La IA no pudo mirar">
          {ia.look.failure} Puedes seguir a mano.
        </PageNotice>
      ) : null}
      {ia.look?.notice && usable.length ? (
        <PageNotice tone="aviso" label="Ojo con las fotos">
          {ia.look.notice}
        </PageNotice>
      ) : null}
      <AiSuggestionBar count={usable.length} onAcceptAll={ia.applyAll}>
        La IA propone {usable.length} {usable.length === 1 ? "cosa" : "cosas"}
        {questions
          ? ` y pregunta ${questions === 1 ? "lo que no ve" : `${questions} cosas que no ve`}`
          : ""}
        . Nada se guarda hasta que lo uses.
      </AiSuggestionBar>
    </>
  )
}

/** Lo que dice el tope o la IA apagada, sin frenar nada. */
export function CapNote({ className }: { className?: string }) {
  const ia = useFichaIa()
  if (!ia.active || !ia.cap || ia.cap.available || !ia.cap.message) return null
  return <p className={cn("text-xs text-muted-foreground", className)}>{ia.cap.message}</p>
}

/** La propuesta de un texto (nombre, categoría, descripción): «Cambiar» lo edita ahí mismo. */
export function TextProposal({ field, block = false }: { field: string; block?: boolean }) {
  const ia = useFichaIa()
  const proposal = ia.of(field)
  if (!proposal || typeof proposal.value !== "string") return null
  const value = proposal.value
  return (
    <AiSuggestion
      text={value}
      reason={proposal.reason}
      layout={block ? "block" : "row"}
      onAccept={(text) => ia.use(proposal, text !== undefined && text !== value ? text : undefined)}
      onDiscard={() => ia.discard(proposal)}
    />
  )
}

/** El rubro propuesto, junto a los rubros. */
export function RubroProposal({ labelOf }: { labelOf: (id: string) => string }) {
  const ia = useFichaIa()
  const proposal = ia.of("rubro")
  if (!proposal || typeof proposal.value !== "string") return null
  return (
    <AiSuggestion
      layout="row"
      reason={proposal.reason}
      onAccept={() => ia.use(proposal)}
      onDiscard={() => ia.discard(proposal)}
    >
      Rubro: <span className="font-medium">{labelOf(proposal.value)}</span>
    </AiSuggestion>
  )
}

/** Un dato del rubro que la IA vio, o la pregunta en amarillo si no se ve. */
export function DataProposal({ field }: { field: TemplateField }) {
  const ia = useFichaIa()
  const seen = ia.of(`dato:${field.key}`)
  const asked = ia.of(`pregunta:${field.key}`)
  if (seen)
    return (
      <AiSuggestion
        layout="row"
        reason={seen.reason}
        onAccept={() => ia.use(seen)}
        onDiscard={() => ia.discard(seen)}
      >
        {field.label}: <span className="font-medium">{String(seen.value)}</span>
      </AiSuggestion>
    )
  if (!asked) return null
  // La respuesta va en el campo de arriba, el de siempre: la pregunta solo dice por qué falta.
  return (
    <AiQuestion question={asked.reason} reason="Lo respondes arriba cuando quieras: nada se frena.">
      <Button
        type="button"
        size="xs"
        variant="ghost"
        className="self-start"
        onClick={() => ia.discard(asked)}
      >
        Ahora no
      </Button>
    </AiQuestion>
  )
}

/** Las palabras con que la buscan: una pastilla por palabra; al decidir todas, queda decidido. */
export function KeywordProposals({ onAdd }: { onAdd: (word: string) => void }) {
  const ia = useFichaIa()
  const proposal = ia.of("palabras")
  const [decided, setDecided] = useState<Record<string, boolean>>({})
  if (!proposal || !Array.isArray(proposal.value)) return null
  const words = (proposal.value as string[]).filter((w) => !(w in decided))
  const settle = (next: Record<string, boolean>) => {
    setDecided(next)
    const all = proposal.value as string[]
    if (all.every((w) => w in next)) {
      const kept = all.filter((w) => next[w])
      // Lo que quedó se anota en la propuesta; las palabras ya entraron a la ficha.
      if (kept.length) ia.use(proposal, kept.length === all.length ? undefined : kept)
      else ia.discard(proposal)
    }
  }
  return (
    <AiSuggestionChips
      aria-label="Palabras que propone la IA"
      items={words.map((w) => ({ id: w, label: w }))}
      onAccept={(w) => {
        onAdd(w)
        settle({ ...decided, [w]: true })
      }}
      onDiscard={(w) => settle({ ...decided, [w]: false })}
    />
  )
}

/** Los colores que vio la IA, con su hex y sus fotos: usarlo lo suma a «Variantes». */
export function ColorProposals() {
  const ia = useFichaIa()
  const colors = ia.proposals.filter((p) => p.kind === "color")
  if (!colors.length) return null
  return (
    <div className="flex flex-col gap-2">
      {colors.map((proposal) => {
        const color = proposal.value as ColorValue
        return (
          <AiSuggestion
            key={proposal.id}
            layout="row"
            reason={proposal.reason}
            onAccept={() => ia.use(proposal)}
            onDiscard={() => ia.discard(proposal)}
          >
            <span className="inline-flex items-center gap-2">
              <Swatch hex={color.hex} hex2={color.hex2} className="size-5" />
              <span className="font-medium">{color.name}</span>
              {color.photos.length ? (
                <span className="text-xs text-muted-foreground">
                  {color.photos.length} {color.photos.length === 1 ? "foto" : "fotos"}
                </span>
              ) : null}
            </span>
          </AiSuggestion>
        )
      })}
    </div>
  )
}

export { keyOf }
