# 0148 · La hoja que se firma es la del papel

Fecha: 2026-11-06 · Estado: aceptada · Precisa [0037](0037-su-enlace-y-portal-en-un-paso.md) y [0117](0117-consentimientos-activos-y-hoja-editable.md)

## Problema

El consentimiento se firmaba en dos pantallas, la tablet de la clínica y «Su enlace» en el teléfono, que armaban cada una su propio texto: sin membrete ni datos del paciente, con otros títulos de sección y, en el enlace, sin la pieza ni la declaración. El PDF que queda decía que la persona aceptó una declaración que nunca vio. El dueño del producto lo resumió así: lo que firmo y el PDF deben ser exactamente iguales, y la plantilla de la clínica se ve igual en todas partes.

## Decisión y motivo

- **Una sola hoja en pantalla** (`ConsentSheet`) con el contenido y el orden del PDF (`consentBody`): membrete, «Consentimiento informado», título, pieza, paciente y documento, historia clínica, diagnóstico que lo motiva, las secciones con los títulos de la plantilla (`CONSENT_SECTION_LABELS`), información adicional, la declaración en su recuadro, quien firma («Paciente» o «Representante legal») y el nivel de firma al pie. La usan la tablet, el enlace y la vista previa de Configuración.
- **Se ve como el papel, se comporta como una página:** el texto se acomoda al ancho y no pagina; las firmas van una debajo de otra para que el recuadro de firma tenga el ancho de la hoja. La casilla y el recuadro van dentro de la hoja, donde el papel lleva la declaración y la firma. Es papel: se ve claro siempre, también con la app en oscuro (`.theme-light`), con sus campos y controles.
- **La declaración es la estándar en todos los canales.** Firmar por el enlace no quiere decir que no se le explicó: se le puede enviar para que lo revise con calma. La que se muestra es la que se guarda (`declarationSnapshot`) y llega del servidor.
- **El enlace muestra el diagnóstico y el número de historia** del consentimiento que firma. Precisa la regla de 0037 («nunca la historia»): no es la historia, es el documento que la persona firma y que ya recibe en PDF por su chat; solo lo ve quien decide por el paciente (`consentsOf`). El número de su documento sigue sin viajar: lo escribe y se compara al firmar.
- **Lo pendiente se dice como pendiente:** el bloque del profesional dice que falta su confirmación; en el enlace va sin nombre, porque en la cita puede confirmar otro profesional.

## Alternativas descartadas

- *Mostrar el PDF incrustado.* En un teléfono el PDF dentro de la página no es de fiar, un A4 en 390 px deja la letra en unos 5 puntos (WCAG 1.4.4 y 1.4.10) y en un PDF no se firma con el dedo.
- *Títulos sencillos en el teléfono.* La persona leería una cosa y firmaría otra.
- *Una declaración propia del enlace.* Supone que no se explicó; la plantilla y el papel son uno.

## Consecuencias

- Lo que se firma y lo que se guarda dicen lo mismo en odentIA y en latidIA, porque la hoja vive en el paquete común.
- La hoja de pantalla y el PDF son dos dibujos de lo mismo: un dato nuevo del consentimiento se agrega en los dos.
- Después, en la misma línea: la pieza lleva su nombre para quien firma («pieza 38 (tercer molar inferior izquierdo, muela del juicio)», forma `patient` del sitio del producto); la tablet pregunta antes de salir sin guardar las firmas; y, donde la norma lo pide (Perú: quien no sabe firmar imprime su huella), la hoja para firmar en papel trae el recuadro de la huella (`consentFingerprint` del perfil del país). En pantalla no se captura huella: quien no sabe firmar firma en papel.
- Fuera de esto: impedir de verdad que el paciente salga de la tablet a la ficha. Salir pregunta, pero no bloquea; bloquear pediría volver a identificarse, y en la práctica se resuelve con el modo de acceso guiado del propio equipo (iPad, Android).

## Referencias

`packages/clinic-app/src/components/patient/consent-sheet.tsx`, `consent-signing.tsx`, `components/public/link-steps.tsx`, `packages/services/src/su-enlace.ts` (`getPersonalLinkConsent`), `clinical-forms.ts` (`consentDiagnosisTitles`), `consent-pdf.ts`.
