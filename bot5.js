import WebSocket from "ws"
import { MainClient } from "binance"
import dotenv from "dotenv"
import TelegramBot from "node-telegram-bot-api"
import ti from "technicalindicators"

dotenv.config()

// ========== 🔐 Setup ==========
const API_KEY = process.env.BINANCE_API_KEY
const API_SECRET = process.env.BINANCE_API_SECRET
const client = new MainClient({ api_key: API_KEY, api_secret: API_SECRET })

// ========== 📲 Telegram Setup ==========
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID // Your chat ID (can be your user ID or a group ID)
const tgBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false })

async function sendTelegramMessage(msg) {
  await tgBot.sendMessage(TELEGRAM_CHAT_ID, msg)
}

const balances = {
  USDT: 100,
  AR: 0,
}
let entryPrice = null

// ========== ⚙️ Step Size ==========
async function getStepSize(symbol) {
  const { symbols } = await client.getExchangeInfo()
  const info = symbols.find((s) => s.symbol === symbol)
  const lotSize = info.filters.find((f) => f.filterType === "LOT_SIZE")
  return parseFloat(lotSize.stepSize)
}

// ========== 🧮 Quantity ==========
async function calculateQuantity(price) {
  let symbol = "ARUSDT"

  const stepSize = await getStepSize(symbol)
  const precision = stepSize.toString().split(".")[1]?.length || 0

const rawQty = balances.USDT / price // ARs to buy
  const factor = Math.pow(10, precision)
  const flooredQty = Math.floor(rawQty * factor) / factor
  if (flooredQty < stepSize) return null
  return parseFloat(flooredQty.toFixed(precision))
}

// ========== 📉 Convert to AR ==========
async function toAR(price) {
  const quantity = await calculateQuantity(price)
  if (!quantity) return

  balances.USDT -= quantity * price
  balances.AR += quantity
  entryPrice = price // save buy price

  await sendTelegramMessage(
    `🟢Bot 5: Bought AR @ ${price.toFixed(
      4
    )}\n Qty: ${quantity}\n USDT: ${balances.USDT.toFixed(
      2
    )}\n AR: ${balances.AR.toFixed(2)}`
  )
}

// ========== 💰 Convert from AR ==========
async function fromAR(price, reason) {
  const usdtReceived = balances.AR * price
  balances.USDT += usdtReceived
  balances.AR = 0
  entryPrice = null

  await sendTelegramMessage(
    `🔴Bot 5: Sold AR @ ${price.toFixed(
      4
    )}\n Reason: ${reason}\n Received $${usdtReceived.toFixed(
      2
    )}\n USDT: $${balances.USDT.toFixed(2)}\n AR: ${balances.AR.toFixed(2)}`
  )
}

// Helper: round to 3 decimals
function round3(num) {
  return Math.round(num * 1000) / 1000
}

// ========== 📈 Price Watcher ==========
function startWatcher() {
  const closes = []
  let latestPrice = null

  const ws = new WebSocket(
    "wss://stream.binance.com:9443/stream?streams=arusdt@trade"
  )

  ws.on("open", () => console.log("Connected to Binance"))

  ws.on("close", () => {
    console.log("Disconnected...")
    closes.length = 0
    setTimeout(startWatcher, 2000)
  })

  ws.on("error", (err) => console.error("WebSocket error:", err))

  ws.on("message", async (data) => {
    const received = JSON.parse(data)
    const msg = received.data

    // Only trade events
    if (msg.e === "trade") {
      const priceNow = parseFloat(msg.p)

      if (priceNow !== latestPrice) {
        latestPrice = priceNow
        closes.push(priceNow)

        // keep only latest 25 prices
        if (closes.length > 25) closes.shift()

        if (closes.length > 22) {
          const b3 = round3(
            ti.SMA.calculate({
              period: 3,
              values: closes.slice(-4, -1),
            })[0]
          )

          const c3 = round3(
            ti.SMA.calculate({
              period: 3,
              values: closes.slice(-3),
            })[0]
          )

          const b20 = round3(
            ti.SMA.calculate({
              period: 20,
              values: closes.slice(-21, -1),
            })[0]
          )

          const c20 = round3(
            ti.SMA.calculate({
              period: 20,
              values: closes.slice(-20),
            })[0]
          )

          // Detect crossovers
          if (b3 >= b20 && c3 < c20) {
            crossedDown = true
          }

          if (c3 > c20 && b3 <= b20) {
            crossedDown = false
          }

          // ✅ Buy condition
          if (
            crossedDown &&
            balances.USDT > 10 &&
            !entryPrice &&
            priceNow < c3 - 0.015
          ) {
            await toAR(priceNow)
          }

          // ✅ Sell condition
          if (balances.AR > 5 && priceNow > c3 + 0.015) {
            await fromAR(priceNow, `Reversal`)
          }
        }
      }
    }
  })
}

// ========== 🚀 Start ==========

async function startBot() {
  await sendTelegramMessage(
    "🚀 Bot 5 has started"
  )
  startWatcher()
}

startBot()
