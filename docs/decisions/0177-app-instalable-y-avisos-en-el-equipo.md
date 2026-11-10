# 0177. La app instalable y los avisos en el equipo

- Estado: aceptada (10 nov 2026)
- Contexto: pedido del dueño del producto de llevar odentIA «a app»; mesa de las cinco voces del 10 nov.

## Problema

Hoy, si nadie tiene la clínica abierta en una pestaña, nadie se entera de que un paciente espera o de que WhatsApp se cortó. Hay tres caminos: una app nativa, la misma web empaquetada para las tiendas (Capacitor) o la web instalable (PWA) con avisos del navegador (Web Push).

Hay dos restricciones:
- El aviso se ve con el teléfono bloqueado, a veces un teléfono personal o la tablet que se le pasa al paciente.
- Ya existen dos listas con reglas opuestas: la campana, que es para enterarse y se marca leída, y «Te espera», que es trabajo y se resuelve por estado.

## Decisión

- **PWA.** Las tres apps de clínica se instalan desde el navegador.
  - Cada clínica es su propio origen (`<slug>.<dominio>`), así que el manifiesto (`/app.webmanifest`) lleva su nombre, el ícono de su producto y su color.
  - Solo lo enlaza la zona con sesión, porque el portal del paciente comparte el origen.
- **Un service worker sin `fetch`** (`packages/clinic-app/public/sw.js`). No guarda páginas ni datos: lo que arma el servidor lleva datos de la clínica, y un caché dejaría a la gente en una versión vieja. Solo muestra avisos y abre la pantalla. Al tocar un aviso con la app abierta, la ventana navega con su router, para que se respete el borrador.
- **El push no es una tercera bandeja.** Avisa que algo cambió en lo que ya existe. Solo hay dos fuentes:
  - **«Te espera»:** aparece una persona nueva en lo que cuenta Inicio para quien mira. Usa la misma regla (`listWorkspaceWaitingPeople`, con `workspaceAccessFor`, que ahora vive en `services` y usan la API y el worker). Solo avisa con la clínica abierta; lo de la noche llega al abrir.
  - **El servicio cortado:** WhatsApp o el agente. Son los avisos de la campana con esos asuntos, a cualquier hora, a quien los recibe en la campana.
- **Sin datos de la persona en el aviso.** El título es la clínica y el cuerpo dice qué pasó y cuántos («Te esperan 2 personas»). El nombre se ve al abrir, con sesión.
- **Un interruptor por equipo, en la campana.** No va en el perfil, porque el perfil vive en el panel, otro origen. Se activa con un toque y entonces el navegador pide el permiso. Cerrar sesión lo apaga en ese equipo. Al enviar se vuelven a mirar la membresía y el permiso; quien dejó la clínica pierde la suscripción.
- **El worker anota antes de enviar** (`push_subscription.waiting_seen`, `notices_since`, `welcomed_at`). Un envío que falla o queda en duda no se repite, y un 404 o 410 del servicio de push olvida el equipo. El `tag` y el `topic` hacen que el siguiente aviso del mismo tipo reemplace al anterior.
- **Claves VAPID (RFC 8292):** un solo par para los tres productos, en el worker; la API sirve la pública. Sin ellas no se ofrece.

## Alternativas descartadas

- **App nativa o Capacitor:** semanas o meses, cuentas de tienda y una revisión por versión. Apple rechaza una web envuelta sin algo nativo. Se revisa si hace falta estar en las tiendas.
- **Copiar la campana al teléfono:** lleva lo que no es urgente (comisiones, firmas) y no lo que pide respuesta. Es ruido y la gente lo apaga.
- **Un push por evento** (cada mensaje entrante): habría que adivinar si el agente va a responder y repetir la regla de «Te espera».
- **Preferencias por tipo:** con dos fuentes no hacen falta.
- **Ícono con el logo de cada clínica:** el logo no tiene forma ni tamaño fijos y procesarlo en Workers no es gratis.
- **Guardar páginas sin conexión:** pondría datos clínicos en el equipo. El aviso de «Sin conexión» dice la verdad: lo escrito sigue ahí y no se guarda hasta que vuelva.

## Consecuencias

- Quien trabaja en dos clínicas instala y activa en cada una.
- En iPhone los avisos llegan solo a la app agregada al inicio (iOS 16.4 o posterior), con otra sesión que la de Safari.
- No hay guardia de urgencias: una alarma de noche llega al abrir. Si una clínica organiza una guardia, se revisa la regla del horario.
- «Llegó tu paciente» no avisa: necesita su propio gancho y su valor no está probado.

## Referencias

- `packages/services/src/push.ts`, `apps/worker/src/push.ts`, `apps/api/src/routes/push.ts`
- `packages/clinic-app/src/lib/pwa.ts`, `components/device-notices.tsx`, `routes/public/app[.]webmanifest.ts`
- Migraciones `0092` y `0093`; ADR 0063 (tabla cerrada al rol de la app) y 0084 (alarmas del agente).
