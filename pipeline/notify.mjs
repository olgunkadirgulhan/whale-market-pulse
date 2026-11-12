// kullanıcı isteği (2026-11-12): TR 21:00–09:00 arası bildirim sessiz gelsin
const quietHours = () => { const h = (new Date().getUTCHours() + 3) % 24; return h >= 21 || h < 9; };
export async function notify(text) {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
        disable_notification: quietHours(),
      }),
    });
  } catch (err) {
    console.warn(`Telegram notify failed: ${err.message}`);
  }
}
