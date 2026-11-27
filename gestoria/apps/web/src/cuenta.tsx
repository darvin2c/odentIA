import { Button } from "@odentia/ui"
import {
  AccountProfilePage,
  AccountProvider,
  AccountSupportPage,
  CLOSE_ACCOUNT_BLOCKER_ID,
  ErrorState,
  isAccountProfileEdit,
  LoadingState,
  PageNotice,
} from "@odentia/ui-patterns"
import { useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import { ChevronLeft } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import type { Me, MyStore } from "./lib/api"
import { ACCOUNT_API, authClient, forgetToken, forgetUser, safeNext } from "./lib/cuenta"
import { Shell, useMe } from "./tiendas"

/**
 * La cuenta dentro de gestorIA (lienzo «Una cuenta, todas las apps», decisión 7; ADR 0218): las
 * mismas pantallas del panel de las clínicas, Mi perfil y Soporte de la cuenta, en gestoria24.com
 * y con su marca. Hablan con la cuenta en su dominio (`api.gestoria24.com`), que ahí solo
 * responde lo de la persona.
 */

/** Las rutas de la cuenta en gestorIA. */
export const PROFILE_PATH = "/cuenta"
export const SUPPORT_PATH = "/cuenta/soporte"

/** La tienda desde la que se llegó (`?tienda=<id>`), para volver a ella; se recuerda en la pestaña. */
const DESDE_KEY = "gestoria.cuenta.desde-tienda"

function useStoreOfOrigin(me: Me | undefined): MyStore | null {
  const { tienda } = useSearch({ strict: false }) as { tienda?: string }
  const [id, setId] = useState<string | null>(tienda || null)
  useEffect(() => {
    try {
      // Llegó desde una tienda: se recuerda; desde fuera de una (`tienda` vacía), se olvida.
      if (tienda) window.sessionStorage.setItem(DESDE_KEY, tienda)
      else if (tienda === "") window.sessionStorage.removeItem(DESDE_KEY)
      setId(tienda === undefined ? window.sessionStorage.getItem(DESDE_KEY) : tienda || null)
    } catch {
      setId(tienda || null)
    }
  }, [tienda])
  return me?.stores.find((s) => s.id === id) ?? null
}

/** «← <la tienda>»: vuelve a la tienda desde la que se abrió la cuenta. */
function BackToStore({ store }: { store: MyStore | null }) {
  if (!store) return null
  return (
    <Link
      to="/tiendas/$id"
      params={{ id: store.id }}
      className="inline-flex min-h-11 items-center gap-1 self-start rounded-md text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9"
    >
      <ChevronLeft className="size-4" aria-hidden />
      {store.name}
    </Link>
  )
}

/** Lo que gestorIA le pasa a las pantallas de la cuenta: su cliente, su API y su marca. */
function GestoriaAccount({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  return (
    <AccountProvider
      value={{
        client: authClient,
        apiUrl: ACCOUNT_API,
        appName: "gestorIA",
        profilePath: PROFILE_PATH,
        emailExample: "nombre@tienda.com",
        twoFactorSelf: "Nadie: la activaste tú",
        // El nombre y la foto llegan a gestorIA con el token: se pide otro y se pone al día.
        onPersonChanged: () => {
          forgetToken()
          void queryClient.invalidateQueries({ queryKey: ["yo"] })
        },
      }}
    >
      {children}
    </AccountProvider>
  )
}

/** Mientras se sabe quién es: el aviso a la vista. Si no se pudo, el error con «Reintentar». */
function AccountFrame({ children }: { children: (me: Me) => ReactNode }) {
  const me = useMe()
  if (me.isPending)
    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas p-4">
        <LoadingState
          kind="indeterminate"
          message="Abriendo tu cuenta…"
          className="w-full max-w-sm"
        />
      </div>
    )
  if (me.isError)
    return (
      <div className="mx-auto max-w-md p-6">
        <ErrorState
          error={me.error instanceof Error ? me.error : "No se pudo abrir tu cuenta"}
          onRetry={() => void me.refetch()}
        />
      </div>
    )
  return (
    <Shell me={me.data} bare>
      <GestoriaAccount>{children(me.data)}</GestoriaAccount>
    </Shell>
  )
}

/** Cierra la sesión de este navegador y lleva a la entrada; la entrada olvida a quien cerró su cuenta. */
async function leaveClosedAccount() {
  forgetToken()
  forgetUser()
  await authClient.signOut().catch(() => undefined)
  window.location.assign("/login")
}

/**
 * Antes de cerrar la cuenta: las tiendas donde es la única persona con el rol de Dueño (lo sabe
 * el servidor de gestorIA). Hay que darle ese rol a otra persona del equipo primero.
 */
function OnlyOwnerBlocker({ stores }: { stores: MyStore[] }) {
  if (stores.length === 0) return null
  const names = stores.map((s) => s.name)
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} y ${names.at(-1)}`
  return (
    <div id={CLOSE_ACCOUNT_BLOCKER_ID}>
      <PageNotice
        tone="alarma"
        label="Antes"
        action={
          <span className="flex flex-wrap gap-2">
            {stores.map((s) => (
              <Button
                key={s.id}
                variant="outline"
                size="sm"
                render={<Link to="/tiendas/$id/configuracion/equipo" params={{ id: s.id }} />}
              >
                {stores.length === 1 ? "Ir al equipo" : `Equipo de ${s.name}`}
              </Button>
            ))}
          </span>
        }
      >
        Eres la única persona con el rol de Dueño en <strong>{list}</strong>. Antes de cerrar tu
        cuenta, dale ese rol a otra persona del equipo: sin Dueño, nadie podría cambiar el plan.
      </PageNotice>
    </div>
  )
}

/** Mi perfil en gestorIA: nombre y foto, contraseña, dos pasos, sesiones, soporte y cerrar la cuenta. */
export function ProfilePage() {
  const search = useSearch({ strict: false }) as { edit?: string; next?: string }
  const navigate = useNavigate()
  return (
    <AccountFrame>
      {(me) => (
        <Profile
          me={me}
          edit={search.edit}
          next={search.next}
          onCloseEdit={() => void navigate({ to: PROFILE_PATH, search: {}, replace: true })}
        />
      )}
    </AccountFrame>
  )
}

function Profile({
  me,
  edit,
  next,
  onCloseEdit,
}: {
  me: Me
  edit?: string
  next?: string
  onCloseEdit: () => void
}) {
  const origin = useStoreOfOrigin(me)
  const onlyOwnerOf = me.stores.filter((s) => s.onlyOwner)
  return (
    <AccountProfilePage
      edit={isAccountProfileEdit(edit) ? edit : undefined}
      onCloseEdit={onCloseEdit}
      onTwoFactorActivated={() => {
        const back = safeNext(next)
        if (back) window.location.assign(back)
        else onCloseEdit()
      }}
      fallbackUser={{
        name: me.person.name,
        firstName: "",
        lastName: "",
        email: me.person.email,
        image: null,
      }}
      back={<BackToStore store={origin} />}
      profileDescription="Tu información personal en tu cuenta: es la misma en todas tus apps."
      close={{
        description:
          "Sales de tus tiendas y de todas tus apps, y se bloquea tu acceso. Lo que hiciste conserva tu nombre en cada tienda.",
        confirm:
          "Perderás el acceso a tus tiendas y a todas tus apps. Esta acción bloquea tu cuenta de inmediato.",
        blocker: onlyOwnerOf.length > 0 ? <OnlyOwnerBlocker stores={onlyOwnerOf} /> : undefined,
        onClosed: leaveClosedAccount,
      }}
    >
      <div className="flex flex-col gap-4 elevated rounded-xl border bg-card p-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1.5">
          <div className="font-heading text-base font-medium">Soporte de tu cuenta</div>
          <p className="text-sm text-muted-foreground">
            ¿Un problema con tu cuenta, tu contraseña o tu código? Escríbenos aquí.
          </p>
        </div>
        <Button
          variant="outline"
          className="self-start sm:self-center"
          render={<Link to={SUPPORT_PATH} />}
        >
          Abrir soporte
        </Button>
      </div>
    </AccountProfilePage>
  )
}

/** Soporte de la cuenta en gestorIA: pedir ayuda con la cuenta y seguir sus casos. */
export function AccountSupportRoute() {
  const { caso } = useSearch({ strict: false }) as { caso?: string }
  return <AccountFrame>{(me) => <Support me={me} caso={caso} />}</AccountFrame>
}

function Support({ me, caso }: { me: Me; caso?: string }) {
  const origin = useStoreOfOrigin(me)
  return (
    <AccountSupportPage
      linkedCase={caso ?? null}
      back={
        <div className="flex flex-wrap items-center gap-x-4">
          <BackToStore store={origin} />
          <Link
            to={PROFILE_PATH}
            className="inline-flex min-h-11 items-center gap-1 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9"
          >
            <ChevronLeft className="size-4" aria-hidden />
            Mi perfil
          </Link>
        </div>
      }
      intro={{
        title: "¿Un problema con tu cuenta?",
        description:
          "Cuéntalo aquí: entrar, tu contraseña, tu código o tu correo. Solo te pedimos lo necesario para ayudarte.",
        questionPlaceholder: "Describe qué pasa con tu cuenta…",
        detailPlaceholder: "Código de error, correo…",
      }}
    />
  )
}
