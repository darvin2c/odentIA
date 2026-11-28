import {
  Button,
  Field,
  FieldLabel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@odentia/ui"
import type { Meta, StoryObj } from "@storybook/react"
import { useEffect, useState } from "react"
import { DetailDrawer } from "./detail/detail-drawer.js"
import { useDraftSaved } from "./docked-surface.js"
import { FormDrawer } from "./form/form-drawer.js"
import { FormPanel } from "./form/form-panel.js"
import { MasterDetail } from "./master-detail.js"
import { SideDockProvider, SideDockSlot } from "./side-dock.js"
import { DemoFields, demoSubmit } from "./story-fixtures.js"

/**
 * Columna lateral del layout: el detalle de una lista se monta a todo el alto,
 * pegado al borde derecho, y se redimensiona desde su borde (arrastre, flechas,
 * doble clic). En ventanas de menos de 1280 px la página usa `FormDrawer`.
 */
const meta = {
  title: "Patrones/SideDock",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

function Demo({ size }: { size: "md" | "xl" }) {
  const [open, setOpen] = useState(true)
  return (
    <SideDockProvider>
      <div className="flex min-h-svh">
        <div className="flex min-w-0 flex-1 flex-col p-6">
          <MasterDetail
            panelSize={size}
            panel={
              open ? (
                <FormPanel
                  title="Editar sucursal"
                  description="El formulario ocupa todo el lado derecho."
                  onClose={() => setOpen(false)}
                  onSubmit={demoSubmit}
                >
                  <DemoFields />
                </FormPanel>
              ) : null
            }
          >
            <h1 className="text-2xl font-bold tracking-tight">Sucursales</h1>
            <p className="text-muted-foreground">
              La lista sigue usable mientras el formulario está abierto.
            </p>
            <div>
              <Button onClick={() => setOpen(true)} disabled={open}>
                Abrir formulario
              </Button>
            </div>
          </MasterDetail>
        </div>
        <SideDockSlot />
      </div>
    </SideDockProvider>
  )
}

export const FormularioCompacto: Story = { render: () => <Demo size="md" /> }

export const FormularioAncho: Story = { render: () => <Demo size="xl" /> }

/** Lo que haría el aviso de la app al salir, a la vista: la story no tiene rutas a las que ir. */
function GuardStatus({ dirty }: { dirty: boolean }) {
  return (
    <p role="status" className="border-t px-4 py-2 text-sm text-muted-foreground">
      {dirty ? "Si sales ahora, pregunta antes de perder lo escrito." : "Puedes salir: no pregunta."}
    </p>
  )
}

function AutosavedNotes() {
  const draftSaved = useDraftSaved()
  const [state, setState] = useState<"guardado" | "pendiente" | "error">("guardado")
  // El guardado de mentira: un segundo después de la última tecla; «falla» lo rechaza.
  useEffect(() => {
    draftSaved(state === "guardado")
    if (state !== "pendiente") return
    const timer = setTimeout(() => setState("guardado"), 1000)
    return () => clearTimeout(timer)
  }, [draftSaved, state])
  return (
    <div className="flex flex-col gap-3">
      <p aria-live="polite" className="text-xs text-muted-foreground">
        {state === "guardado" ? "Guardado" : state === "pendiente" ? "Cambios sin guardar" : "No se guardó"}
      </p>
      <Field>
        <FieldLabel htmlFor="autosaved-notes">Hallazgos (escribe «falla» para que el servidor lo rechace)</FieldLabel>
        <Textarea
          id="autosaved-notes"
          rows={3}
          onChange={(event) => setState(event.target.value.includes("falla") ? "error" : "pendiente")}
        />
      </Field>
    </div>
  )
}

/**
 * Un detalle que se guarda solo (`useDraftSaved`): mientras hay algo sin guardar, salir
 * pregunta; con «Guardado» ya no, y si el servidor lo rechaza vuelve a preguntar.
 */
export const SeGuardaSolo: Story = {
  render: () => (
    <SideDockProvider draftGuard={GuardStatus}>
      <div className="flex min-h-svh">
        <div className="flex min-w-0 flex-1 flex-col gap-2 p-6">
          <h1 className="text-2xl font-bold tracking-tight">Documentos</h1>
          <p className="text-muted-foreground">El formulario de la derecha se guarda mientras se llena.</p>
          <DetailDrawer open title="Evaluación de endodoncia" description="Se guarda solo mientras lo completas." onClose={() => {}}>
            <AutosavedNotes />
          </DetailDrawer>
        </div>
        <SideDockSlot />
      </div>
    </SideDockProvider>
  ),
}

function DetailWithNestedForm() {
  const [open, setOpen] = useState(false)
  const [method, setMethod] = useState<string | null>(null)
  return (
    <DetailDrawer open title="Cobros" description="Lo que ya está configurado." onClose={() => {}}>
      <div className="flex flex-col gap-3 text-sm">
        <p>Yape y Plin a tu número · efectivo al recibir.</p>
        <Button type="button" variant="outline" className="w-fit" onClick={() => setOpen(true)}>
          Agregar un medio de pago
        </Button>
      </div>
      <FormDrawer open={open} title="Nuevo medio de pago" onClose={() => setOpen(false)} onSubmit={() => setOpen(false)}>
        <Field>
          <FieldLabel htmlFor="nested-method">Medio</FieldLabel>
          <Select
            items={{ yape: "Yape", plin: "Plin", efectivo: "Efectivo al recibir" }}
            value={method}
            onValueChange={(value) => setMethod(value as string | null)}
          >
            <SelectTrigger id="nested-method" className="w-full">
              <SelectValue placeholder="Elige uno" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="yape">Yape</SelectItem>
              <SelectItem value="plin">Plin</SelectItem>
              <SelectItem value="efectivo">Efectivo al recibir</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </FormDrawer>
    </DetailDrawer>
  )
}

/**
 * Lo que se toca o se escribe en un cajón abierto desde la columna (y en su lista desplegable,
 * que vive en otro portal) es del cajón: la columna sigue sin nada escrito y salir no pregunta.
 */
export const CajonDesdeLaColumna: Story = {
  render: () => (
    <SideDockProvider draftGuard={GuardStatus}>
      <div className="flex min-h-svh">
        <div className="flex min-w-0 flex-1 flex-col gap-2 p-6">
          <h1 className="text-2xl font-bold tracking-tight">Configuración</h1>
          <p className="text-muted-foreground">Abre el cajón, elige un medio y ciérralo: la columna sigue sin cambios.</p>
          <DetailWithNestedForm />
        </div>
        <SideDockSlot />
      </div>
    </SideDockProvider>
  ),
}
