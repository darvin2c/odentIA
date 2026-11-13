# Correo entrante de Sallca

Un Email Worker de Cloudflare Email Routing para `odentia32.com`, `latidia72.com` y
`vistia20.com` (ADR 0185). Recibe, por reglas fijas, los buzones `soporte@`, `contacto@`,
`hola@` y `fundadores@`, y por el **atrapa todo** de cada dominio cualquier otra dirección, que
es la de una persona del equipo (`<mail_local>@`, la que se ve en Equipo de la administración).
Qué hace con cada correo lo decide `deliver` (`src/flow.ts`), con las reglas de `src/route.ts`:

- **Un buzón fijo**: primero **lo reenvía** a `FORWARD_TO`, el buzón de siempre, para no perder
  nada aunque falle lo demás; después **lo manda firmado a la administración**
  (`POST ${API_URL}/api/inbound/email`), que lo liga a su cliente (por la respuesta a un correo
  nuestro o por el correo exacto) y guarda sus adjuntos como documentos solo de Administración,
  que se borran a los 30 días. Nadie ni nada los abre ni los manda al modelo. Si fallan el
  reenvío y la API, se rechaza para que quien escribe sepa que no llegó.
- **La dirección de una persona**: primero va a la API, que dice si es de alguien del equipo.
  Si lo es (2xx), el Worker lo reenvía a su copia (`copyTo`, si la tiene); si no es de nadie
  (404 `MAILBOX_UNKNOWN`), **lo rechaza** («Esta dirección no existe») sin reenviarlo; si la API
  falla o no responde, lo reenvía a `FORWARD_TO` para no perderlo. A una persona que ya no está
  en el equipo solo le llega la respuesta a un correo que salió con su dirección.
- **Solo se reenvía** a `FORWARD_TO`, sin pasar por la administración: `privacidad@`,
  `reclamaciones@`, `redes@` y `reply@` (tienen su propia regla a Gmail y no deberían llegar
  aquí), `no-reply@`, `postmaster@` y `abuse@`; lo que mandamos nosotros desde `no-reply@` o
  `reply@` de un dominio nuestro; y las respuestas automáticas y los rebotes (`Auto-Submitted`
  distinto de `no`, `X-Autoreply`, `X-Autorespond`, `Precedence: bulk|junk|auto_reply|list`,
  `Content-Type: multipart/report`, sin remitente, `mailer-daemon@` o `postmaster@`).

Lo que va a la API va una sola vez: si falla, queda en el registro del Worker y **no se
reintenta**. Las respuestas que salen desde la administración no dejan copia en Gmail.

**No se despliega desde el repositorio ni desde el CI**: estos pasos se hacen a mano, una vez.
No es parte del monorepo (está fuera de `pnpm-workspace.yaml`).

## Lo que manda a la API

Cuerpo JSON:

```json
{
  "mailbox": "soporte | contacto | hola | fundadores | persona",
  "localPart": "ada.lovelace",
  "product": "dental | medical | optical",
  "messageId": "<…>",
  "from": "quien@escribe.com",
  "fromName": "Su nombre",
  "to": "soporte@odentia32.com",
  "subject": "…",
  "text": "el texto, o el HTML pasado a texto",
  "receivedAt": "2026-11-12T15:00:00.000Z",
  "attachments": [{ "filename": "lista.xlsx", "contentType": "…", "base64": "…" }],
  "inReplyTo": "<…>",
  "references": "<…> <…>",
  "senderVerified": true
}
```

- `mailbox` sale de la parte local del destinatario (`soporte+algo@` cuenta como `soporte@`);
  cualquier otra parte local es `persona` y va con `localPart` (solo entonces);
  `product`, del dominio: `odentia32.com` → `dental`, `latidia72.com` → `medical`,
  `vistia20.com` → `optical`. Otro dominio solo se reenvía.
- `inReplyTo` y `references` son las cabeceras del hilo, solo con sus Message-ID y recortadas
  (998 y 8000 caracteres): así la API reconoce la respuesta a un correo nuestro.
- La respuesta de la API lleva `data.copyTo`: el buzón de la copia de esa persona, o `null`.
- Sin `Message-ID`, va uno fijo por el contenido del correo: la API entra cada correo una sola vez.
- `senderVerified` (`src/auth.ts`): el From se puede falsificar, así que la API liga el correo a
  su cliente solo si es `true`. Lo es si en el resultado de más arriba de Cloudflare
  (`ARC-Authentication-Results` o `Authentication-Results` de `mx.cloudflare.net`, o del
  servidor que diga `AUTHSERV_ID`) DMARC pasa con el dominio del From, o SPF o DKIM pasan con un
  dominio alineado. Si no, el correo llega igual y queda «sin cliente» en Kairós, marcado como de
  un remitente no verificado, para que una persona diga de quién es. Pruebas: `npm test`.
- Adjuntos: solo PDF, imagen, xlsx, csv y docx (la API lo vuelve a comprobar por sus bytes; un
  xlsx o un docx tiene que traer sus partes de Office, sin macros ni ejecutables),
  hasta 10 MB y 20 en total. Lo que pasa se omite y se avisa al final del texto. Las imágenes
  de la firma no se mandan.

**Firma** (la misma que `verifyInboundSignature` en `apps/api/src/routes/inbound-email.ts`):

- `x-sallca-timestamp`: los segundos Unix de cuando se firmó.
- `x-sallca-signature`: `sha256=` + el hex de HMAC-SHA256 con `INBOUND_EMAIL_SECRET` de
  `"<timestamp>.<cuerpo crudo>"`. El instante va dentro de lo firmado.
- La API acepta 5 minutos de diferencia y responde 401 si la firma no vale o venció; sin
  `INBOUND_EMAIL_SECRET` configurado responde 503.

Si la API cambia su esquema, se cambia solo `signedMaterial` en `src/index.ts`.

Pruebas (`npm test`, sin red): el remitente verificado (`src/auth.test.mjs`), a dónde va cada
correo y qué no entra (`src/route.test.mjs`) y el flujo de reenviar, mandar y rechazar
(`src/flow.test.mjs`).

## Pasos a mano

Con una persona que tenga acceso a la cuenta de Cloudflare de las zonas.

1. **El secreto.** Generar uno largo (por ejemplo `openssl rand -hex 32`) y ponerlo como
   `INBOUND_EMAIL_SECRET` en la API (entorno de producción del proyecto en OpenShip, o
   `infra/prod/.env`), con Apply/refresh. Es el mismo valor que lleva el Worker. Se guarda en el
   gestor de contraseñas; no va al repositorio ni al chat.
2. **Crear el Worker**, desde esta carpeta:

   ```bash
   npm install
   npx wrangler login
   npx wrangler deploy
   npx wrangler secret put INBOUND_EMAIL_SECRET   # el mismo de la API
   npx wrangler secret put API_URL                # https://api.odentia32.com
   npx wrangler secret put FORWARD_TO             # el buzón de siempre
   ```

   `FORWARD_TO` acepta varias direcciones separadas por comas. Cada una tiene que estar
   verificada en Email Routing › Destination addresses: si no, Cloudflare no la reenvía. Lo
   mismo la copia de cada persona (la que se pone en Equipo de la administración): sin
   verificar, el correo entra igual al ARM pero la copia no llega.
3. **Email Routing de `odentia32.com` y `latidia72.com`** (cada zona › Email › Email Routing ›
   Routing rules): `soporte@`, `contacto@`, `hola@` y `fundadores@` con «Send to a Worker» ›
   `sallca-correo-entrante` (crear `contacto@`, que hoy no existe), y el **Catch-all address**
   encendido con «Send to a Worker» › `sallca-correo-entrante`. Las reglas de `privacidad@`,
   `reclamaciones@`, `redes@` y `reply@` se quedan como están, a Gmail; la de
   `darvin.cotrina@` en `odentia32.com` se quita (pasa a ser la dirección de una persona por el
   atrapa todo, con su copia).
4. **`vistia20.com`, de Namecheap a Cloudflare.** Hoy su correo lo recibe Namecheap:
   - en Cloudflare, Email Routing de la zona `vistia20.com` › Enable: agrega sus registros MX y
     el SPF de Cloudflare;
   - en Namecheap, quitar los MX y el SPF del reenvío de Namecheap (o pasar los nameservers a
     Cloudflare, si la zona aún no está ahí), para que no queden dos destinos;
   - crear `soporte@`, `contacto@`, `hola@` y `fundadores@` y el atrapa todo con «Send to a
     Worker» › `sallca-correo-entrante`, y `privacidad@` con «Send to an email» al buzón de
     siempre.
5. **Probar**: escribir a `soporte@` de cada dominio desde una cuenta propia con un PDF chico.
   Tiene que llegar al buzón de siempre y aparecer en la administración (en la ficha del
   cliente si el correo es de uno, o en Kairós como «correo sin cliente»). Antes, revisar en el
   correo reenviado que Cloudflare deja arriba `ARC-Authentication-Results: i=1;
   mx.cloudflare.net; …` (si su servidor se llama de otro modo, ponerlo con
   `npx wrangler secret put AUTHSERV_ID`): sin eso, ningún correo se liga solo a su cliente. En Workers ›
   `sallca-correo-entrante` › Logs se ve si la API respondió otra cosa. Después, escribir a
   la dirección de una persona (tiene que llegar a su copia y a la administración) y a una que
   no es de nadie (tiene que rebotar con «Esta dirección no existe»).

Para volver atrás, las reglas de Email Routing vuelven a «Send to an email» y el atrapa todo se
apaga: el Worker deja de recibir y el correo sigue llegando como antes (las direcciones de las
personas vuelven a rebotar).
