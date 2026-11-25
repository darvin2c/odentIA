// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { groupPlaces, type Place, PlaceSwitcher } from "./place-switcher.js"

afterEach(() => {
  cleanup()
  document.body.innerHTML = ""
})

const dental: Place = {
  id: "1",
  name: "Dental Smile",
  brand: "odentia",
  role: "Recepción",
  href: "https://dental-smile.odentia.test/home",
}
const sonrisa: Place = {
  id: "2",
  name: "Sonrisa Norte",
  brand: "odentia",
  role: "Odontólogo",
  href: "https://sonrisa.odentia.test/home",
}
const pediatria: Place = {
  id: "3",
  name: "Pediatría Los Olivos",
  brand: "latidia",
  role: "Recepción",
  href: "https://olivos.latidia.test/home",
}
const tienda: Place = {
  id: "4",
  name: "Rosita Moda",
  brand: "gestoria",
  role: "Dueña",
  href: "https://app.gestoria.test/tiendas/rosita",
}

function open() {
  fireEvent.click(screen.getByRole("button", { name: /Menú de la clínica$/ }))
}

describe("PlaceSwitcher", () => {
  it("el botón dice el lugar, qué es y el rol, también para el lector de pantalla", () => {
    render(<PlaceSwitcher current={dental} places={[dental]} menuLabel="Menú de la clínica" />)
    const button = screen.getByRole("button", {
      name: "Dental Smile, Clínica dental, Recepción. Menú de la clínica",
    })
    expect(within(button).getByText("Clínica dental · Recepción")).toBeTruthy()
  })

  it("con lugares de un solo tipo, una lista simple de enlaces sin grupos", async () => {
    render(
      <PlaceSwitcher current={dental} places={[dental, sonrisa]} menuLabel="Menú de la clínica" />,
    )
    open()
    const other = await screen.findByRole("menuitem", { name: "Sonrisa Norte, Odontólogo" })
    expect(other.tagName).toBe("A")
    expect(other.getAttribute("href")).toBe(sonrisa.href)
    const here = screen.getByRole("menuitem", { name: "Dental Smile, Recepción, lugar actual" })
    expect(here.getAttribute("aria-current")).toBe("true")
    // Tocar el lugar actual solo cierra el menú: no recarga la página.
    expect(here.tagName).not.toBe("A")
    expect(screen.queryByText(/Clínicas dentales · odentIA/)).toBeNull()
  })

  it("con lugares de más de un tipo, grupos con su nombre en palabras, el del lugar actual primero", async () => {
    render(
      <PlaceSwitcher
        current={pediatria}
        places={[dental, pediatria, tienda]}
        menuLabel="Menú de la clínica"
      />,
    )
    open()
    const groups = await screen.findAllByRole("group")
    expect(
      groups.map(
        (group) =>
          group.getAttribute("aria-labelledby") &&
          document.getElementById(group.getAttribute("aria-labelledby") ?? "")?.textContent,
      ),
    ).toEqual([
      "Consultorios médicos · latidIA",
      "Clínicas dentales · odentIA",
      "Tiendas · gestorIA",
    ])
    expect(
      within(groups[2] as HTMLElement)
        .getByRole("menuitem", { name: "Rosita Moda, Tienda, Dueña" })
        .getAttribute("href"),
    ).toBe(tienda.href)
  })

  it("sin otro lugar adonde ir no hay lista; las acciones del lugar van arriba con su aviso", async () => {
    const onSelect = vi.fn()
    render(
      <PlaceSwitcher
        current={dental}
        places={[dental]}
        alert={{ label: "Pago pendiente", tone: "warning" }}
        actions={[
          { label: "Plan y pagos", onSelect, badge: { label: "Pago pendiente", tone: "warning" } },
        ]}
        footerActions={[
          { label: "Cambiar de clínica", href: "https://app.odentia.test/?cambiar=1" },
        ]}
        menuLabel="Menú de la clínica"
      />,
    )
    expect(
      screen.getByRole("button", { name: /, Pago pendiente\. Menú de la clínica$/ }),
    ).toBeTruthy()
    open()
    const items = await screen.findAllByRole("menuitem")
    expect(items.map((item) => item.textContent)).toEqual([
      "Plan y pagos, Pago pendiente",
      "Cambiar de clínica",
    ])
    expect(items[1]?.getAttribute("href")).toBe("https://app.odentia.test/?cambiar=1")
    fireEvent.click(items[0] as HTMLElement)
    expect(onSelect).toHaveBeenCalledOnce()
  })
})

describe("groupPlaces", () => {
  it("agrupa por app, con la del lugar actual primero y las demás en el orden de las marcas", () => {
    expect(
      groupPlaces([tienda, dental, pediatria, sonrisa], "gestoria").map((group) => [
        group.brand,
        group.places.map((place) => place.id),
      ]),
    ).toEqual([
      ["gestoria", ["4"]],
      ["odentia", ["1", "2"]],
      ["latidia", ["3"]],
    ])
  })
})
