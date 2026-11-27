import { Badge, Button, cn } from "@odentia/ui"
import { EmptyState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { Link, useSearch } from "@tanstack/react-router"
import { ChevronLeft, LifeBuoy, MessageCircleQuestion } from "lucide-react"
import { type RefObject, useEffect, useRef, useSyncExternalStore } from "react"
import { api } from "./lib/api"
import {
  HELP_KEY,
  type HelpFaq,
  type HelpQuestion,
  type HelpView,
  questionStatus,
  whoLine,
} from "./lib/ayuda"
import { when } from "./lib/pedidos"
import { ErrorBlock, StoreHeader, useAskForHelp, useStoreContext } from "./tiendas"

/**
 * La Ayuda de la tienda (entrega 7 del lienzo «gestorIA como odentIA», tablero 19): una guía por
 * tarea, con las preguntas de cada rol, y «Pedir ayuda» para todo el equipo. Cada respuesta dice
 * quién puede hacerlo, con la matriz de permisos del servidor: Ventas no se pierde buscando algo
 * que su rol no ve. El asistente que contesta solo viene después (decisión 6).
 *
 * En el escritorio, las preguntas a la izquierda y la respuesta al lado; en el teléfono, la lista
 * o la respuesta, con la vuelta a la lista. `?pregunta=<id>` abre una respuesta.
 */

/** Desde aquí caben la lista y la respuesta lado a lado. */
const WIDE = "(min-width: 1024px)"

function useWide(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(WIDE)
      query.addEventListener("change", onChange)
      return () => query.removeEventListener("change", onChange)
    },
    () => window.matchMedia(WIDE).matches,
    () => true,
  )
}

export function HelpPage() {
  const { store } = useStoreContext()
  const help = useQuery({
    queryKey: HELP_KEY(store.id),
    queryFn: () => api<HelpView>(`/api/tiendas/${store.id}/ayuda`),
  })
  // El mismo «Pedir ayuda» de la cabecera (lo escrito sin enviar sigue ahí); soporte no lo tiene.
  const ask = useAskForHelp()
  return (
    <>
      <StoreHeader
        title="Ayuda"
        subtitle="Cómo hacer cada tarea, para tu rol."
        primary={
          ask ? { label: "Pedir ayuda", icon: <LifeBuoy aria-hidden />, onClick: ask } : undefined
        }
      />
      {help.isPending ? <p className="text-sm text-muted-foreground">Cargando…</p> : null}
      {help.isError ? <ErrorBlock error={help.error} onRetry={() => void help.refetch()} /> : null}
      {help.data ? (
        <>
          <Guide view={help.data} onAsk={ask} />
          {help.data.canAsk ? <Questions questions={help.data.questions} /> : null}
        </>
      ) : null}
    </>
  )
}

function Guide({ view, onAsk }: { view: HelpView; onAsk: (() => void) | null }) {
  const { store } = useStoreContext()
  const { pregunta } = useSearch({ strict: false }) as { pregunta?: string }
  const wide = useWide()
  const faqs = view.guide.flatMap((group) => group.faqs)
  const chosen = faqs.find((faq) => faq.id === pregunta)
  // En el escritorio siempre hay una respuesta a la vista; en el teléfono, la que se eligió.
  const shown = chosen ?? (wide ? faqs[0] : undefined)
  const heading = useRef<HTMLHeadingElement>(null)
  // En el teléfono la lista se va al elegir: el foco pasa a la respuesta.
  useEffect(() => {
    if (chosen && !wide) heading.current?.focus()
  }, [chosen, wide])
  return (
    <section aria-labelledby="ayuda-guia" className="flex flex-col gap-3">
      <h2 id="ayuda-guia" className="text-lg font-bold">
        ¿Qué necesitas hacer?
      </h2>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:items-start">
        {wide || !shown ? (
          <nav aria-label="Preguntas de la Ayuda" className="flex flex-col gap-3">
            {view.guide.map((group) => (
              <div key={group.id} className="flex flex-col gap-1">
                <h3 className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.title}
                </h3>
                <ul className="flex flex-col">
                  {group.faqs.map((faq) => {
                    const current = shown?.id === faq.id
                    return (
                      <li key={faq.id}>
                        <Link
                          to="/tiendas/$id/ayuda"
                          params={{ id: store.id }}
                          search={{ pregunta: faq.id }}
                          replace={wide}
                          aria-current={current ? "page" : undefined}
                          className={cn(
                            "flex min-h-11 items-center rounded-md px-2 py-2 text-sm leading-snug hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9",
                            current &&
                              "bg-primary/10 font-semibold text-primary hover:bg-primary/10",
                          )}
                        >
                          {faq.q}
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </nav>
        ) : null}
        {shown ? (
          <Answer faq={shown} role={view.role} back={!wide} onAsk={onAsk} headingRef={heading} />
        ) : null}
      </div>
    </section>
  )
}

function Answer({
  faq,
  role,
  back,
  onAsk,
  headingRef,
}: {
  faq: HelpFaq
  role: string
  back: boolean
  onAsk: (() => void) | null
  headingRef: RefObject<HTMLHeadingElement | null>
}) {
  const { store } = useStoreContext()
  return (
    <article
      aria-labelledby={`ayuda-${faq.id}`}
      className="elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-5"
    >
      {back ? (
        <Link
          to="/tiendas/$id/ayuda"
          params={{ id: store.id }}
          className="inline-flex min-h-11 items-center gap-1 self-start rounded-md text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronLeft className="size-4" aria-hidden />
          Todas las preguntas
        </Link>
      ) : null}
      <h3
        id={`ayuda-${faq.id}`}
        ref={headingRef}
        tabIndex={-1}
        className="text-lg font-semibold leading-snug outline-none"
      >
        {faq.q}
      </h3>
      {faq.a.map((paragraph) => (
        <p key={paragraph} className="max-w-prose text-sm leading-relaxed">
          {paragraph}
        </p>
      ))}
      <p className="text-sm text-muted-foreground">
        {whoLine(faq)}
        {faq.you ? "" : ` Con tu rol (${role}) no se puede: pídeselo a quien sí puede.`}
      </p>
      <div className="flex flex-wrap gap-2 pt-1">
        {faq.screen ? (
          <Button
            variant={faq.you ? "default" : "outline"}
            render={<Link to={`/tiendas/${store.id}${faq.screen.path}`} />}
          >
            Ir a {faq.screen.label}
          </Button>
        ) : null}
        {onAsk ? (
          <Button variant="outline" onClick={onAsk}>
            ¿No era esto? Pedir ayuda
          </Button>
        ) : null}
      </div>
    </article>
  )
}

/** Lo que la persona preguntó al equipo de gestorIA, con sus respuestas. Solo lo suyo. */
function Questions({ questions }: { questions: HelpQuestion[] }) {
  return (
    <section aria-labelledby="ayuda-tus-preguntas" className="flex flex-col gap-3">
      <h2 id="ayuda-tus-preguntas" className="text-lg font-bold">
        Tus preguntas
      </h2>
      {questions.length === 0 ? (
        <EmptyState
          icon={MessageCircleQuestion}
          title="Todavía no preguntaste nada"
          description="Lo que le escribas al equipo de gestorIA con «Pedir ayuda» y sus respuestas aparecen aquí."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {questions.map((one) => (
            <li
              key={one.id ?? `${one.createdAt}-${one.question}`}
              className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="min-w-0 flex-1 basis-48 font-medium [overflow-wrap:anywhere]">
                  {one.question}
                </span>
                <Badge variant="outline">{questionStatus(one.status)}</Badge>
              </div>
              <span className="text-xs text-muted-foreground">{when(one.createdAt)}</span>
              {one.replies.map((reply, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: dos respuestas pueden tener la misma hora
                <div key={`${reply.at}-${i}`} className="rounded-md bg-muted/50 p-3">
                  <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{reply.body}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Equipo de gestorIA · {when(reply.at)}
                  </p>
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
