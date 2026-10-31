// @vitest-environment jsdom
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router"
import { render, screen } from "@testing-library/react"
import { expect, it } from "vitest"
import { RouteErrorScreen } from "./route-error-screen.js"

it("si una pantalla no carga, lo dice en español y sin el error técnico", async () => {
  const root = createRootRoute({ component: Outlet })
  const home = createRoute({
    getParentRoute: () => root,
    path: "/",
    beforeLoad: () => {
      throw new Error("fetch failed")
    },
    component: () => <p>Bandeja</p>,
  })
  const router = createRouter({
    routeTree: root.addChildren([home]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultErrorComponent: RouteErrorScreen,
  })
  render(<RouterProvider router={router} />)
  expect(await screen.findByText("No se pudo abrir esta página")).toBeTruthy()
  expect(screen.getByRole("button", { name: "Reintentar" })).toBeTruthy()
  expect(screen.queryByText(/fetch failed/)).toBeNull()
  expect(screen.queryByText("Something went wrong!")).toBeNull()
})
