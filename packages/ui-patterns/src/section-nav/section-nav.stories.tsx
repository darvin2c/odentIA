import { RiCalendarLine, RiSettings3Line, RiUserLine } from "@remixicon/react"
import type { Meta, StoryObj } from "@storybook/react"
import { AppShell } from "../app-shell.js"
import { PageShell } from "../page-shell.js"
import { SectionNav } from "./index.js"
import { destinos, SectionBody, StoryLink, secciones } from "./story-fixtures.js"

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
      brand={<span className="text-base font-semibold">odentIA</span>}
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
