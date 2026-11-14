// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router"
import * as React from "react"
import { afterEach, beforeAll, expect, it } from "vitest"

import { DetailDrawer } from "./detail/detail-drawer.js"
import { useDraftSaved } from "./docked-surface.js"
import { type KeptInPage, useDraftBlocker } from "./draft-blocker.js"
import { FormDrawer } from "./form/form-drawer.js"
import { RadioChips } from "./radio-chips.js"
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
function Guard({ dirty, keptInPage }: { dirty: boolean; keptInPage?: KeptInPage | null }) {
  const blocker = useDraftBlocker({ disabled: !dirty, enableBeforeUnload: false, shouldBlockFn: () => dirty, keptInPage })
  if (blocker.status !== "blocked") return null
  return (
    <div role="alertdialog">
      Si sales, se perderán
      <button type="button" onClick={blocker.reset}>
        Seguir aquí
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
it("con la pantalla que conserva sus cajones, cambiar de pestaña no pregunta; cambiar de sede o salir a otra ruta sí", async () => {
  const router = appWith(
    [
      ["/finance", () => <DraftKeptInPage unlessChanges={["branch"]}>{form("Registrar gasto", "Concepto")}</DraftKeptInPage>],
      ["/reports", () => <p>Reportes</p>],
    ],
    "/finance?tab=gastos&branch=centro",
  )
  render(<RouterProvider router={router} />)
  fireEvent.input(await screen.findByLabelText("Concepto"), { target: { value: "Guantes" } })

  await router.navigate({ href: "/finance?tab=caja&branch=centro" })
  await waitFor(() => expect(router.state.location.search).toEqual({ tab: "caja", branch: "centro" }))
  expect(screen.queryByRole("alertdialog")).toBeNull()
  expect((screen.getByLabelText("Concepto") as HTMLInputElement).value).toBe("Guantes")

  // Otra sede sí pregunta: lo escrito se guardaría en ella.
  void router.navigate({ href: "/finance?tab=caja&branch=norte" })
  await screen.findByRole("alertdialog")
  fireEvent.click(screen.getByRole("button", { name: "Seguir aquí" }))
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
  expect(router.state.location.search).toEqual({ tab: "caja", branch: "centro" })

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

/** Un detalle que se guarda solo, como un formulario clínico: nunca hace `submit`. */
function Autosaved() {
  return (
    <DetailDrawer open title="Evaluación" onClose={() => {}}>
      <AutosavedAnswers />
    </DetailDrawer>
  )
}

function AutosavedAnswers() {
  const draftSaved = useDraftSaved()
  const [state, setState] = React.useState<"guardado" | "pendiente" | "error">("guardado")
  React.useEffect(() => draftSaved(state === "guardado"), [draftSaved, state])
  return (
    <>
      <input aria-label="Hallazgos" onInput={() => setState("pendiente")} />
      <button type="button" onClick={() => setState("guardado")}>
        Termina el autoguardado
      </button>
      <button type="button" onClick={() => setState("error")}>
        El servidor lo rechaza
      </button>
      <output>{state}</output>
    </>
  )
}

// Mesa de formularios del 13 nov (F10): con «Guardado» en pantalla, salir por el menú preguntaba
// «Si sales, se perderán». La columna contaba la tecla y solo un `submit` la desarmaba.
it("lo que se guarda solo: con todo guardado salir no pregunta, y un cambio que aún no se guardó sí", async () => {
  const router = appWith(
    [
      ["/ficha", () => <Autosaved />],
      ["/agenda", () => <p>Agenda</p>],
    ],
    "/ficha",
  )
  render(<RouterProvider router={router} />)
  fireEvent.input(await screen.findByLabelText("Hallazgos"), { target: { value: "Percusión positiva" } })

  // Aún sin guardar: avisa, como siempre.
  void router.navigate({ href: "/agenda" })
  await screen.findByRole("alertdialog")
  fireEvent.click(screen.getByRole("button", { name: "Seguir aquí" }))
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())

  fireEvent.click(screen.getByRole("button", { name: "Termina el autoguardado" }))
  await screen.findByText("guardado")
  await router.navigate({ href: "/agenda" })
  await screen.findByText("Agenda")
  expect(screen.queryByRole("alertdialog")).toBeNull()
})

it("lo que se guarda solo: volver a escribir después de guardar vuelve a avisar", async () => {
  const router = appWith([["/ficha", () => <Autosaved />]], "/ficha")
  render(<RouterProvider router={router} />)
  fireEvent.input(await screen.findByLabelText("Hallazgos"), { target: { value: "Percusión" } })
  fireEvent.click(screen.getByRole("button", { name: "Termina el autoguardado" }))
  await screen.findByText("guardado")
  fireEvent.input(screen.getByLabelText("Hallazgos"), { target: { value: "Percusión positiva" } })
  void router.navigate({ href: "/ficha?tab=otra" })
  await screen.findByRole("alertdialog")
})

it("lo que el servidor no guardó avisa aunque el cambio no haya sido una tecla", async () => {
  const router = appWith([["/ficha", () => <Autosaved />]], "/ficha")
  render(<RouterProvider router={router} />)
  fireEvent.click(await screen.findByRole("button", { name: "El servidor lo rechaza" }))
  await screen.findByText("error")
  void router.navigate({ href: "/ficha?tab=otra" })
  await screen.findByRole("alertdialog")
})

const YES_NO = [
  { value: "si", label: "Sí" },
  { value: "no", label: "No" },
]

/** Un formulario con su grupo de opciones de verdad, apagado (solo se lee) o no. */
function Answered({ readOnly }: { readOnly: boolean }) {
  const [pain, setPain] = React.useState<string | null>("si")
  return (
    <DetailDrawer open title="Evaluación" onClose={() => {}}>
      <p id="pain">¿Tienes dolor?</p>
      <RadioChips aria-labelledby="pain" value={pain} options={YES_NO} onChange={setPain} disabled={readOnly} />
    </DetailDrawer>
  )
}

// Un formulario finalizado o descartado se abre solo para leer: tocar una opción apagada no cambia nada.
it("tocar una opción deshabilitada del grupo de verdad no cuenta como cambio sin guardar; elegir una que sí cambia, sí", async () => {
  const pages: Array<[string, () => React.ReactNode]> = [
    ["/leer", () => <Answered readOnly />],
    ["/llenar", () => <Answered readOnly={false} />],
    ["/agenda", () => <p>Agenda</p>],
  ]
  const reading = appWith(pages, "/leer")
  const first = render(<RouterProvider router={reading} />)
  fireEvent.click(await screen.findByRole("radio", { name: "No" }))
  fireEvent.keyDown(screen.getByRole("radio", { name: "No" }), { key: " " })
  expect(screen.getByRole("radio", { name: "Sí" }).getAttribute("aria-checked")).toBe("true")
  await reading.navigate({ href: "/agenda" })
  await screen.findByText("Agenda")
  expect(screen.queryByRole("alertdialog")).toBeNull()
  first.unmount()

  const filling = appWith(pages, "/llenar")
  render(<RouterProvider router={filling} />)
  fireEvent.click(await screen.findByRole("radio", { name: "No" }))
  await waitFor(() => expect(screen.getByRole("radio", { name: "No" }).getAttribute("aria-checked")).toBe("true"))
  void filling.navigate({ href: "/agenda" })
  await screen.findByRole("alertdialog")
})

/** Lo que guarda solo dentro de un cajón abierto desde el panel: dice «guardado» al montarse. */
function SavedNote() {
  const draftSaved = useDraftSaved()
  React.useEffect(() => draftSaved(true), [draftSaved])
  return <p>Nota guardada</p>
}

/** Un formulario en el panel que abre encima un cajón con otra cosa que se guarda sola. */
function WithNestedDrawer() {
  const [nested, setNested] = React.useState(false)
  return (
    <FormDrawer open title="Editar paciente" onClose={() => {}} onSubmit={() => {}}>
      <input aria-label="Nombre" />
      <button type="button" onClick={() => setNested(true)}>
        Abrir la nota
      </button>
      <DetailDrawer open={nested} title="Nota" onClose={() => setNested(false)}>
        <SavedNote />
      </DetailDrawer>
    </FormDrawer>
  )
}

// Revisión de la entrega 3: lo que se abre desde el panel es un cajón aparte. Si ese cajón dice
// «ya guardé», no puede desarmar el aviso del formulario del panel, que sigue con lo suyo escrito.
it("un cajón abierto desde el panel no habla por el panel: su «guardado» no desarma el aviso de lo escrito ahí", async () => {
  const router = appWith([["/ficha", () => <WithNestedDrawer />]], "/ficha")
  render(<RouterProvider router={router} />)
  fireEvent.input(await screen.findByLabelText("Nombre"), { target: { value: "Ana" } })
  fireEvent.click(screen.getByRole("button", { name: "Abrir la nota" }))
  await screen.findByText("Nota guardada")
  void router.navigate({ href: "/ficha?tab=otra" })
  // El cajón de encima es modal y deja lo demás fuera del árbol accesible: se busca también ahí.
  await screen.findByRole("alertdialog", { hidden: true })
  expect(router.state.location.searchStr).toBe("")
})

/** El contenido que guarda solo se quita y el panel sigue abierto con otra cosa. */
function Swapped() {
  const [open, setOpen] = React.useState(true)
  return (
    <DetailDrawer open title="Documentos" onClose={() => {}}>
      {open ? <AutosavedAnswers /> : <p>Sin formulario abierto</p>}
      <button type="button" onClick={() => setOpen(false)}>
        Quitar el formulario
      </button>
    </DetailDrawer>
  )
}

it("al quitarse lo que no se guardó, el panel deja de avisar por él", async () => {
  const router = appWith(
    [
      ["/ficha", () => <Swapped />],
      ["/agenda", () => <p>Agenda</p>],
    ],
    "/ficha",
  )
  render(<RouterProvider router={router} />)
  fireEvent.click(await screen.findByRole("button", { name: "El servidor lo rechaza" }))
  await screen.findByText("error")
  fireEvent.click(screen.getByRole("button", { name: "Quitar el formulario" }))
  await screen.findByText("Sin formulario abierto")
  await router.navigate({ href: "/agenda" })
  await screen.findByText("Agenda")
  expect(screen.queryByRole("alertdialog")).toBeNull()
})
