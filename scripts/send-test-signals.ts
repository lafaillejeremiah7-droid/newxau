const BOT_TOKEN = '8926622863:AAF0QHHYAyEVQZiYV35b5vyeKxDC_ouMnmQ';
const CHAT_ID = '7040023207';

async function sendTelegramMessage(text: string): Promise<boolean> {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
    }),
  });
  const data = await response.json();
  console.log('Response:', JSON.stringify(data, null, 2));
  return data.ok;
}

function getCurrentUTCTime(): string {
  return new Date().toUTCString().replace('GMT', 'UTC');
}

async function main() {
  const currentTime = getCurrentUTCTime();

  const longSignal = `🟢 <b>ISAGI ENGINE — LONG SIGNAL</b> 🟢
━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 <b>Instrument:</b> XAU/USD
⏱ <b>Timeframe:</b> M5
🕐 <b>Time:</b> ${currentTime}

━━━━━━━━━━━━━━━━━━━━━━━━━━━

💰 <b>Entry:</b> 2,645.80
🛑 <b>Stop Loss:</b> 2,643.30 (-2.50)
✅ <b>TP1 (Safety Lock - 45%):</b> 2,647.55
🎯 <b>TP2 (Runner - 55%):</b> 2,653.30

━━━━━━━━━━━━━━━━━━━━━━━━━━━

📈 <b>Zone:</b> Expansion Zone (3.0R)
💵 <b>Risk:</b> $35.00
📐 <b>R-Unit:</b> 2.50

━━━━━━━━━━━━━━━━━━━━━━━━━━━

📝 <b>Reasoning:</b> H1 liquidity zone sweep at 2643. M5 bullish rejection hammer after 3-candle absorption. Volume expanding. Entry at structural window confirmation.

⚡ <b>Breakeven:</b> Move SL to entry when TP1 hit
📏 <b>Trail:</b> M5 swing low after breakeven

━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ <b>TEST SIGNAL — DO NOT TRADE</b> ⚠️`;

  const shortSignal = `🔴 <b>ISAGI ENGINE — SHORT SIGNAL</b> 🔴
━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 <b>Instrument:</b> XAU/USD
⏱ <b>Timeframe:</b> M5
🕐 <b>Time:</b> ${currentTime}

━━━━━━━━━━━━━━━━━━━━━━━━━━━

💰 <b>Entry:</b> 2,658.40
🛑 <b>Stop Loss:</b> 2,660.90 (+2.50)
✅ <b>TP1 (Safety Lock - 45%):</b> 2,656.65
🎯 <b>TP2 (Runner - 55%):</b> 2,650.90

━━━━━━━━━━━━━━━━━━━━━━━━━━━

📈 <b>Zone:</b> Chop Zone (1.5R)
💵 <b>Risk:</b> $35.00
📐 <b>R-Unit:</b> 2.50

━━━━━━━━━━━━━━━━━━━━━━━━━━━

📝 <b>Reasoning:</b> M15 structural high rejection. Shooting star at 2661 with decreasing volume. Retracement complete (3 candles). Bearish engulfing confirmation.

⚡ <b>Breakeven:</b> Move SL to entry when TP1 hit
📏 <b>Trail:</b> M5 swing high after breakeven

━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ <b>TEST SIGNAL — DO NOT TRADE</b> ⚠️`;

  console.log('📤 Sending Long Signal...');
  const longResult = await sendTelegramMessage(longSignal);
  console.log(longResult ? '✅ Long signal sent successfully!' : '❌ Failed to send long signal');

  // 2-second delay between messages
  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log('📤 Sending Short Signal...');
  const shortResult = await sendTelegramMessage(shortSignal);
  console.log(shortResult ? '✅ Short signal sent successfully!' : '❌ Failed to send short signal');

  console.log('\n🏁 Done! Both test signals sent.');
}

main().catch(console.error);
