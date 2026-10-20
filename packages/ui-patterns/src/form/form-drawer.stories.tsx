import { Button, toast } from "@odentia/ui"
import type { Meta, StoryObj } from "@storybook/react"
import { useState } from "react"
import { DemoFields, demoSubmit, useDemoWizard } from "../story-fixtures.js"
import { FormDrawer } from "./form-drawer.js"

/**
 * El mismo shell que `FormPanel` pero en drawer modal: overlay, focus-trap y
 * Esc los aporta Base UI. Las stories de ancho replican el hack de
 * `--drawer-content-width` que usan hoy las páginas con formularios extensos.
 *
 * El feedback de guardado es por toast (éxito y error), como en el platform.
 */
const meta = {
  title: "Patrones/FormDrawer",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const noop = () => {}

export const Compacto: Story = {
  render: () => (
    <FormDrawer open title="Editar sucursal" onClose={noop} onSubmit={demoSubmit}>
      <DemoFields />
    </FormDrawer>
  ),
}

export const Ancho48rem: Story = {
  render: () => (
    <FormDrawer
      open
      title="Registrar antecedentes"
      description="Drawer ensanchado vía CSS var, como imagenes-tab y document-upload."
      className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(48rem,calc(100vw-2rem))]"
      onClose={noop}
      onSubmit={demoSubmit}
    >
      <DemoFields wide />
    </FormDrawer>
  ),
}

export const FormularioLargoEnMovil: Story = {
  render: () => (
    <FormDrawer
      open
      title="Nuevo paciente"
      description="La cabecera y las acciones permanecen visibles mientras el formulario se desplaza."
      submitLabel="Siguiente"
      onClose={noop}
      onSubmit={demoSubmit}
    >
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-3">
          <h3 className="font-medium">Datos personales</h3>
          <DemoFields idPrefix="personal" />
        </section>
        <section className="flex flex-col gap-3">
          <h3 className="font-medium">Contacto y filiación</h3>
          <DemoFields idPrefix="contacto" />
        </section>
      </div>
    </FormDrawer>
  ),
}

export const Wizard: Story = {
  render: function WizardStory() {
    const wizard = useDemoWizard()
    return (
      <FormDrawer
        open
        title="Nueva atención"
        className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(42rem,calc(100vw-2rem))]"
        headerContent={wizard.headerContent}
        submitLabel={wizard.submitLabel}
        onSubmit={wizard.onSubmit}
        onClose={noop}
      >
        {wizard.body}
      </FormDrawer>
    )
  },
}

/**
 * Con cambios sin guardar, Cancelar, Esc o el clic fuera preguntan con la
 * confirmación propia: «Continuar editando» deja el cajón como estaba y
 * «Descartar y salir» lo cierra. Sin cambios, cierra directo.
 */
export const CambiosSinGuardar: Story = {
  render: function UnsavedStory() {
    const [open, setOpen] = useState(true)
    const [dirty, setDirty] = useState(false)
    return (
      <div className="p-6">
        <Button type="button" onClick={() => setOpen(true)}>
          Abrir formulario
        </Button>
        <FormDrawer
          open={open}
          title="Editar sucursal"
          description="Escribe en un campo y luego intenta cerrar."
          isDirty={dirty}
          onClose={() => {
            setOpen(false)
            setDirty(false)
          }}
          onSubmit={demoSubmit}
        >
          <div onInput={() => setDirty(true)}>
            <DemoFields />
          </div>
        </FormDrawer>
      </div>
    )
  },
}

/**
 * Otra forma de guardar lo mismo («Guardar borrador») va en el pie, entre
 * «Cancelar» y la principal; Enter sigue haciendo la principal. En el teléfono,
 * si los tres no caben, la principal baja a otra fila y queda a la derecha.
 */
export const ConAccionSecundaria: Story = {
  render: function SecondaryActionStory() {
    const [saving, setSaving] = useState<"borrador" | "pedido" | null>(null)
    const finish = (what: "borrador" | "pedido") => {
      setSaving(what)
      setTimeout(() => {
        setSaving(null)
        toast.success(what === "borrador" ? "OC-0012 quedó como borrador." : "OC-0012 quedó pedida.")
      }, 800)
    }
    return (
      <FormDrawer
        open
        title="Nueva compra"
        description="Sede Miraflores"
        submitLabel="Confirmar pedido"
        isSubmitting={saving !== null}
        secondaryAction={{ label: "Guardar borrador", onClick: () => finish("borrador") }}
        onClose={noop}
        onSubmit={(event) => {
          event.preventDefault()
          finish("pedido")
        }}
      >
        <DemoFields />
      </FormDrawer>
    )
  },
}

export const FalloDeGuardado: Story = {
  render: function FailingStory() {
    const [error, setError] = useState<string | null>(null)
    return (
      <FormDrawer
        open
        title="Editar sucursal"
        error={error}
        onClose={noop}
        onSubmit={(event) => {
          event.preventDefault()
          setError("No se pudo guardar: la sesión expiró.")
          toast.error("No se pudo guardar. Inténtalo de nuevo.")
        }}
      >
        <DemoFields />
      </FormDrawer>
    )
  },
}
