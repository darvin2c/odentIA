const MAILPIT_API = process.env.MAILPIT_API ?? "http://127.0.0.1:8025/api/v1";

interface MailpitMessageSummary {
  ID: string;
  To: { Address: string }[];
  Subject: string;
  Created: string;
}

interface MailpitMessagesResponse {
  messages: MailpitMessageSummary[];
}

interface MailpitMessage {
  HTML?: string;
  Text?: string;
}


/**
 * Espera y extrae el primer enlace https:// del correo más reciente para
 * `email` cuyo asunto contiene `subjectIncludes`.
 */
export async function latestLinkFor(
  email: string,
  subjectIncludes: string,
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${MAILPIT_API}/messages?limit=50`);
    const { messages } = (await response.json()) as MailpitMessagesResponse;
    const match = messages
      .filter(
        (message) =>
          message.To.some((to) => to.Address.toLowerCase() === email.toLowerCase()) &&
          message.Subject.includes(subjectIncludes),
      )
      .sort((a, b) => b.Created.localeCompare(a.Created))[0];
    if (match) {
      const message = (await (
        await fetch(`${MAILPIT_API}/message/${match.ID}`)
      ).json()) as MailpitMessage;
      // El raw MIME corta URLs con quoted-printable; usar HTML/Text decodificados.
      const decoded = (message.HTML ?? "").replaceAll("&amp;", "&");
      const href = decoded.match(/href="(https:[^"]+)"/)?.[1];
      if (href) return href;
      const url =
        decoded.match(/https:\/\/[^\s<>"']+/)?.[0] ?? message.Text?.match(/https:\/\/\S+/)?.[0];
      if (url) return url.replace(/[.,;)]+$/, "");
      throw new Error(`Correo ${match.ID} sin enlace https`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Sin correo para ${email} con asunto ~ "${subjectIncludes}" en ${timeoutMs}ms`);
}
