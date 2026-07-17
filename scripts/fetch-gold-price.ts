const TL_BASE_URL = 'https://demo.tradelocker.com/backend-api';
const TL_EMAIL = 'lafaillejeremiah7@gmail.com';
const TL_PASSWORD = ',3)m1U';
const TL_SERVER = 'AQUA';
const TL_ACCOUNT_ID = '2218469';
const TL_ACC_NUM = '2';
const TL_INSTRUMENT_ID = '1714';
const TL_ROUTE_ID = '791554';

const BOT_TOKEN = '8926622863:AAF0QHHYAyEVQZiYV35b5vyeKxDC_ouMnmQ';
const CHAT_ID = '7040023207';

async function authenticate(): Promise<string> {
  const res = await fetch(`${TL_BASE_URL}/auth/jwt/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: TL_EMAIL,
      password: TL_PASSWORD,
      server: TL_SERVER,
    }),
  });
  const data = await res.json();
  console.log('Auth response status:', res.status);
  if (!res.ok || !data.accessToken) {
    console.error('Auth failed:', JSON.stringify(data));
    throw new Error(`Authentication failed: ${res.status}`);
  }
  return data.accessToken;
}

async function fetchQuote(token: string): Promise<{ bid: number; ask: number }> {
  const url = `${TL_BASE_URL}/trade/quotes?tradableInstrumentId=${TL_INSTRUMENT_ID}&routeId=${TL_ROUTE_ID}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'accNum': TL_ACC_NUM,
      'Content-Type': 'application/json',
    },
  });
  const data = await res.json();
  console.log('Quote response:', JSON.stringify(data));
  if (!res.ok || data.s !== 'ok') {
    throw new Error(`Quote fetch failed: ${JSON.stringify(data)}`);
  }
  // API returns: { s: "ok", d: { ap: askPrice, bp: bidPrice, as: askSize, bs: bidSize } }
  return { bid: data.d.bp, ask: data.d.ap };
}

async function sendTelegram(text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
    }),
  });
  const data = await res.json();
  console.log('Telegram response:', JSON.stringify(data));
}

async function main() {
  console.log('🔐 Authenticating with TradeLocker...');
  const token = await authenticate();
  console.log('✅ Authenticated successfully');

  console.log('📊 Fetching XAU/USD quote...');
  const quote = await fetchQuote(token);
  console.log(`✅ Bid: ${quote.bid}, Ask: ${quote.ask}`);

  const spread = ((quote.ask - quote.bid) * 10).toFixed(1);
  const currentTime = new Date().toUTCString().replace('GMT', 'UTC');

  const message = `📊 <b>ISAGI ENGINE — LIVE GOLD PRICE</b> 📊
━━━━━━━━━━━━━━━━━━━━━━━━━━━

🥇 <b>XAU/USD</b>
🕐 <b>Time:</b> ${currentTime}

━━━━━━━━━━━━━━━━━━━━━━━━━━━

💰 <b>Bid:</b> $${quote.bid.toFixed(2)}
💰 <b>Ask:</b> $${quote.ask.toFixed(2)}
📐 <b>Spread:</b> ${spread} pips

━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔗 Source: TradeLocker Demo (AQUA)`;

  console.log('📤 Sending to Telegram...');
  await sendTelegram(message);
  console.log('✅ Done! Price sent to Telegram.');
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
