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
import { HelpButton, type HelpButtonProps } from "./help-button.js"
import type { HelpReply } from "./help-reply.js"

/** Lo que responde un servidor de la Ayuda, sin red: la pantalla y una respuesta de la guía. */
function fakeServer(
  where: string,
  answer: string,
  suggestions: string[],
): HelpButtonProps["fetcher"] {
  return async (path) => {
    if (path.includes("/screen")) {
      return {
        data: {
          title: where,
          suggestions,
          attached: { screen: where, role: "Dueño", clinic: "Calzados Rosa", version: null },
        },
      }
    }
    if (path.endsWith("/ask")) {
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, 900)
      await promise
      const reply: HelpReply = {
        askId: "a1",
        kind: "guia",
        say: null,
        written: null,
        answers: [{ topicId: "t", where, text: answer, path: "/", restriction: null }],
        blockers: [],
        choices: [],
        argos: false,
        argosNote: null,
        basedOn: `La guía: ${where}.`,
      }
      return { data: reply }
    }
    return { data: null }
  }
}

function Stage({ children }: { children: ReactNode }) {
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    [],
  )
  const router = useMemo(() => {
    const rootRoute = createRootRoute({ component: Outlet })
    const route = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <div className="flex justify-end p-4">{children}</div>,
    })
    return createRouter({
      routeTree: rootRoute.addChildren([route]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    })
  }, [children])
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

const meta = {
  title: "Patrones/Ayuda",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const common = { unseen: 0, supportMode: false, renderCases: () => null } as const

/** La misma Ayuda en gestorIA: cambian su nombre, a quiénes atiende y su guía. */
export const Gestoria: Story = {
  render: () => (
    <Stage>
      <HelpButton
        {...common}
        appName="gestorIA"
        peopleWord="clientes"
        placeWord="tienda"
        apiBase="/ayuda"
        fetcher={fakeServer(
          "Catálogo",
          "En el producto, «Precio y negociación»: pon el precio mínimo de venta. Sofi nunca baja de ahí y lo que cede queda escrito en el pedido.",
          ["¿Cómo subo un producto con tallas y stock?", "¿Cómo dejo que Sofi negocie el precio?"],
        )}
      />
    </Stage>
  ),
}

/** En odentIA, con una respuesta de soporte sin leer. */
export const Odentia: Story = {
  render: () => (
    <Stage>
      <HelpButton
        {...common}
        unseen={1}
        appName="odentIA"
        peopleWord="pacientes"
        placeWord="clínica"
        apiBase="/api/help"
        fetcher={fakeServer(
          "Agenda",
          "Abre la cita y pulsa «Cancelar cita»: eliges el motivo y, si hace falta, dejas una nota.",
          ["¿Cómo bloqueo un horario?", "¿Cómo muevo una cita a otro día?"],
        )}
      />
    </Stage>
  ),
}
