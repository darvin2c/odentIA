// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
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
    expect(
      screen.getByRole("tablist").querySelectorAll('[role="tab"]'),
    ).toHaveLength(3)
    fireEvent.click(darkTab)
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(localStorage.getItem("odentia-theme")).toBe("dark")
    expect(await screen.findByRole("menuitem", { name: "Cerrar sesión" })).toBeTruthy()
    localStorage.clear()
    document.documentElement.classList.remove("dark")
  })
})
