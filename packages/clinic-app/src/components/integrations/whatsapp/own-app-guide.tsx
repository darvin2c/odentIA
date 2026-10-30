import { Button } from "@odentia/ui"
import { DetailDrawer } from "@odentia/ui-patterns"
import { ExternalLink } from "lucide-react"
import type { ReactNode } from "react"
import { appWords } from "../../../lib/product-words"
import { openSupportRequest } from "../../help-panel"

/** Las páginas de Meta de cada paso. Los nombres de sus botones pueden cambiar o salir en inglés. */
const META = {
  business: "https://business.facebook.com/",
  apps: "https://developers.facebook.com/apps/",
  manager: "https://business.facebook.com/wa/manage/home/",
  systemUsers: "https://business.facebook.com/settings/system-users",
} as const

function MetaLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex min-h-11 items-center gap-1.5 self-start font-semibold text-primary underline-offset-4 hover:underline sm:min-h-8"
    >
      {children}
      <ExternalLink aria-hidden className="size-3.5" />
      <span className="sr-only"> (se abre en otra pestaña)</span>
    </a>
  )
}

function Scope({ children }: { children: ReactNode }) {
  return <code className="rounded-md bg-muted px-1.5 py-0.5 text-[13px] text-foreground">{children}</code>
}

function GuideStep({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3 rounded-xl border p-3.5">
      <span
        aria-hidden
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground"
      >
        {number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm text-muted-foreground">
        <h3 className="text-[15px] font-semibold text-foreground">
          <span className="sr-only">Paso {number}. </span>
          {title}
        </h3>
        {children}
      </div>
    </li>
  )
}

/**
 * Cómo crear la app de Meta de la clínica, de cero a publicada: seis pasos en
 * Meta, cada uno con el enlace a su página. Lo que Meta solo deja hacer por la
 * API (suscribir la app y registrar el número cuando su página no lo deja
 * registrado) no está aquí: lo hace el sistema. Rutas y nombres de botones
 * vistos en la página de Meta el 2026-10-29.
 */
export function OwnAppGuide({ open, onClose }: { open: boolean; onClose: () => void }) {
  const name = appWords().name
  return (
    <DetailDrawer
      open={open}
      size="lg"
      title="Cómo crear tu app de Meta"
      description="Seis pasos en Meta, en este orden, con la cuenta de Facebook de quien administra la clínica."
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        <ol className="flex flex-col gap-2.5">
          <GuideStep number={1} title="El portafolio de la clínica en Meta">
            <p>
              Si la clínica ya tiene uno (lo usa para su página de Facebook o sus anuncios), usa ese. Si no, créalo con el nombre
              legal de la clínica.
            </p>
            <MetaLink href={META.business}>Abrir Meta Business</MetaLink>
          </GuideStep>
          <GuideStep number={2} title="Crear la app">
            <p>
              «Crear app» (Create app) › ponle el nombre de la clínica, sin las palabras WhatsApp, Facebook ni Meta: Meta no deja usar
              sus marcas. Caso de uso «Conectarte con los clientes a través de WhatsApp» › elige el portafolio del paso 1.
            </p>
            <MetaLink href={META.apps}>Abrir Meta for Developers</MetaLink>
          </GuideStep>
          <GuideStep number={3} title="Agregar el número de la clínica">
            <p>
              En la app: Casos de uso › «Personalizar» › «Paso 2: Configuración de producción» › «Registra tu número de teléfono de
              WhatsApp» › «Agregar número de teléfono». Escribe el nombre que verán los pacientes y confirma con el código que llega
              por SMS o llamada. Si ese número hoy está en la aplicación WhatsApp de un teléfono, Meta pide borrarlo ahí antes.
            </p>
            <p>
              Ahí mismo quedan los dos identificadores que pide {name}: «Identificador de número de teléfono» y «Messaging Account
              ID». Si Meta no deja el número registrado, {name} lo registra por ti al pulsar «Comprobar».
            </p>
          </GuideStep>
          <GuideStep number={4} title="La forma de pago">
            <p>
              En WhatsApp Manager agrega una tarjeta. Responder a quien escribe no la necesita; los recordatorios y avisos sí. Puedes
              hacerlo después: {name} te lo recuerda.
            </p>
            <MetaLink href={META.manager}>Abrir WhatsApp Manager</MetaLink>
          </GuideStep>
          <GuideStep number={5} title="La clave permanente">
            <p>
              Configuración del negocio › «Usuarios del sistema» (System users) › «Agregar», con rol Administrador. Meta rechaza
              nombres con muchas mayúsculas: usa una solo al inicio de cada palabra. Después:
            </p>
            <ol className="flex list-[lower-alpha] flex-col gap-1 pl-5">
              <li>
                «Asignar activos», los dos con acceso total: en «Apps», la app del paso 2 con «Administrar app»; en «Messaging
                accounts» › «Linked accounts», la cuenta de WhatsApp con «Todo». Sin la app asignada, el paso siguiente dice «No hay
                permisos disponibles».
              </li>
              <li>
                «Generar token»: elige la app, caducidad <strong className="font-semibold text-foreground">«Nunca»</strong> y marca{" "}
                <Scope>whatsapp_business_management</Scope> <Scope>whatsapp_business_messaging</Scope>; también{" "}
                <Scope>business_management</Scope> si aparece.
              </li>
              <li>Cópiala en ese momento: Meta no la vuelve a mostrar. Es la que pegas en «Clave de acceso permanente».</li>
            </ol>
            <MetaLink href={META.systemUsers}>Abrir Usuarios del sistema</MetaLink>
          </GuideStep>
          <GuideStep number={6} title="Publicar la app">
            <p>
              En la app: Configuración de la app › «Básica» (Basic). Completa la dirección de la política de privacidad de la
              clínica, la categoría y el ícono, cuadrado y con fondo transparente: Meta rechaza el fondo blanco. Si pide
              «Eliminación de datos de usuario», sirve la misma página de privacidad si explica cómo pedirlo. Pulsa «Guardar cambios»
              y después, en el menú de la izquierda, «Publicar». Sin publicar, Meta no avisa de los mensajes reales.
            </p>
            <p>
              En esa misma página está la <strong className="font-semibold text-foreground">«Clave secreta de la app»</strong> (App
              secret, «Mostrar»): es el cuarto dato.
            </p>
          </GuideStep>
        </ol>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted px-3.5 py-3">
          <span className="text-sm">¿Te trabaste en algún paso?</span>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            onClick={() => {
              onClose()
              openSupportRequest("Me trabé creando la app de Meta para conectar WhatsApp. Estoy en el paso: ")
            }}
          >
            Pedir ayuda a {name}
          </Button>
        </div>
        <p className="text-[13px] text-muted-foreground">«Pedir ayuda» abre un mensaje a soporte que lees antes de enviar; nunca lleva tus claves.</p>
      </div>
    </DetailDrawer>
  )
}
