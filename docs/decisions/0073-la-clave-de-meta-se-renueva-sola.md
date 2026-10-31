# 0073 · La clave de «Conectar con Facebook» se renueva sola

Fecha: 2026-10-20 · Estado: aceptada · Amplía a [0020](0020-conectar-whatsapp-con-facebook.md) en lo que pasa después de conectar

## Problema

La configuración de Meta que usa el botón (plantilla «Configuración de registro insertado de WhatsApp con un token que caduca en 60 días») entrega una clave que vence a los 60 días. Sin renovarla, la clínica deja de enviar y recibir mensajes el día 61, y tendría que volver a conectar cada dos meses (issue 121). La clínica no debería tener que hacer nada. Además, todavía no hay ninguna clínica conectada para probarlo contra Meta.

## Decisión y motivo

- **El worker renueva la clave antes de que venza.** Cada 12 horas revisa las conexiones activas hechas con el botón:
  - si no sabe cuándo vence una clave, se lo pregunta a Meta (`debug_token`);
  - si vence en 15 días o menos, pide otra con la vigente y la guarda en lugar de la anterior. Usa la renovación que Meta documenta para las claves de usuario del sistema que vencen: `fb_exchange_token` con `set_token_expires_in_60_days=true`.
- **Repetir la renovación es seguro.** La clave anterior sigue sirviendo hasta su propio vencimiento. Por eso, si Meta no responde, se reintenta en la vuelta siguiente sin anotar nada.
- **Si alguien volvió a conectar mientras tanto, gana la clave nueva.** La renovada solo se guarda si la conexión sigue teniendo la clave con que se pidió.
- **Si Meta dice que no:**
  - el motivo queda anotado en la conexión (`signup.tokenProblem`);
  - la campana avisa a quien administra las integraciones (dueño y administradores, `settings.write`), sin lo técnico y con la fecha en que vence. El aviso se retira solo cuando la clave se renueva o se vuelve a conectar;
  - Soporte de odentIA recibe el caso automático «Clave de Meta sin renovar», con lo que dijo Meta. Es uno por motivo, con cada clínica afectada, como «Modelo sin responder»;
  - se reintenta mientras la clave siga vigente;
  - si Meta ya no acepta la clave, no se insiste: solo volver a conectar la repone.
- **Lo mismo si Meta rechaza un envío con el código 190** (2026-10-31): la clave retirada antes de tiempo no espera a la revisión de cada 12 horas, que además no pregunta por una clave con vencimiento lejano. Solo en conexiones hechas con el botón.
- **Cada renovación queda en la actividad de la clínica** como algo automático, sin la clave.

## Alternativas descartadas

- *Avisar antes del vencimiento para que la clínica vuelva a conectar.* Le deja el trabajo a la clínica cada 60 días.
- *Una configuración cuya clave no venza.* Las claves de usuario del sistema no vencen por defecto, pero la variante de WhatsApp que deja elegir el plazo todavía no aparece para odentIA; puede que aparezca cuando sea proveedor de tecnología. Si se adopta, esta vuelta no tiene nada que renovar (`tokenNeverExpires`) y sigue cubriendo las conexiones de antes.
- *La clave permanente de un usuario del sistema de odentIA con acceso a las cuentas de todas las clínicas.* Una sola clave serviría para todas; si se filtra, las alcanza a todas.
- *Generar la clave con `/<client_business_id>/system_user_access_tokens`.* Es la vía que Meta documenta para las claves de integración comercial, pero exige el permiso `business_management`, que la configuración de odentIA no pide.

## Consecuencias

- **Beneficio:** la clínica conecta una sola vez.
- **Sacrificio:** el worker tiene una vuelta más y necesita `META_APP_ID` y `META_APP_SECRET`.
- **Por confirmar en la primera conexión real:** Meta documenta esta renovación para las claves de usuario del sistema, pero no dice si vale para la clave de integración comercial que da el botón. Si la rechaza, el motivo queda anotado 15 días antes del vencimiento. En ese caso se cambia a la vía con `business_management` o a una configuración sin vencimiento.

## Referencias

- `packages/channels/src/whatsapp-embedded-signup.ts` (`refreshSignupToken`, `inspectSignupToken`).
- `packages/services/src/whatsapp-signup.ts` (`signupTokenAction`, `saveRenewedSignupToken`).
- `apps/worker/src/whatsapp-tokens.ts`.
- `packages/services/src/model-outage.ts` (`reportAutomaticCase`) y `workspace.ts` (asunto `clave-meta`).
- Documentación de Meta leída el 2026-10-20:
  - [Install Apps, Generate, Refresh, and Revoke Tokens](https://developers.facebook.com/docs/business-management-apis/system-users/install-apps-and-generate-tokens/) (usuarios del sistema);
  - [Facebook Login for Business](https://developers.facebook.com/docs/facebook-login/facebook-login-for-business) (gestión de claves de integración comercial);
  - [`debug_token`](https://developers.facebook.com/docs/graph-api/reference/debug_token/).
