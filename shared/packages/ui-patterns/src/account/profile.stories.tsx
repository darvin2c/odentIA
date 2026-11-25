import type { Meta, StoryObj } from "@storybook/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"
import { type ReactNode, useMemo } from "react"
import { PageNotice } from "../page-notice.js"
import { type AccountClient, AccountProvider } from "./context.js"
import { AccountProfilePage } from "./profile.js"
import { TWO_FACTOR_KEY } from "./two-factor.js"

/** Un cliente de la cuenta de mentira: responde sin red. */
const ok = async () => ({ data: null, error: null })
const client: AccountClient = {
  useSession: () => ({
    data: {
      user: {
        name: "Rosa Quispe",
        firstName: "Rosa",
        lastName: "Quispe",
        email: "rosa@calzados.pe",
        image: null,
      },
      session: { token: "t-actual" },
    },
  }),
  updateUser: ok,
  changePassword: ok,
  changeEmail: ok,
  listSessions: ok,
  revokeSession: ok,
  revokeOtherSessions: ok,
  twoFactor: {
    enable: async () => ({
      data: {
        method: "totp" as const,
        totpURI: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP",
        backupCodes: [],
      },
      error: null,
    }),
    verifyTotp: ok,
    getTotpUri: async () => ({
      data: { totpURI: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP" },
      error: null,
    }),
    generateBackupCodes: async () => ({ data: { backupCodes: [] }, error: null }),
    disable: ok,
  },
}

/** La cuenta con lo que ya trajo del servidor: dos pasos activos y dos sesiones. */
function Stage({ app, children }: { app: "gestoria" | "odentia"; children: ReactNode }) {
  const queryClient = useMemo(() => {
    const qc = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
    })
    qc.setQueryData(TWO_FACTOR_KEY, {
      enabled: true,
      staff: false,
      hasPassword: true,
      requiredBy: [],
      trustedBrowsers: 1,
    })
    qc.setQueryData(
      ["sessions"],
      [
        {
          token: "t-actual",
          userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0",
          ipAddress: "190.42.1.10",
          updatedAt: new Date(),
        },
        {
          token: "t-otra",
          userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Version/18.0 Safari/604.1",
          ipAddress: "190.42.1.11",
          updatedAt: new Date(Date.now() - 86_400_000),
        },
      ],
    )
    return qc
  }, [])
  const router = useMemo(() => {
    const rootRoute = createRootRoute({ component: Outlet })
    const route = createRoute({
      getParentRoute: () => rootRoute,
      path: "/cuenta",
      component: () => children,
    })
    return createRouter({
      routeTree: rootRoute.addChildren([route]),
      history: createMemoryHistory({ initialEntries: ["/cuenta"] }),
    })
  }, [children])
  return (
    <QueryClientProvider client={queryClient}>
      <AccountProvider
        value={{
          client,
          apiUrl: "",
          appName: app === "gestoria" ? "gestorIA" : "odentIA",
          profilePath: "/cuenta",
          emailExample: "nombre@tienda.com",
          twoFactorSelf: "Nadie: la activaste tú",
        }}
      >
        <RouterProvider router={router} />
      </AccountProvider>
    </QueryClientProvider>
  )
}

const meta = {
  title: "Patrones/Cuenta/Mi perfil",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

/** gestorIA: la única Dueña de una tienda no puede cerrar su cuenta hasta dar el rol a otra persona. */
export const GestoriaUnicaDuena: Story = {
  render: () => (
    <Stage app="gestoria">
      <AccountProfilePage
        onCloseEdit={() => undefined}
        profileDescription="Tu información personal en tu cuenta: es la misma en todas tus apps."
        close={{
          description: "Sales de tus tiendas y de todas tus apps, y se bloquea tu acceso.",
          confirm: "Perderás el acceso a tus tiendas y a todas tus apps.",
          blocker: (
            <PageNotice tone="alarma" label="Antes">
              Eres la única persona con el rol de Dueño en <strong>Calzados Rosa</strong>.
            </PageNotice>
          ),
          onClosed: () => undefined,
        }}
      />
    </Stage>
  ),
}

/** El panel de las clínicas: lo suyo (sus clínicas) entra como `children`. */
export const Panel: Story = {
  render: () => (
    <Stage app="odentia">
      <AccountProfilePage
        onCloseEdit={() => undefined}
        profileDescription="Tu información personal en odentIA."
        close={{
          description: "Sales de tus clínicas y se bloquea tu acceso.",
          confirm: "Perderás el acceso a tus clínicas.",
          onClosed: () => undefined,
        }}
      >
        <div className="elevated rounded-xl border bg-card p-6 text-sm">
          Mis clínicas (lo propio del panel)
        </div>
      </AccountProfilePage>
    </Stage>
  ),
}
