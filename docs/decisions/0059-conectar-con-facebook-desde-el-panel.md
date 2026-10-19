# 0059. «Conectar con Facebook» se abre desde el panel

- **Fecha:** 2026-10-18
- **Estado:** aceptada. Completa [0020](0020-conectar-whatsapp-con-facebook.md).

## Problema

La ventana de Meta (Embedded Signup) solo devuelve la cuenta, el número y el código si el dominio de la página que la abrió está en «Dominios permitidos para el SDK para JavaScript» de la app. Esa lista no admite comodín, y cada clínica trabaja en su subdominio (`<slug>.odentia32.com`). Con el botón en la clínica, cada alta obligaría a editar Meta a mano, y sin eso el botón falla.

## Decisión y motivo

La ventana se abre siempre desde una sola dirección, el panel (`app.<dominio>/whatsapp/conectar?org=<slug>`). El botón de la clínica lleva ahí en la misma pestaña; esa página carga el SDK, abre la ventana con su propio clic (el navegador lo exige), envía el código a la misma `POST /api/channels/whatsapp/signup` con `x-odentia-org` y vuelve a la página de WhatsApp de la clínica. En Meta queda un solo dominio, el del panel, más los de desarrollo.

La dirección solo dice qué clínica se quiere. La API comprueba la sesión, la membresía y `settings.write`, como en el resto de rutas; la operación no se duplica y el canje sigue ocurriendo al momento (el código vive 30 segundos).

## Alternativas descartadas

- Agregar cada subdominio en Meta: un paso manual por clínica que nadie puede olvidar sin romper el botón.
- Abrir el panel en una ventana emergente que a su vez abra la de Meta: dos ventanas, dos clics y un aviso entre ventanas más que puede perderse.
- Servir el botón desde el dominio raíz (`odentia32.com`): es la web estática de marketing, sin sesión ni API (ADR 0046).

## Consecuencias

La persona pulsa dos veces (en su clínica y en el panel) y ve una página intermedia. Los errores de la ventana se dicen en el panel, con «Volver a intentar» y la vuelta a la clínica. Si Meta llegara a aceptar comodín, el botón podría volver a la clínica.

## Referencias

- Issue 166. `apps/panel/src/routes/whatsapp.conectar.tsx`, `apps/panel/src/components/whatsapp/facebook-signup.tsx`, `apps/platform/src/components/whatsapp/facebook-signup.tsx`.
- Guía de Meta leída el 2026-10-18: `https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation`.
