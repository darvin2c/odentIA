/**
 * De qué app le hablan (A1 del lienzo «Una sola administración para todas las
 * apps»): el Grupo Sallca vende todas por el mismo WhatsApp, y cada conversación
 * dice su app y cómo se supo. Aquí, lo que Administración decide a mano:
 *
 * - «Cambiar la app» de una conversación sin cliente (`ChatAppChange`). Con
 *   cliente manda su ficha y no se ofrece.
 * - «Anuncios por atar» en Hoy (`AdsToTie`): el anuncio de Meta que abrió una
 *   conversación y nadie dijo de qué app es, con su título y su texto. Se ata una
 *   vez y desde ahí cada conversación que abra nace con esa app.
 *
 * El servidor decide quién puede (solo Administración) y qué app es válida.
 */
import { CLINICAL_PRODUCTS, type ClinicalProduct, productWords } from "@odentia/clinical"
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  toast,
} from "@odentia/ui"
import { submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import { z } from "zod"
import { api } from "../../lib/api"
import { type ChatApp, ChatAppMark, ProductDot } from "../product"

const enc = encodeURIComponent

/** Lo que es cada app, para elegirla sin saber su nombre: «latidIA · consultorio médico». */
const KIND: Record<ClinicalProduct, string> = {
  dental: "clínica dental",
  medical: "consultorio médico",
  optical: "óptica",
}

const post = (path: string, product: ClinicalProduct) =>
  api<unknown>(path, { method: "POST", body: JSON.stringify({ product }) })

/** Lo que cambia al elegir una app: la conversación, la Bandeja, Hoy y Kairós. */
function useInvalidateApps() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "inbox"] })
    void queryClient.invalidateQueries({ queryKey: ["admin", "chat"] })
    void queryClient.invalidateQueries({ queryKey: ["admin", "ads-to-tie"] })
    void queryClient.invalidateQueries({ queryKey: ["admin", "overview"] })
  }
}

/** El menú con las apps, cada una con lo que es. */
function AppMenu({
  label,
  current,
  disabled,
  onPick,
}: {
  label: string
  current: string | null
  disabled: boolean
  onPick: (product: ClinicalProduct) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            className="min-h-11 sm:min-h-8"
          >
            {label}
            <ChevronDown aria-hidden />
          </Button>
        }
      />
      <DropdownMenuContent align="start">
        {CLINICAL_PRODUCTS.map((product) => (
          <DropdownMenuItem
            key={product}
            disabled={product === current}
            onClick={() => onPick(product)}
          >
            <ProductDot product={product} />
            {productWords(product).name} · {KIND[product]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * La app de la conversación y, para Administración y sin cliente, «Elegir la app» o «Cambiar».
 * Kairós no cambia lo que elige una persona.
 */
export function ChatAppChange({
  chatId,
  app,
  hasClient,
  canChange,
}: {
  chatId: string
  app: ChatApp
  hasClient: boolean
  canChange: boolean
}) {
  const invalidate = useInvalidateApps()
  const change = useMutation({
    mutationFn: (product: ClinicalProduct) => post(`/api/admin/chats/${enc(chatId)}/app`, product),
    onSuccess: (_data, product) =>
      toast.success(
        `La conversación es de ${productWords(product).name}: Kairós sigue con esa app`,
      ),
    onError: (error) => toast.error(submitErrorMessage(error)),
    onSettled: invalidate,
  })
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <ChatAppMark app={app} />
      {canChange && !hasClient ? (
        <AppMenu
          label={app ? "Cambiar" : "Elegir la app"}
          current={app?.product ?? null}
          disabled={change.isPending}
          onPick={(product) => change.mutate(product)}
        />
      ) : null}
    </span>
  )
}

const adsSchema = z.array(
  z.object({
    id: z.string(),
    sourceId: z.string(),
    headline: z.string().nullable(),
    body: z.string().nullable(),
    sourceUrl: z.string().nullable(),
    firstSeenAt: z.string(),
    waiting: z.number().int().nonnegative(),
  }),
)

/** Los dominios de Meta, los únicos a los que lleva «Ver el anuncio». */
const META_HOSTS = ["fb.me", "facebook.com", "fb.com", "instagram.com", "whatsapp.com"]

/** Solo un enlace https a Meta se abre: lo que llega en el aviso no se sigue a ciegas. */
function safeHref(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    const meta = META_HOSTS.some((own) => host === own || host.endsWith(`.${own}`))
    return url.protocol === "https:" && meta ? url.toString() : null
  } catch {
    return null
  }
}

/** «Anuncios por atar» en Hoy: sin ninguno, no ocupa lugar. Solo Administración. */
export function AdsToTie() {
  const ads = useQuery({
    queryKey: ["admin", "ads-to-tie"],
    queryFn: async () => adsSchema.parse(await api<unknown>("/api/admin/chats/ads/to-tie")),
    staleTime: 30_000,
  })
  const invalidate = useInvalidateApps()
  const tie = useMutation({
    mutationFn: ({ adId, product }: { adId: string; product: ClinicalProduct }) =>
      post(`/api/admin/chats/ads/${enc(adId)}/app`, product),
    onSuccess: (data, { product }) => {
      const chats = z.object({ chats: z.number() }).safeParse(data).data?.chats ?? 0
      toast.success(
        `Anuncio atado a ${productWords(product).name}${chats ? `: ${chats === 1 ? "su conversación pasó" : `sus ${chats} conversaciones pasaron`} a esa app` : ""}`,
      )
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
    onSettled: invalidate,
  })
  const rows = ads.data ?? []
  if (rows.length === 0) return null
  return (
    <section aria-labelledby="hoy-anuncios" className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="hoy-anuncios" className="text-base font-semibold">
          Anuncios por atar
        </h2>
        <span className="text-sm text-muted-foreground tabular-nums">{rows.length}</span>
        <p className="w-full text-sm text-muted-foreground">
          Llegaron conversaciones desde estos anuncios. Di de qué app es cada uno: se recuerda para
          las que vengan.
        </p>
      </div>
      <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
        {rows.map((ad) => {
          const href = safeHref(ad.sourceUrl)
          return (
            <li key={ad.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
              <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
                <p className="text-sm font-medium break-words">
                  {ad.headline ?? `Anuncio ${ad.sourceId}`}
                </p>
                {ad.body ? (
                  <p className="line-clamp-2 text-sm text-muted-foreground">{ad.body}</p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  {ad.waiting === 1
                    ? "1 conversación espera su app"
                    : ad.waiting > 1
                      ? `${ad.waiting} conversaciones esperan su app`
                      : "Sin conversaciones esperando"}
                  {href ? (
                    <>
                      {" · "}
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline-offset-4 hover:underline"
                      >
                        Ver el anuncio
                      </a>
                    </>
                  ) : null}
                </p>
              </div>
              <AppMenu
                label="¿De qué app es?"
                current={null}
                disabled={tie.isPending}
                onPick={(product) => tie.mutate({ adId: ad.id, product })}
              />
            </li>
          )
        })}
      </ul>
    </section>
  )
}
