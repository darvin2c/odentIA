import { RiCalendarLine, RiSettings3Line, RiUserLine } from "@remixicon/react"
import type { Meta, StoryObj } from "@storybook/react"
import type * as React from "react"
import { Input } from "@odentia/ui"
import { Search } from "lucide-react"
import { AppShell } from "../app-shell.js"
import { Brand } from "../brand.js"
import { PageShell } from "../page-shell.js"
import { SectionNav } from "./index.js"
import {
  configuracion,
  configuracionGrupos,
  configuracionSueltas,
  destinos,
  SectionBody,
  StoryLink,
  secciones,
  tiendaGrupos,
  tiendaPortada,
  tiendaSueltas,
} from "./story-fixtures.js"

/**
 * Navegación de sección. **Web siempre riel** (`side`, ≥1024px) y **tablet y
 * móvil siempre barra** (`mobilePosition`, <1024px): cada superficie ignora la
 * opción de la otra. El corte lo hace el CSS (`lg`) sobre un solo árbol, así que
 * el ancho del viewport decide qué superficie se ve —también en el HTML que
 * manda el servidor, sin esperar a que hidrate.
 *
 * La sección va dentro del `PageShell`, que aporta fondo de página y padding: el
 * nav no toca ninguno de los dos.
 */
const meta = {
  title: "Patrones/SectionNav",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const RielIzquierdo: Story = {
  render: () => (
    <PageShell>
      <SectionNav
        label="Secciones de la ficha"
        items={secciones}
        pathname="/pacientes/123/historia"
        LinkComponent={StoryLink}
      >
        <SectionBody />
      </SectionNav>
    </PageShell>
  ),
}

export const RielDerecho: Story = {
  render: () => (
    <PageShell>
      <SectionNav
        label="Secciones de la ficha"
        items={secciones}
        pathname="/pacientes/123/historia"
        LinkComponent={StoryLink}
        side="right"
      >
        <SectionBody />
      </SectionNav>
    </PageShell>
  ),
}

/** En web también es riel; `mobilePosition="header"` sólo mueve la barra en
 * tablet y móvil. */
export const BarraArriba: Story = {
  render: () => (
    <PageShell>
      <SectionNav
        label="Secciones de la ficha"
        items={secciones}
        pathname="/pacientes/123/historia"
        LinkComponent={StoryLink}
        mobilePosition="header"
      >
        <SectionBody />
      </SectionNav>
    </PageShell>
  ),
}

export const CincoDestinos: Story = {
  render: () => (
    <PageShell>
      <SectionNav label="Destinos" items={destinos} pathname="/agenda" LinkComponent={StoryLink}>
        <SectionBody
          title="Agenda"
          note="Cinco destinos de ancho igual, sin scroll horizontal."
          placeholder="Bloque alto: la barra queda pegada al borde mientras se scrollea."
        />
      </SectionNav>
    </PageShell>
  ),
}

export const DieciseisDestinos: Story = {
  render: () => (
    <AppShell
      items={[
        { label: "Inicio", to: "/", icon: RiCalendarLine },
        { label: "Pacientes", to: "/patients", icon: RiUserLine },
      ]}
      LinkComponent={StoryLink}
      pathname="/settings/audit"
      user={{ name: "Ada Lovelace", email: "ada@odentia.localhost" }}
      brand={<Brand />}
      brandIcon={<Brand compact />}
      footerItems={[{ label: "Configuración", to: "/settings", icon: RiSettings3Line }]}
      onSignOut={() => {}}
    >
      <PageShell>
        <SectionNav
          label="Configuración"
          items={configuracion}
          pathname="/settings/audit"
          LinkComponent={StoryLink}
        >
          <SectionBody
            title="Auditoría"
            note="Los dieciséis destinos se abren desde un selector y conservan etiquetas legibles."
            placeholder="La lista tiene scroll local, mantiene el destino activo visible y no desborda el documento."
          />
        </SectionNav>
      </PageShell>
    </AppShell>
  ),
}

/**
 * Lista larga leída por temas: `groups` pone un título a cada grupo y las
 * entradas sueltas (`items`) quedan al final, tras un separador. En el riel son
 * rótulos sobre la misma lista; en tablet y móvil, «Cambiar sección» abre una
 * tarjeta por grupo con una fila por entrada.
 */
export const Agrupada: Story = {
  render: () => (
    <AppShell
      items={[
        { label: "Inicio", to: "/", icon: RiCalendarLine },
        { label: "Pacientes", to: "/patients", icon: RiUserLine },
      ]}
      LinkComponent={StoryLink}
      pathname="/settings/integrations"
      user={{ name: "Ada Lovelace", email: "ada@odentia.localhost" }}
      brand={<Brand />}
      brandIcon={<Brand compact />}
      footerItems={[{ label: "Configuración", to: "/settings", icon: RiSettings3Line }]}
      onSignOut={() => {}}
    >
      <PageShell>
        <SectionNav
          label="Configuración"
          groups={configuracionGrupos}
          items={configuracionSueltas}
          pathname="/settings/integrations"
          LinkComponent={StoryLink}
        >
          <SectionBody
            title="Integraciones"
            note="Cuatro grupos con nombre de trabajo y dos entradas sueltas al final."
            placeholder="En una ventana baja el riel se desplaza por dentro; en tablet y móvil la lista se abre desde «Cambiar sección»."
          />
        </SectionNav>
      </PageShell>
    </AppShell>
  ),
}

/**
 * La composición real: `SectionNav` dentro del `main` del `AppShell`, sobre el
 * `PageShell`. La navegación global sigue en el sidebar del shell.
 */
export const DentroDelAppShell: Story = {
  render: () => (
    <AppShell
      items={[
        { label: "Pacientes", to: "/pacientes/123", icon: RiUserLine, badge: 4 },
        { label: "Agenda", to: "/agenda", icon: RiCalendarLine },
      ]}
      LinkComponent={StoryLink}
      pathname="/pacientes/123/historia"
      user={{ name: "Ada Lovelace", email: "ada@odentia.localhost" }}
      brand={<Brand />}
      brandIcon={<Brand compact />}
      footerItems={[{ label: "Configuración", to: "/settings", icon: RiSettings3Line }]}
      onSignOut={() => {}}
    >
      <PageShell>
        <SectionNav
          label="Secciones de la ficha"
          items={secciones}
          pathname="/pacientes/123/historia"
          LinkComponent={StoryLink}
        >
          <SectionBody />
        </SectionNav>
      </PageShell>
    </AppShell>
  ),
}

/** Buscador propio de la sección (no el de Ctrl+K), para la ranura `header`. */
function SectionSearch() {
  return (
    <div className="relative">
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input aria-label="Buscar en Configuración" placeholder="Buscar en Configuración" className="pl-9" />
    </div>
  )
}

/** La Configuración de una tienda: su portada, sus partes y el buscador sobre la lista. */
function TiendaConfig({ pathname, children }: { pathname: string; children: React.ReactNode }) {
  return (
    <AppShell
      items={[
        { label: "Inicio", to: "/", icon: RiCalendarLine },
        { label: "Clientes", to: "/clientes", icon: RiUserLine },
      ]}
      LinkComponent={StoryLink}
      pathname={pathname}
      user={{ name: "Rosa Quispe", email: "rosa@gestoria.localhost" }}
      brand={<Brand />}
      brandIcon={<Brand compact />}
      footerItems={[{ label: "Configuración", to: tiendaPortada, icon: RiSettings3Line }]}
      onSignOut={() => {}}
    >
      <PageShell>
        <SectionNav
          label="Configuración"
          groups={tiendaGrupos}
          items={tiendaSueltas}
          itemsPosition="start"
          header={<SectionSearch />}
          mobileIndex={tiendaPortada}
          pathname={pathname}
          LinkComponent={StoryLink}
        >
          {children}
        </SectionNav>
      </PageShell>
    </AppShell>
  )
}

/**
 * Portada en el teléfono (`mobileIndex`): en su ruta, la lista es la página, debajo de su
 * encabezado y con el buscador (`header`) encima; no hay barra ni «Cambiar sección». «Lo que
 * falta» va suelta antes de los grupos (`itemsPosition="start"`) y su contador, en ámbar
 * (`badgeTone: "pending"`). En web sigue el riel, con el buscador sobre la lista. Verla a 390 px.
 */
export const PortadaEnElTelefono: Story = {
  render: () => (
    <TiendaConfig pathname={tiendaPortada}>
      <h1 className="text-xl font-semibold tracking-tight">Configuración</h1>
      {/* Lo que la portada muestra solo en web lo esconde ella: en el teléfono la lista es la página. */}
      <div className="mt-4 rounded-xl border bg-card p-6 text-sm text-muted-foreground max-lg:hidden">
        En web, la portada muestra su propio contenido al lado del riel.
      </div>
    </TiendaConfig>
  ),
}

/** Una parte abierta desde la portada: en el teléfono, en su pantalla y con «‹ Configuración» para volver. */
export const ParteDesdeLaPortada: Story = {
  render: () => (
    <TiendaConfig pathname="/configuracion/cobros">
      <SectionBody
        title="Cobros"
        note="Una parte por pantalla en el teléfono; en web, el riel con la parte marcada."
        placeholder="Contenido de Cobros."
      />
    </TiendaConfig>
  ),
}
