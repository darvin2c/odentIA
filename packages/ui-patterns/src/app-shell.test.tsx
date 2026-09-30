// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Link, Outlet, RouterProvider, useBlocker } from "@tanstack/react-router"
import { KeyRound, UserRound } from "lucide-react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AppShell } from "./app-shell.js"

afterEach(() => {
  cleanup()
  document.body.innerHTML = ""
})

function AnchorLink({
  to,
  search,
  children,
  ...rest
}: {
  to?: string
  search?: Record<string, string>
  children: ReactNode
  [key: string]: unknown
}) {
  return (
    <a href={search ? `${to}?${new URLSearchParams(search)}` : to} {...rest}>
      {children}
    </a>
  )
}
function shellWithMenu(onSignOut: () => void) {
  return render(
    <AppShell
      items={[]}
      LinkComponent={AnchorLink}
      pathname="/"
      user={{ name: "Ada", email: "ada@x.com" }}
      userMenuItems={[
        { label: "Mi perfil", icon: UserRound, to: "/profile" },
        {
          label: "Cambiar contraseña",
          icon: KeyRound,
          to: "/profile",
          search: { edit: "password" },
        },
      ]}
      onSignOut={onSignOut}
      brand={<span>odentIA</span>}
    >
      <p>contenido</p>
    </AppShell>,
  )
}

describe("AppShell userMenu", () => {
  it("renderiza los ítems con anchors reales y href correcto", async () => {
    shellWithMenu(() => {})
    fireEvent.click(screen.getByRole("button", { name: /Ada/ }))
    const profile = await screen.findByRole("menuitem", { name: "Mi perfil" })
    expect(profile.getAttribute("href")).toBe("/profile")
    const password = await screen.findByRole("menuitem", { name: "Cambiar contraseña" })
    expect(password.getAttribute("href")).toBe("/profile?edit=password")
    fireEvent.click(profile)
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Mi perfil" })).toBeNull())
  })

  it("click en Cerrar sesión llama onSignOut una vez", async () => {
    const onSignOut = vi.fn()
    shellWithMenu(onSignOut)
    fireEvent.click(screen.getByRole("button", { name: /Ada/ }))
    const signOut = await screen.findByRole("menuitem", { name: "Cerrar sesión" })
    fireEvent.click(signOut)
    expect(onSignOut).toHaveBeenCalledTimes(1)
  })

  it("el selector de tema aplica .dark y persiste sin cerrar el menú", async () => {
    localStorage.clear()
    document.documentElement.classList.remove("dark")
    shellWithMenu(() => {})
    fireEvent.click(screen.getByRole("button", { name: /Ada/ }))
    const darkTab = await screen.findByRole("tab", { name: "Tema oscuro" })
    expect(screen.getByText("Apariencia")).toBeTruthy()
    expect(screen.getByRole("tablist").querySelectorAll('[role="tab"]')).toHaveLength(3)
    fireEvent.click(darkTab)
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(localStorage.getItem("odentia-theme")).toBe("dark")
    expect(await screen.findByRole("menuitem", { name: "Cerrar sesión" })).toBeTruthy()
    localStorage.clear()
    document.documentElement.classList.remove("dark")
  })
})

describe("AppShell footerItems", () => {
  it("ancla los ítems encima del bloque de usuario y los marca activos por prefijo", () => {
    render(
      <AppShell
        items={[{ label: "Bandeja", icon: UserRound, to: "/inbox" }]}
        LinkComponent={AnchorLink}
        pathname="/settings/channels"
        user={{ name: "Ada", email: "ada@x.com" }}
        footerItems={[{ label: "Configuración", icon: KeyRound, to: "/settings" }]}
        onSignOut={() => {}}
        brand={<span>odentIA</span>}
      >
        <p>contenido</p>
      </AppShell>,
    )
    const item = screen.getByRole("link", { name: "Configuración" })
    expect(item.getAttribute("href")).toBe("/settings")
    // `/settings` cubre sus apartados: activo en `/settings/channels`.
    expect(item.getAttribute("aria-current")).toBe("page")
    const userButton = screen.getByRole("button", { name: /Ada/ })
    expect(item.compareDocumentPosition(userButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("sin footerItems no añade nada al pie", () => {
    render(
      <AppShell
        items={[]}
        LinkComponent={AnchorLink}
        pathname="/"
        user={{ name: "Ada", email: "ada@x.com" }}
        onSignOut={() => {}}
        brand={<span>odentIA</span>}
      >
        <p>contenido</p>
      </AppShell>,
    )
    expect(screen.queryByRole("link", { name: "Configuración" })).toBeNull()
  })
})

it("la navegación lateral permite cancelar la salida antes de perder cambios", async () => {
  function EditingPage() {
    const blocker = useBlocker({ shouldBlockFn: () => true, withResolver: true })
    return <>
      <p>Borrador del caso</p>
      {blocker.status === "blocked" && <div role="alert">
        Cambios sin guardar
        <button type="button" onClick={blocker.reset}>Continuar editando</button>
        <button type="button" onClick={blocker.proceed}>Descartar y salir</button>
      </div>}
    </>
  }
  const root = createRootRoute({
    component: () => <AppShell
      items={[{ label: "Destino", to: "/destino", icon: UserRound }]}
      LinkComponent={({ to, children, ...props }) => <Link to={to} {...props}>{children}</Link>}
      pathname="/"
      user={{ name: "Operadora", email: "operadora@example.test" }}
      onSignOut={() => {}}
    ><Outlet /></AppShell>,
  })
  const home = createRoute({ getParentRoute: () => root, path: "/", component: EditingPage })
  const destination = createRoute({
    getParentRoute: () => root, path: "/destino", component: () => <p>Caso cerrado</p>,
  })
  const router = createRouter({
    routeTree: root.addChildren([home, destination]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  render(<RouterProvider router={router} />)
  await screen.findByText("Borrador del caso")
  fireEvent.click(screen.getByRole("link", { name: "Destino" }))
  await screen.findByRole("alert")
  fireEvent.click(screen.getByRole("button", { name: "Continuar editando" }))
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
  expect(router.state.location.pathname).toBe("/")
  fireEvent.click(screen.getByRole("link", { name: "Destino" }))
  await screen.findByRole("alert")
  fireEvent.click(screen.getByRole("button", { name: "Descartar y salir" }))
  await screen.findByText("Caso cerrado")
  expect(router.state.location.pathname).toBe("/destino")
})
