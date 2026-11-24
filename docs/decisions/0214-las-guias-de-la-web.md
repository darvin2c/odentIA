# 0214 · Las guías de la web: plantillas sin pedir el correo y el correo opcional al descargar

Fecha: 2026-11-24 · Estado: aceptada · Extiende la [0046](0046-web-de-marketing-en-astro.md) (la web) y la [0185](0185-el-arm-de-la-administracion.md) (el cliente existe desde el primer contacto)

## Problema

Lo que más buscan las clínicas en Google son tareas: llenar un odontograma, el de un niño, armar un presupuesto. Ninguna página de odentIA las respondía: la web solo vendía. Una guía que enseña trae a quien busca, pero quien baja una plantilla casi nunca llena una solicitud de 9 datos ahí mismo: si la plantilla pide el correo, se va a la página que la da sin pedir nada; si no lo pide, la clínica curiosa se pierde.

## Decisión y motivo

- **Cada guía es un archivo** (`apps/web/src/lib/guides/<slug>.ts`) y la web arma la página con un molde: responde, enseña con pasos y figuras, muestra cómo lo hace odentIA con la demo de su página de producto y deja pedir ahí mismo. El título, el nombre corto y la fecha están solo en el archivo: de ahí salen el índice, el pie, «Sigue con», el mapa del sitio y los datos para Google. Ninguna cifra de precio en el texto: el final las lee de Precios. Antes de publicar, la revisa la voz clínica y lo que dice de odentIA se cruza con el código.
- **Las plantillas se descargan sin pedir nada.** Salen del mismo kit y de la misma hoja que imprime la app (`packages/services/src/blank-sheets.ts`), sin membrete de clínica y con «Plantilla gratis de odentIA · odentia32.com» al pie. Son archivos fijos de la web: el mismo código da el mismo PDF, y una prueba avisa si quedaron viejos.
- **Al descargar, el correo es opcional y solo eso.** «¿Tienes una clínica? Déjanos tu correo…»: le llegan las plantillas adjuntas con la puerta para pedir entrar (con su correo en el fragmento de la dirección, nunca en la consulta). Entra al ARM como cliente con su contacto y la guía de la que llegó (`admin.saas_web_contact`), **sin abrir una venta ni avisar al equipo**: dejar un correo no es pedir entrar, y cada estudiante que baja un PDF no debe llenar el embudo ni las tareas de Kairós. Si después pide, es el mismo cliente y toma el nombre de la clínica, el país y el celular. Con el alta abierta no se pide el correo: lleva al botón de toda la web.
- **Contra el abuso, sin captcha:** solo JSON (otra página no lo puede enviar sin permiso de CORS), un campo trampa, 3 envíos por dirección IP cada 10 minutos, un correo por dirección al día (en la base, también con dos pestañas a la vez) y un tope de correos por hora.
- **La solicitud guarda la página desde la que se envió** (`saas_waitlist_request.source_page`), una ruta comprobada y nunca un título del navegador. Viaja en la dirección (`?desde=`), no en el cuerpo: así la API de antes la ignora durante el despliegue, cuando la web nueva ya se publicó.
- **Solo odentIA las tiene por ahora:** latidIA y vistIA no sirven /guias y su pie no las muestra, hasta que tengan las suyas con el mismo molde.

## Alternativas descartadas

- *Pedir el correo a cambio del PDF:* quien busca «odontograma pdf» se va a la página siguiente, Google no muestra un PDF escondido tras un formulario y la mayoría de quienes lo bajan no son clínicas.
- *Un botón que solo baja a la solicitud de 9 datos:* recién bajado el PDF, la clínica curiosa no los llena y se pierde.
- *Abrir una venta o avisar al equipo por cada correo:* llenaría el embudo y Hoy de estudiantes, con tareas de llamar a quien no dejó su celular.
- *Una ruta dinámica para las guías:* el mapa del sitio sale de los archivos de páginas; cada guía lleva su página de cinco líneas.

## Consecuencias

- La web guarda datos de visitantes en tres formularios: el Libro de Reclamaciones, la solicitud y el correo del aviso.
- Un correo dejado en el aviso es un cliente en Clientes con origen «Web · Desde /guias/…», sin venta ni aviso: el equipo lo ve en la lista y en su historial.
- Revisar si el aviso trae clínicas (cuántos correos piden después) y si el correo con adjuntos llega a la bandeja.

## Referencias

- Web: `apps/web/src/lib/guides/`, `apps/web/src/components/guides/`, `apps/web/src/pages/guias/`.
- Plantillas: `packages/services/src/blank-sheets.ts` (`pnpm --filter @odentia/services plantillas`).
- El correo: `POST /api/public/founders/contact` (`apps/api/src/routes/public-founders.ts`), `packages/services/src/web-contacts.ts`; migración `0155_las_guias`.
