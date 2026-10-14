# 0020 · WhatsApp también se conecta con un botón, por la app de odentIA en Meta

Fecha: 2026-10-13 · Estado: aceptada · Amplía a [0019](0019-mensajes-de-whatsapp-de-cada-clinica.md) en cómo se conecta la cuenta; los mensajes siguen como allí

## Problema

Conectar WhatsApp a mano le pide a la clínica crear su propia app en Meta, copiar cuatro datos y pegar dos claves. Meta ofrece otro camino (Embedded Signup, versión 4): la clínica entra con su Facebook en una ventana de Meta y vuelve conectada. Ese camino exige que odentIA tenga una app propia verificada y aprobada por Meta, y ese trámite puede demorar.

Restricciones que no cambian: el número y la cuenta son de la clínica; el código que devuelve la ventana vive 30 segundos y sirve una vez; Meta entrega los avisos de todas las cuentas conectadas así a una sola dirección de la app; registrar el número le fija un PIN que Meta vuelve a exigir.

## Decisión y motivo

- **Los dos caminos conviven.** El de a mano sirve desde el primer día y no cambia. El botón es opcional: existe solo si la instalación tiene las cuatro variables de la app de odentIA (`META_*`); sin ellas no se dibuja.
- **Una sola dirección de avisos para las conexiones del botón** (`/api/webhooks/meta/whatsapp`), firmada con la clave secreta de la app de odentIA. Cada cambio se reparte a su conexión: mensajes y estados por el número que los recibió, cambios de plantilla por su cuenta. Después sigue el mismo camino que la dirección de cada conexión (libro de duplicados, encolado, plantillas). Las conexiones hechas a mano siguen con su dirección y la clave de su propia app.
- **Los cambios de plantilla solo llegan a una conexión cuya suscripción Meta confirmó** con el permiso de esa clínica. El identificador de la cuenta lo trae la pantalla: sin esa confirmación nadie recibe los cambios de una cuenta ajena.
- **Desde que la conexión se guarda no se deshace nada.** El orden es: canjear el código y leer el número (si falla, no se guardó nada); guardar la conexión con sus pasos pendientes y su PIN cifrado; suscribir la app y registrar el número; anotar cómo quedó cada paso, leer la salud y pedir los mensajes. Si un paso de Meta falla, la conexión queda «necesita atención» diciendo cuál falta y por qué, y se reintenta con el permiso ya guardado, sin otra ventana. Deshacer obligaría a repetir toda la ventana de Meta por un fallo que suele ser pasajero y, si el registro ya salió, perdería el PIN que Meta exigirá después.
- **Las llamadas a Meta de este camino van fuera de las transacciones.** La base se abre dos veces, corta: para guardar y para anotar.
- **Volver a conectar es cambiar la clave**: el mismo cambio que a mano, sobre la misma conexión, con el permiso nuevo. No registra de nuevo un número ya registrado.
- **Una conexión hecha con el botón no guarda la clave secreta de ninguna app**; guarda el permiso de la cuenta y el PIN del número, cifrados como toda configuración de conexión.

## Alternativas descartadas

- *Una dirección de avisos por cuenta o por número* (las «direcciones alternas» de Meta): una cuenta con dos números se repartiría mal y los cambios de plantilla llegan de todos modos a la dirección de la app.
- *Deshacer la conexión si falla un paso*: ver arriba.
- *Guardar la clave secreta de la app de odentIA en cada conexión*: una rotación obligaría a reescribir todas.
- *Pasar al botón una conexión hecha a mano*: su número ya tiene un PIN que odentIA no conoce y su propia app seguiría recibiendo avisos. Por ahora se rechaza con su frase; se decide cuando el botón exista de verdad.
- *Reemplazar el camino a mano por el botón*: deja sin WhatsApp a todas las clínicas hasta que Meta apruebe a odentIA.

## Consecuencias

- Beneficio: cuando Meta apruebe la app, conectar es un botón, y un permiso perdido se recupera pulsándolo de nuevo.
- Sacrificio: dos caminos que mantener y una dirección más que recibe avisos; el estado de una conexión del botón (`signup`) y su cuenta viven en `channel_connection`.
- **Nada de esto está probado contra Meta**: la app de odentIA todavía no existe. Las pruebas usan respuestas con la forma que publica Meta. La primera conexión real debe confirmar, al menos: la forma de la respuesta al canjear el código, que `extras` vacío basta para la versión 4, el registro de un número que ya usaba la aplicación de WhatsApp de un teléfono y los dominios que el botón necesita permitidos.
- Meta limita al principio a 10 clínicas nuevas cada 7 días.
- Se revisa si las clínicas conectadas a mano piden pasar al botón, o si Meta cambia la versión del flujo.

## Referencias

- `packages/channels/src/whatsapp-embedded-signup.ts`, `whatsapp-cloud-api.ts` (`splitWhatsAppWebhook`).
- `packages/services/src/whatsapp-signup.ts`, `connections.ts`.
- `apps/api/src/routes/whatsapp-signup.ts`, `webhooks.ts`; `apps/platform/src/components/whatsapp/facebook-signup.tsx`.
- Migración `0070_conectar_con_facebook`. Variables y trámite: `docs/development.md`.
- Documentación de Meta leída el 2026-10-13: `https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/` (`versions`, `implementation`, `onboarding-customers-as-a-tech-provider`), `…/whatsapp/solution-providers/manage-webhooks`, `…/whatsapp/webhooks/override`.
