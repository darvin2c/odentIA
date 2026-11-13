# Correo entrante de Sallca

Un Email Worker de Cloudflare Email Routing para `soporte@` y `contacto@` de `odentia32.com`,
`latidia72.com` y `vistia20.com` (ADR 0185). Por cada correo:

1. **Lo reenvía** a `FORWARD_TO`, el buzón de siempre, para no perder nada aunque falle lo demás.
2. **Lo manda firmado a la administración** (`POST ${API_URL}/api/inbound/email`), que lo liga
   a su cliente por el correo exacto y guarda sus adjuntos como documentos solo de
   Administración, que se borran a los 30 días. Nadie ni nada los abre ni los manda al modelo.

Si el envío a la API falla, el correo ya se reenvió: queda en el registro del Worker y **no se
reintenta**. Solo si fallan el reenvío y la API, el correo se rechaza para que quien escribe
sepa que no llegó.

**No se despliega desde el repositorio ni desde el CI**: estos pasos se hacen a mano, una vez.
No es parte del monorepo (está fuera de `pnpm-workspace.yaml`).

## Lo que manda a la API

Cuerpo JSON:

```json
{
  "mailbox": "soporte | contacto",
  "product": "dental | medical | optical",
  "messageId": "<…>",
  "from": "quien@escribe.com",
  "fromName": "Su nombre",
  "to": "soporte@odentia32.com",
  "subject": "…",
  "text": "el texto, o el HTML pasado a texto",
  "receivedAt": "2026-11-12T15:00:00.000Z",
  "attachments": [{ "filename": "lista.xlsx", "contentType": "…", "base64": "…" }],
  "senderVerified": true
}
```

- `mailbox` sale de la parte local del destinatario (`soporte+algo@` cuenta como `soporte@`);
  `product`, del dominio: `odentia32.com` → `dental`, `latidia72.com` → `medical`,
  `vistia20.com` → `optical`. Otro destinatario solo se reenvía.
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
   verificada en Email Routing › Destination addresses: si no, Cloudflare no la reenvía.
3. **Email Routing de `odentia32.com` y `latidia72.com`** (cada zona › Email › Email Routing ›
   Routing rules): las reglas de `soporte@` y `contacto@` pasan de «Send to an email» a
   «Send to a Worker» › `sallca-correo-entrante`. Las demás direcciones (`hola@`,
   `privacidad@`…) se quedan como están.
4. **`vistia20.com`, de Namecheap a Cloudflare.** Hoy su correo lo recibe Namecheap:
   - en Cloudflare, Email Routing de la zona `vistia20.com` › Enable: agrega sus registros MX y
     el SPF de Cloudflare;
   - en Namecheap, quitar los MX y el SPF del reenvío de Namecheap (o pasar los nameservers a
     Cloudflare, si la zona aún no está ahí), para que no queden dos destinos;
   - crear `soporte@` y `contacto@` con «Send to a Worker» › `sallca-correo-entrante`, y
     `hola@` y `privacidad@` con «Send to an email» al buzón de siempre.
5. **Probar**: escribir a `soporte@` de cada dominio desde una cuenta propia con un PDF chico.
   Tiene que llegar al buzón de siempre y aparecer en la administración (en la ficha del
   cliente si el correo es de uno, o en Kairós como «correo sin cliente»). Antes, revisar en el
   correo reenviado que Cloudflare deja arriba `ARC-Authentication-Results: i=1;
   mx.cloudflare.net; …` (si su servidor se llama de otro modo, ponerlo con
   `npx wrangler secret put AUTHSERV_ID`): sin eso, ningún correo se liga solo a su cliente. En Workers ›
   `sallca-correo-entrante` › Logs se ve si la API respondió otra cosa.

Para volver atrás, las reglas de Email Routing vuelven a «Send to an email»: el Worker deja de
recibir y el correo sigue llegando como antes.
