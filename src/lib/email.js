/**
 * Envio de email através do Resend (https://resend.com).
 *
 * Usa a API HTTP directamente em vez do SDK: é um único POST, e evita mais
 * uma dependência para manter actualizada.
 *
 * Sem RESEND_API_KEY a app continua a funcionar — os emails são escritos no
 * log em vez de enviados, para o desenvolvimento não precisar de credenciais
 * e para uma configuração incompleta em produção não partir o registo nem a
 * recuperação de palavra-passe.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** True quando há credenciais suficientes para enviar mesmo. */
export function emailIsConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

/**
 * Envia um email. Devolve { sent, skipped, error } em vez de rebentar:
 * uma falha de envio nunca deve impedir a acção que a originou.
 */
export async function sendEmail({ to, subject, html, text, replyTo }) {
  if (!emailIsConfigured()) {
    console.warn(
      `[email] não configurado (falta RESEND_API_KEY ou EMAIL_FROM) — não enviado a ${to}: ${subject}`
    );
    if (process.env.NODE_ENV !== 'production' && text) {
      console.warn(`[email] conteúdo que seria enviado:\n${text}`);
    }
    return { sent: false, skipped: true };
  }

  const payload = {
    from: process.env.EMAIL_FROM,
    to: [to],
    subject,
    html,
    ...(text ? { text } : {}),
    ...(replyTo ? { reply_to: replyTo } : {})
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`[email] o Resend respondeu ${res.status} ao enviar para ${to}: ${detail}`);
      return { sent: false, error: `resend_${res.status}` };
    }

    return { sent: true };
  } catch (err) {
    console.error(`[email] falhou o envio para ${to}: ${err.message}`);
    return { sent: false, error: err.message };
  }
}

/* ------------------------------------------------------------------ */
/* Modelos                                                             */
/* ------------------------------------------------------------------ */

/** Escapa texto para interpolar com segurança no HTML do email. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Molde comum a todos os emails. Estilos inline de propósito: os clientes de
 * email ignoram folhas externas e a maioria remove o <style> do cabeçalho.
 */
function layout({ title, body, appName }) {
  return `<!doctype html>
<html lang="pt"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:#f6f7f5;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#1c2321;">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e2e6e3;border-radius:12px;">
    <tr><td style="padding:24px;">
      <p style="margin:0 0 16px;font-weight:700;font-size:18px;color:#0f766e;">${esc(appName)}</p>
      <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;">${esc(title)}</h1>
      ${body}
    </td></tr>
  </table>
  <p style="max-width:520px;margin:16px auto 0;font-size:12px;color:#5f6b66;text-align:center;">
    Recebeste este email porque tens conta no ${esc(appName)}.
  </p>
</body></html>`;
}

/** Botão de acção, em tabela para aguentar o Outlook. */
function button(url, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;">
    <tr><td style="background:#0f766e;border-radius:6px;">
      <a href="${esc(url)}" style="display:inline-block;padding:12px 22px;color:#fff;text-decoration:none;font-weight:600;">${esc(label)}</a>
    </td></tr></table>`;
}

/** Email de recuperação de palavra-passe. */
export function passwordResetEmail({ name, url, appName, hours }) {
  const html = layout({
    appName,
    title: 'Recuperar a tua palavra-passe',
    body: `
      <p style="margin:0 0 12px;line-height:1.6;">Olá ${esc(name)},</p>
      <p style="margin:0 0 12px;line-height:1.6;">
        Pediste para definir uma palavra-passe nova. Carrega no botão para o fazer.
        O link só funciona durante ${hours} hora${hours === 1 ? '' : 's'} e uma única vez.
      </p>
      ${button(url, 'Definir palavra-passe nova')}
      <p style="margin:0 0 12px;line-height:1.6;font-size:14px;color:#5f6b66;">
        Se o botão não funcionar, copia este endereço:<br>
        <span style="word-break:break-all;">${esc(url)}</span>
      </p>
      <p style="margin:16px 0 0;line-height:1.6;font-size:14px;color:#5f6b66;">
        Se não foste tu a pedir, ignora este email — a tua palavra-passe actual continua válida.
      </p>`
  });

  const text = `Olá ${name},

Pediste para definir uma palavra-passe nova no ${appName}.
Abre este endereço (válido ${hours}h, uma única vez):

${url}

Se não foste tu a pedir, ignora este email.`;

  return { subject: `Recuperar a palavra-passe · ${appName}`, html, text };
}

/** Aviso ao organizador de que alguém pediu para entrar numa viagem. */
export function joinRequestEmail({ ownerName, requesterName, requesterEmail, eventTitle, message, url, appName }) {
  const html = layout({
    appName,
    title: `${requesterName} quer entrar na viagem`,
    body: `
      <p style="margin:0 0 12px;line-height:1.6;">Olá ${esc(ownerName)},</p>
      <p style="margin:0 0 12px;line-height:1.6;">
        <strong>${esc(requesterName)}</strong> pediu para entrar em
        <strong>${esc(eventTitle)}</strong>.
      </p>
      ${message ? `<blockquote style="margin:0 0 12px;padding:12px 16px;background:#f6f7f5;border-left:3px solid #0f766e;line-height:1.6;">${esc(message)}</blockquote>` : ''}
      <p style="margin:0 0 12px;line-height:1.6;font-size:14px;color:#5f6b66;">
        Contacto: ${esc(requesterEmail)}
      </p>
      ${button(url, 'Ver o pedido')}`
  });

  const text = `${requesterName} pediu para entrar em "${eventTitle}".
${message ? `\nMensagem: ${message}\n` : ''}
Contacto: ${requesterEmail}

Decide aqui: ${url}`;

  return { subject: `${requesterName} quer entrar em ${eventTitle}`, html, text };
}

/** Aviso a quem pediu, quando o organizador decide. */
export function joinDecisionEmail({ name, eventTitle, accepted, url, appName }) {
  const html = layout({
    appName,
    title: accepted ? `Estás dentro: ${eventTitle}` : `Pedido recusado: ${eventTitle}`,
    body: accepted
      ? `<p style="margin:0 0 12px;line-height:1.6;">Olá ${esc(name)},</p>
         <p style="margin:0 0 12px;line-height:1.6;">
           O teu pedido para entrar em <strong>${esc(eventTitle)}</strong> foi aceite.
           Já podes ver os detalhes e marcar a tua disponibilidade.
         </p>
         ${button(url, 'Abrir a viagem')}`
      : `<p style="margin:0 0 12px;line-height:1.6;">Olá ${esc(name)},</p>
         <p style="margin:0 0 12px;line-height:1.6;">
           O teu pedido para entrar em <strong>${esc(eventTitle)}</strong> não foi aceite desta vez.
         </p>`
  });

  const text = accepted
    ? `O teu pedido para entrar em "${eventTitle}" foi aceite.\n\n${url}`
    : `O teu pedido para entrar em "${eventTitle}" não foi aceite.`;

  return {
    subject: accepted ? `Aceite: ${eventTitle}` : `Pedido recusado: ${eventTitle}`,
    html,
    text
  };
}

/** Aviso aos participantes de que há datas para votar. */
export function proposalsEmail({ name, eventTitle, count, url, appName }) {
  const html = layout({
    appName,
    title: 'Há datas para votares',
    body: `
      <p style="margin:0 0 12px;line-height:1.6;">Olá ${esc(name)},</p>
      <p style="margin:0 0 12px;line-height:1.6;">
        Em <strong>${esc(eventTitle)}</strong> já há
        ${count} proposta${count === 1 ? '' : 's'} de datas à espera do teu voto.
      </p>
      ${button(url, 'Votar nas datas')}`
  });

  const text = `Em "${eventTitle}" há ${count} proposta(s) de datas para votares.\n\n${url}`;
  return { subject: `Vota nas datas de ${eventTitle}`, html, text };
}
