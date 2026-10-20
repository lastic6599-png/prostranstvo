// Отправка писем через SMTP (Яндекс 360, Mail.ru, Unisender, SendPulse и т. п.).
// Если SMTP не настроен — письмо печатается в консоль сервера (удобно при разработке).
'use strict';

const env = process.env;
let transport = null;

function getTransport() {
  if (transport || !env.SMTP_HOST) return transport;
  const nodemailer = require('nodemailer');
  const port = +env.SMTP_PORT || 465;
  transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  return transport;
}

function codeEmail(code, purpose) {
  const title = purpose === 'reset' ? 'Сброс пароля' : 'Подтверждение почты';
  const lead = purpose === 'reset'
    ? 'Кто-то (надеемся, вы) запросил сброс пароля в Пространстве.'
    : 'Спасибо за регистрацию в Пространстве!';
  const text = `${lead}\n\nВаш код: ${code}\n\nКод действует 15 минут. Если это были не вы — просто проигнорируйте письмо.`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:420px;margin:0 auto;padding:24px;background:#f4efe6;color:#0d0c0a">
  <div style="font-family:Georgia,serif;font-size:22px;letter-spacing:2px;margin-bottom:20px">ПРОСТРАНСТВО</div>
  <p style="font-size:14px;line-height:1.6">${lead}</p>
  <p style="font-size:13px;color:#7a7268;margin:20px 0 6px">Ваш код</p>
  <div style="font-size:34px;letter-spacing:10px;font-weight:bold;color:#b8913a">${code}</div>
  <p style="font-size:12px;color:#7a7268;line-height:1.6;margin-top:20px">Код действует 15 минут. Если это были не вы — просто проигнорируйте письмо.</p>
</div>`;
  return { subject: `${title} — код ${code}`, text, html };
}

async function sendCode(to, code, purpose) {
  const msg = codeEmail(code, purpose);
  const t = getTransport();
  if (!t) {
    console.log(`[mail] SMTP не настроен. Письмо для ${to}: ${msg.subject}`);
    return;
  }
  await t.sendMail({ from: env.MAIL_FROM || env.SMTP_USER, to, subject: msg.subject, text: msg.text, html: msg.html });
}

module.exports = { sendCode, mailConfigured: () => !!env.SMTP_HOST };
