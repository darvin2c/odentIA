import { Badge } from "@odentia/ui"
import type { Meta, StoryObj } from "@storybook/react"
import { useState } from "react"
import { PersonAvatar } from "./person-avatar.js"
import { demoProductImage } from "./story-fixtures.js"
import { TaskCard } from "./task-card.js"

/**
 * La tarjeta de dos filas: arriba lo que es, abajo lo que toca. Tocar cualquier parte, o su
 * botón, abre lo mismo (aquí, una línea que dice qué se abrió). En Despachos, en «Te toca» y en la
 * Agenda es la misma pieza.
 */
const meta = {
  title: "Patrones/Tarjeta de lo que toca",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const SANDALIA = demoProductImage("#7a4a22")
const BOTIN = demoProductImage("#1f1f1f", "#f3c6d6")
const MOCASIN = demoProductImage("#5b3a24", "#e9e2d8")

function Demo() {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div className="flex min-h-svh flex-col gap-4 bg-canvas p-4 sm:p-6">
      <p role="status" className="text-sm text-muted-foreground">
        {open ? `Se abrió: ${open}` : "Toca una tarjeta o su botón."}
      </p>
      <ul className="grid max-w-3xl gap-3 sm:grid-cols-2">
        <TaskCard
          title="Carla Mendoza"
          reference="0164"
          image={SANDALIA}
          status={
            <>
              <Badge variant="warning">Pago por confirmar</Badge>
              <span className="font-medium text-warning">Falta S/ 101</span>
            </>
          }
          details={["Sandalia de tiras · dorado · 38", "Tarde · sin repartidor · Callao"]}
          task="Confirma el Yape: dice S/ 74 de S/ 101."
          actionLabel="Ver el Yape"
          label="Carla Mendoza, pedido 0164: Pago por confirmar, falta S/ 101"
          onOpen={() => setOpen("Carla Mendoza · Ver el Yape")}
        />
        <TaskCard
          title="Brenda Choque"
          reference="0169"
          image={BOTIN}
          status={
            <>
              <Badge variant="soft">Preparando</Badge>
              <span className="font-medium text-success">Pagado</span>
            </>
          }
          details={["Botín de tacón con pasador · negro · 37", "Tarde · Jhon · Independencia"]}
          task="Empácalo y dáselo a Jhon. Sale de 2 a 6 p. m."
          actionLabel="Empacar"
          selected={open === "Brenda Choque · Empacar"}
          onOpen={() => setOpen("Brenda Choque · Empacar")}
        />
        <TaskCard
          title="Fiorella Quispe"
          reference="0161"
          image={BOTIN}
          status={
            <>
              <Badge variant="soft">Preparando</Badge>
              <span className="font-medium text-warning">Al recibir S/ 390</span>
            </>
          }
          details={["Botín de tacón con pasador · negro · 37 · +1", "Tarde · sin repartidor · Los Olivos"]}
          task="Nadie libre de 2 a 6 p. m.: elige cómo sale."
          actionLabel="Elegir cómo sale"
          onOpen={() => setOpen("Fiorella Quispe · Elegir cómo sale")}
        />
        <TaskCard
          title="Claudia Ramos"
          reference="0150"
          image={MOCASIN}
          owner="auto"
          status={
            <>
              <Badge variant="success">Entregado</Badge>
              <span className="font-medium text-success">Pagado</span>
            </>
          }
          details={["Mocasín con borla · marrón · 40", "Mañana · Kevin · Miraflores"]}
          task="Entregado por Kevin."
          onOpen={() => setOpen("Claudia Ramos")}
        />
        <TaskCard
          title="Teresa Huertas"
          reference="0168"
          image={null}
          owner="auto"
          status={<Badge variant="soft">En camino</Badge>}
          details={["Zapatilla de lona · blanca · 37", "Tarde · Jhon · San Martín de Porres"]}
          task="Sigue solo: Jhon lo lleva de 2 a 6 p. m. Cobra S/ 99 en la puerta."
          onOpen={() => setOpen("Teresa Huertas")}
        />
        <TaskCard
          title="Rosa Quispe Mamani"
          reference="HC-000739"
          media={<PersonAvatar name="Rosa Quispe Mamani" decorative className="size-12 shrink-0" />}
          status={<Badge variant="secondary">Por confirmar</Badge>}
          details={["Limpieza · 10:30 a 11:15", "Dra. Ana Torres · Consultorio 2"]}
          task="No contestó el recordatorio de ayer."
          actionLabel="Llamar"
          onOpen={() => setOpen("Rosa Quispe Mamani · Llamar")}
        />
      </ul>
    </div>
  )
}

/** Las seis formas: con botón y sin él, con foto, sin foto y con persona; la elegida, con su borde. */
export const Tarjetas: Story = { render: () => <Demo /> }
