// Política de cookies: la web no usa cookies; la aplicación usa solo las necesarias y almacenamiento local.
import { contactEmail } from "../site"
import type { LegalDoc } from "./types"

export const COOKIES: LegalDoc = {
  path: "/cookies",
  title: "Política de cookies",
  description:
    "La web de odentIA no usa cookies. La aplicación usa solo cookies de sesión estrictamente necesarias y almacenamiento local para preferencias y borradores.",
  intro: [
    "Las cookies son pequeños archivos que un sitio web guarda en su navegador. El almacenamiento local es un espacio similar del navegador que una aplicación usa para recordar información en su dispositivo.",
  ],
  sections: [
    {
      id: "web",
      title: "La web de odentIA",
      blocks: [
        "Esta web no instala cookies ni usa herramientas de analítica, publicidad o redes sociales de terceros. Para conocer el tráfico de forma agregada, usamos los registros de nuestro propio servidor, como se explica en la [política de privacidad](/privacidad).",
        "Por eso no le pedimos que acepte cookies al visitar la web.",
      ],
    },
    {
      id: "aplicacion",
      title: "La aplicación de odentIA",
      blocks: [
        "La aplicación que usan las clínicas (el panel y la plataforma) usa únicamente cookies estrictamente necesarias para iniciar y mantener la sesión, y el almacenamiento local del navegador para recordar preferencias y conservar borradores. No usa cookies de analítica ni de publicidad.",
        "Como son imprescindibles para que el servicio funcione, no requieren consentimiento. Si las bloquea, no podrá iniciar sesión.",
        {
          table: {
            caption: "Cookies y almacenamiento local de la aplicación",
            head: ["Tipo", "Para qué sirve", "Duración"],
            rows: [
              [
                "Cookie de sesión",
                "Mantener iniciada la sesión del usuario de forma segura.",
                "[Por completar: duración exacta]",
              ],
              [
                "Cookie de seguridad de la sesión",
                "Proteger el inicio de sesión frente a solicitudes falsificadas [Por confirmar: si existe esta cookie].",
                "[Por completar: duración exacta]",
              ],
              [
                "Almacenamiento local: preferencias",
                "Recordar elecciones de la interfaz, como la sede o la vista elegida.",
                "Hasta que el usuario lo borre.",
              ],
              [
                "Almacenamiento local: borradores",
                "Conservar lo que el usuario está escribiendo para que no lo pierda si cierra la página.",
                "Hasta que el usuario envíe o descarte el borrador, o lo borre.",
              ],
            ],
          },
        },
      ],
    },
    {
      id: "borrar",
      title: "Cómo borrarlas",
      blocks: [
        "Puede borrar las cookies y el almacenamiento local desde la configuración de su navegador, normalmente en el apartado de privacidad o de datos de sitios. Al hacerlo se cerrará su sesión en la aplicación y se perderán los borradores que no haya enviado.",
        "Cerrar sesión desde la aplicación elimina la cookie de sesión.",
      ],
    },
    {
      id: "cambios",
      title: "Cambios y contacto",
      blocks: [
        "Si en el futuro usamos otras cookies, actualizaremos esta política y, cuando la ley lo exija, le pediremos su consentimiento antes de instalarlas.",
        `Para cualquier duda, escriba a [${contactEmail}](mailto:${contactEmail}).`,
      ],
    },
  ],
}
