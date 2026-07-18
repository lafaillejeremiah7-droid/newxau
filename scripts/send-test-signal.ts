/**
 * One-shot test script: sends an example trading signal to Telegram via Bot API.
 * Usage: npx tsx scripts/send-test-signal.ts
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const CHAT_ID = '7040023207';

const message = `⚠️ <b>TEST ONLY — NOT A REAL TRADING SIGNAL</b>

<b>Purpose:</b> Verify Telegram delivery. Do not trade from this message.

<b>Example:</b> XAU/USD SHORT

<b>Entry:</b> 2387.45
<b>Stop Loss:</b> 2389.95
<b>TP1:</b> 2385.70 (Safety Lock 45%)
<b>TP2:</b> 2380.95 (Runner 55%)

<b>Zone:</b> Expansion Zone (3.0R)
<b>Risk:</b> $52.50 (1.05% equity)
<b>R-Unit:</b> 2.50 pips

<b>Reasoning:</b> Bearish shooting star at H1 structural high with M5 expansion confirmation. Volume expanding above 20-SMA. Clean retracement to 9/21 EMA confluence zone.

<b>Management:</b>
• Move SL to breakeven after TP1 hit
• Trail stop on Ticket 2 using M5 swing structure
• Do NOT move stop before TP1 is secured`;

async function main() {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  const body = JSON.stringify({
    chat_id: CHAT_ID,
    text: message,
    parse_mode: 'HTML',
  });

  console.log('Sending test signal to Telegram...');
  console.log(`Chat ID: ${CHAT_ID}`);
  console.log('---');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    const data = await response.json();

    if (response.ok && data.ok) {
      console.log('✅ Message sent successfully!');
      console.log(`Message ID: ${data.result.message_id}`);
      console.log(`Date: ${new Date(data.result.date * 1000).toISOString()}`);
    } else {
      console.error('❌ Failed to send message.');
      console.error(`Status: ${response.status} ${response.statusText}`);
      console.error('Response:', JSON.stringify(data, null, 2));
    }
  } catch (error) {
    console.error('❌ Error sending message:', error);
  }
}

main();
