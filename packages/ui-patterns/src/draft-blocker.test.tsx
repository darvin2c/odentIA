// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router"
import type * as React from "react"
import { afterEach, beforeAll, expect, it } from "vitest"

import { useDraftBlocker } from "./draft-blocker.js"
import { FormDrawer } from "./form/form-drawer.js"
import { DraftKeptInPage, SideDockProvider, SideDockSlot } from "./side-dock.js"

beforeAll(() => {
  if (!window.ResizeObserver) {
    window.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof window.ResizeObserver
  }
  // El área con scroll del formulario mira sus animaciones; jsdom no las trae.
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => []
  // Ventana ancha: el formulario se abre en la columna del layout, que es la que avisa al navegar.
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ""
})

/** El aviso de la app, como `PageDraftGuard` de clinic-app. */
function Guard({ dirty, keptInPage }: { dirty: boolean; keptInPage?: boolean }) {
  const blocker = useDraftBlocker({ disabled: !dirty, enableBeforeUnload: false, shouldBlockFn: () => dirty, keptInPage })
  if (blocker.status !== "blocked") return null
  return (
    <div role="alertdialog">
      Si sales, se perderán
      <button type="button" onClick={blocker.reset}>
        Continuar editando
      </button>
      <button type="button" onClick={blocker.proceed}>
        Descartar y salir
      </button>
    </div>
  )
}

/** La app con la columna del layout y su aviso; cada ruta, `[ruta, pantalla]`. */
function appWith(pages: Array<[string, () => React.ReactNode]>, at: string) {
  const root = createRootRoute({
    component: () => (
      <SideDockProvider draftGuard={Guard}>
        <Outlet />
        <SideDockSlot />
      </SideDockProvider>
    ),
  })
  const routes = pages.map(([path, component]) => createRoute({ getParentRoute: () => root, path, component }))
  return createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: [at] }) })
}

const form = (title: string, field: string): React.ReactNode => (
  <FormDrawer open title={title} onClose={() => {}} onSubmit={() => {}}>
    <input aria-label={field} />
  </FormDrawer>
)

// QA del 8 nov (bajo #5): en Finanzas › Gastos, con un gasto a medias, tocar «Caja» preguntaba
// «Si sales, se perderán» aunque el cajón sigue abierto en Caja con lo escrito.
it("con la pantalla que conserva sus cajones, cambiar de pestaña no pregunta y salir a otra ruta sí", async () => {
  const router = appWith(
    [
      ["/finance", () => <DraftKeptInPage>{form("Registrar gasto", "Concepto")}</DraftKeptInPage>],
      ["/reports", () => <p>Reportes</p>],
    ],
    "/finance?tab=gastos",
  )
  render(<RouterProvider router={router} />)
  fireEvent.input(await screen.findByLabelText("Concepto"), { target: { value: "Guantes" } })

  await router.navigate({ href: "/finance?tab=caja" })
  await waitFor(() => expect(router.state.location.searchStr).toBe("?tab=caja"))
  expect(screen.queryByRole("alertdialog")).toBeNull()
  expect((screen.getByLabelText("Concepto") as HTMLInputElement).value).toBe("Guantes")

  void router.navigate({ href: "/reports" })
  await screen.findByRole("alertdialog")
  expect(router.state.location.pathname).toBe("/finance")
  fireEvent.click(screen.getByRole("button", { name: "Descartar y salir" }))
  await screen.findByText("Reportes")
})

it("sin eso, cualquier navegación con lo escrito pregunta, como hasta ahora", async () => {
  const router = appWith([["/page", () => form("Editar", "Nombre")]], "/page")
  render(<RouterProvider router={router} />)
  fireEvent.input(await screen.findByLabelText("Nombre"), { target: { value: "Ana" } })
  void router.navigate({ href: "/page?tab=otra" })
  await screen.findByRole("alertdialog")
  expect(router.state.location.searchStr).toBe("")
})
