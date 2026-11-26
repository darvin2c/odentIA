# 0216 · Las guías de la web: plantillas sin pedir el correo y el correo opcional al descargar

Fecha: 2026-11-24 · Estado: aceptada · Extiende la [0046](0046-web-de-marketing-en-astro.md) (la web) y la [0185](0185-el-arm-de-la-administracion.md) (el cliente existe desde el primer contacto)

## Problema

Lo que más buscan las clínicas en Google son tareas: llenar un odontograma, el de un niño, armar un presupuesto. Ninguna página de odentIA las respondía: la web solo vendía. Una guía que enseña trae a quien busca, pero quien baja una plantilla casi nunca llena una solicitud de 9 datos ahí mismo: si la plantilla pide el correo, se va a la página que la da sin pedir nada; si no lo pide, la clínica curiosa se pierde.

## Decisión y motivo

- **Cada guía es un archivo** (`apps/web/src/lib/guides/<slug>.ts`) y la web arma la página con un molde: responde, enseña con pasos y figuras, muestra cómo lo hace odentIA con la demo de su página de producto y deja pedir ahí mismo. El título, el nombre corto y la fecha están solo en el archivo: de ahí salen el índice, el pie, «Sigue con», el mapa del sitio y los datos para Google. Ninguna cifra de precio en el texto: el final las lee de Precios. Antes de publicar, la revisa la voz clínica y lo que dice de odentIA se cruza con el código.
- **Las plantillas se descargan sin pedir nada.** Salen del mismo kit y de la misma hoja que imprime la app (`packages/services/src/dental/blank-sheets.ts`; cada producto da las suyas en `guideSheetsFor`), sin membrete de clínica y con «Plantilla gratis de odentIA · odentia32.com» al pie. Son archivos fijos de la web: el mismo código da el mismo PDF, y una prueba avisa si quedaron viejos.
- **Al descargar, el correo es opcional y solo eso.** «¿Tienes una clínica? Déjanos tu correo…»: le llegan las plantillas adjuntas con la puerta para pedir entrar (con su correo en el fragmento de la dirección, nunca en la consulta). Entra al ARM como cliente con su contacto y la guía de la que llegó (`admin.saas_web_contact`), **sin abrir una venta ni avisar al equipo**: dejar un correo no es pedir entrar, y cada estudiante que baja un PDF no debe llenar el embudo ni las tareas de Kairós. Si después pide, es el mismo cliente y toma el nombre de la clínica, el país y el celular: solo ese cliente provisional, nunca los datos de un contacto que cargó el equipo, porque quien envía la solicitud solo demostró conocer el correo. A quien ya es de una clínica con cuenta, el correo le abre su entrada en vez de invitarla a pedir. Con el alta abierta no se pide el correo: lleva al botón de toda la web.
- **Contra el abuso, sin captcha.** CORS y «solo JSON» frenan a otras páginas en el navegador, no a un programa: lo que frena el abuso son los topes, y viven en la base, para todos los procesos y sin carreras. Un correo por buzón y por guía al día (desde el 25 nov; antes, uno por buzón: quien seguía a otra guía no la recibía) (sin la «+etiqueta» ni, en Gmail, los puntos: `mailboxOf`) y 20 por hora entre todos; además, un campo trampa y 3 envíos cada 10 minutos por red (una IPv6 cuenta por su /64, `rateKeyOf`, como en todas las rutas públicas).
- **No dice lo que no le toca a quien escribe un correo.** Ni el aviso ni la solicitud responden distinto si ese correo ya es cliente o ya pidió entrar: la solicitud repetida ve el mismo «Qué sigue», y la pantalla no promete la copia. Un correo que no se sabe si salió cuenta para el día y la web no invita a reintentarlo: no se manda dos veces (lo que se ve es «No pudimos confirmar que salió», con las plantillas a mano).
- **La solicitud guarda la página desde la que se envió** (`saas_waitlist_request.source_page`), una ruta comprobada y nunca un título del navegador. Viaja en la dirección (`?desde=`), no en el cuerpo: así la API de antes la ignora durante el despliegue, cuando la web nueva ya se publicó.
- **Solo odentIA las tiene por ahora:** latidIA y vistIA no sirven /guias y su pie no las muestra, hasta que tengan las suyas con el mismo molde.

## Los videos (25 nov, segundo PR)

Cada guía puede tener la **lista de reproducción** de su tema en el canal de YouTube (`playlist` en su archivo). La web lee el feed público de la lista (sin clave ni costo, los últimos 15), lo guarda 6 horas (en Workers, en la caché del centro de datos) y muestra el más reciente en la portada y los demás en «Más videos de este tema». Un tutorial nuevo que se suma a la lista aparece solo, sin tocar la web. Si YouTube no responde en 1,5 s, o la guía no tiene lista, va el video fijo (`video`), o ninguno: la página nunca espera ni falla por YouTube.

El video se ve en la misma página al tocarlo (YouTube sin cookies hasta entonces; antes solo se carga la miniatura) y debajo están «Verlo en YouTube» y «Suscríbete al canal». Cada video va a Google como `VideoObject`, para que la guía también salga en los resultados de video.

*Descartado:* leer el canal entero (el feed trae solo los últimos 15, casi todos Shorts) o la API de YouTube (pide clave y cuota).

## Tres guías más (26 nov, tercer PR)

El plan de tratamiento por fases, el periodontograma y los códigos CIE-10, elegidas por lo que los odontólogos escriben en Google (sugerencias de búsqueda de Perú y México). Las tres plantillas no copian una hoja que imprima la app, como las anteriores: la app no imprime el periodontograma ni la lista de códigos, y el plan solo lo imprime dentro del presupuesto. Se hicieron con los mismos datos que maneja la app: los seis sitios y el signo de la recesión de `periodontal.ts`, las cinco fases de `treatment-templates.ts` y los códigos odontológicos de la CIE-10 del MINSA que carga la base (`isDentalDiagnosis`), que el mismo comando de las plantillas deja también en `cie10-odontologia.json` para el buscador de la guía. La plantilla es para quien todavía trabaja en papel; la guía le muestra cómo se hace en odentIA.

## Alternativas descartadas

- *Pedir el correo a cambio del PDF:* quien busca «odontograma pdf» se va a la página siguiente, Google no muestra un PDF escondido tras un formulario y la mayoría de quienes lo bajan no son clínicas.
- *Un botón que solo baja a la solicitud de 9 datos:* recién bajado el PDF, la clínica curiosa no los llena y se pierde.
- *Abrir una venta o avisar al equipo por cada correo:* llenaría el embudo y Hoy de estudiantes, con tareas de llamar a quien no dejó su celular.
- *Una ruta dinámica para las guías:* el mapa del sitio sale de los archivos de páginas; cada guía lleva su página de cinco líneas.

## Consecuencias

- La web guarda datos de visitantes en tres formularios: el Libro de Reclamaciones, la solicitud y el correo del aviso.
- Un correo dejado en el aviso es un cliente en Clientes con origen «Web · Desde /guias/…», sin venta ni aviso: el equipo lo ve en la lista y en su historial. Si el correo es de varios clientes, el aviso queda sin cliente (no se elige uno), y al fusionar dos clientes pasa al que queda.
- Si el proveedor de correo falla, ese buzón no recibe las plantillas por correo hasta el día siguiente: las tiene en la página, que es lo que pidió.
- Revisar si el aviso trae clínicas (cuántos correos piden después) y si el correo con adjuntos llega a la bandeja.

## Referencias

- Web: `apps/web/src/lib/guides/`, `apps/web/src/components/guides/`, `apps/web/src/pages/guias/`.
- Plantillas: `packages/services/src/dental/blank-sheets.ts` (`pnpm --filter @odentia/services plantillas`) y `guideSheetsFor` en `products.ts`.
- El correo: `POST /api/public/founders/contact` (`apps/api/src/routes/public-founders.ts`), `packages/services/src/web-contacts.ts`; la llave de los topes por red, `apps/api/src/lib/rate-key.ts`; migración `0157_las_guias`.
