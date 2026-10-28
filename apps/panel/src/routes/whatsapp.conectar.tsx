import { Button } from "@odentia/ui"
import { AuthAside, AuthSplit, LoadingState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useState } from "react"
import {
  accountWords,
  FacebookSignup,
  type FacebookSignupConfig,
  type FacebookSignupConnection,
} from "../components/whatsapp/facebook-signup"
import { accountOrganizationsQuery } from "../lib/account-organizations"
import { ApiError, apiFetch } from "../lib/api"
import { AuthAlert, AuthLegal } from "../lib/auth-screens"
import { requireTermsAccepted, requireVerifiedSession } from "../lib/guards"
import { panelUrl, tenantUrl } from "../lib/host"

const SLUG = /^[a-z0-9-]{1,63}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * «Conectar con Facebook» de WhatsApp, siempre desde el panel (issue 166): la
 * clínica envía aquí (`?org=<slug>`, y `&reconectar=<id>` para volver a
 * conectar) y, al terminar, se vuelve a su página de WhatsApp. La dirección
 * solo dice qué clínica se quiere: la API comprueba que quien conecta es
 * miembro y administra su configuración.
 */
export const Route = createFileRoute("/whatsapp/conectar")({
  ssr: false,
  beforeLoad: async ({ location }) => {
    // Sin sesión, entrar vuelve a esta misma página.
    await requireVerifiedSession(panelUrl(location.href))
    await requireTermsAccepted(location)
  },
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.org === "string" && SLUG.test(search.org) ? { org: search.org } : {}),
    ...(typeof search.reconectar === "string" && UUID.test(search.reconectar)
      ? { reconectar: search.reconectar }
      : {}),
  }),
  component: WhatsAppConnectPage,
})

interface SignupConfig {
  enabled: boolean
  appId: string | null
  configId: string | null
  graphVersion: string | null
}

/** La página de WhatsApp de la clínica; `conectado` le dice que muestre lo que se acaba de conectar. */
const whatsappPage = (clinic: { slug: string; product: string }, connectedId?: string) =>
  tenantUrl(
    clinic.slug,
    `/settings/integrations/whatsapp${connectedId ? `?conectado=${encodeURIComponent(connectedId)}` : ""}`,
    clinic.product,
  )

function WhatsAppConnectPage() {
  const { org, reconectar } = Route.useSearch()
  const organizations = useQuery(accountOrganizationsQuery)
  const clinic = org ? organizations.data?.find((item) => item.slug === org) : undefined
  const config = useQuery({
    queryKey: ["whatsapp-signup", org],
    queryFn: () =>
      apiFetch<{ data: SignupConfig }>("/api/channels/whatsapp/signup", {
        headers: { "x-odentia-org": org ?? "" },
      }),
    enabled: Boolean(clinic),
    retry: false,
  })
  const [connected, setConnected] = useState<FacebookSignupConnection | null>(null)

  const title = clinic ? `Conectar el WhatsApp de ${clinic.organizationName}` : "Conectar WhatsApp"
  const aside = (
    <AuthAside
      tag="WhatsApp"
      title={clinic?.organizationName ?? "Tu clínica"}
      accent="conecta su número."
    />
  )
  // Un nombre largo pasa a la línea siguiente en vez de salirse de la tarjeta.
  const back = clinic ? (
    <Button
      variant="ghost"
      className="h-auto min-h-11 whitespace-normal text-left sm:min-h-9"
      render={<a href={whatsappPage(clinic)} />}
    >
      Volver a {clinic.organizationName}
    </Button>
  ) : null

  if (organizations.isPending || (clinic && config.isPending)) {
    return (
      <AuthSplit title={title} aside={aside} legal={<AuthLegal />}>
        <LoadingState message="Cargando…" />
      </AuthSplit>
    )
  }

  // No se dice si la clínica existe: solo que no es de quien entró.
  if (!clinic) {
    return (
      <AuthSplit title="Conectar WhatsApp" aside={aside} legal={<AuthLegal />}>
        {organizations.isError ? (
          <AuthAlert>No pudimos cargar tus clínicas. Recarga la página.</AuthAlert>
        ) : (
          <>
            <AuthAlert>No encontramos esa clínica entre las tuyas.</AuthAlert>
            <p className="text-sm text-muted-foreground">
              Entra a tu clínica y pulsa «Conectar con Facebook» desde Configuración › Integraciones
              › WhatsApp.
            </p>
            <Button
              variant="outline"
              className="min-h-11 self-start sm:min-h-9"
              render={<Link to="/" />}
            >
              Ir a mis organizaciones
            </Button>
          </>
        )}
      </AuthSplit>
    )
  }

  const forbidden = config.error instanceof ApiError && config.error.status === 403
  const data = config.data?.data
  const ready: FacebookSignupConfig | null =
    data?.enabled && data.appId && data.configId && data.graphVersion
      ? { appId: data.appId, configId: data.configId, graphVersion: data.graphVersion }
      : null

  return (
    <AuthSplit title={title} aside={aside} legal={<AuthLegal />} footer={back}>
      {forbidden ? (
        <AuthAlert>
          No puedes conectar el WhatsApp de {clinic.organizationName}. Lo hace quien administra la
          clínica.
        </AuthAlert>
      ) : config.isError ? (
        <>
          <AuthAlert>
            No pudimos preparar la conexión. Comprueba tu conexión y vuelve a intentarlo.
          </AuthAlert>
          <Button
            variant="outline"
            className="min-h-11 self-start sm:min-h-9"
            onClick={() => void config.refetch()}
          >
            Reintentar
          </Button>
        </>
      ) : !ready ? (
        <AuthAlert>
          «Conectar con Facebook» no está disponible en esta instalación. Vuelve a{" "}
          {clinic.organizationName} y conecta WhatsApp con los datos de la app de Meta de la
          clínica.
        </AuthAlert>
      ) : connected ? (
        <p role="status" className="text-sm font-medium text-success">
          {reconectar ? "Conectado de nuevo" : "Conectado"}: {accountWords(connected)}. Volviendo a{" "}
          {clinic.organizationName}…
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Entras con el Facebook de quien administra la clínica, eliges el número y vuelves a{" "}
            {clinic.organizationName} con él conectado. Ten a mano el teléfono de ese número.
          </p>
          <FacebookSignup
            slug={clinic.slug}
            config={ready}
            {...(reconectar ? { reconnectConnectionId: reconectar } : {})}
            onConnected={(connection) => {
              setConnected(connection)
              window.location.assign(whatsappPage(clinic, connection.id))
            }}
          />
        </>
      )}
    </AuthSplit>
  )
}
