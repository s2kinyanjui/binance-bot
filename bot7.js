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
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID
const tgBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false })

async function sendTelegramMessage(msg) {
  await tgBot.sendMessage(TELEGRAM_CHAT_ID, msg)
}

const balances = {
  USDT: 100,
  AR: 0,
}
let entryPrice = null
let lastUpdate = null // ✅ initialized

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

  const rawQty = balances.USDT / price
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
  entryPrice = price

  await sendTelegramMessage(
    `🟢Bot 7: Bought AR @ ${price.toFixed(4)}\n Qty: ${quantity}\n\n USDT: ${balances.USDT.toFixed(2)}\n AR: ${balances.AR.toFixed(2)}`
  )
}

// ========== 💰 Convert from AR ==========
async function fromAR(price, reason) {
  const usdtReceived = balances.AR * price
  balances.USDT += usdtReceived
  balances.AR = 0
  entryPrice = null

  await sendTelegramMessage(
    `🔴Bot 7 : Sold AR @ ${price.toFixed(4)}\n Reason: ${reason}\n Received $${usdtReceived.toFixed(2)}\n\n USDT: $${balances.USDT.toFixed(2)}\n AR: ${balances.AR.toFixed(2)}`
  )
}

function roundUp2(num) {
  return Math.ceil(num * 100) / 100
}

// Helper: linear regression slope
function regressionSlope(values) {
  const n = values.length
  const avgX = (n - 1) / 2
  const avgY = values.reduce((a, b) => a + b, 0) / n

  let num = 0, den = 0
  values.forEach((y, i) => {
    num += (i - avgX) * (y - avgY)
    den += (i - avgX) ** 2
  })

  return num / den
}

let crossedDown = false

// ========== 📈 Price Watcher ==========
function startWatcher() {
  const closes = []
  let latestPrice = null

  const ws = new WebSocket(
    "wss://stream.binance.com:9443/stream?streams=arusdt@kline_3m/arusdt@trade"
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

    // Candle data
    if (msg.e === "kline") {
      const {
        k: { c, x },
      } = msg

      if (x) {
        const closePrice = parseFloat(c)

        if (lastUpdate === "tradePrice") {
          closes[closes.length - 1] = closePrice
        } else {
          closes.push(closePrice)
        }
        lastUpdate = "candleClose"

        if (closes.length > 25) {
          closes.shift()
        }
      }
    }

    // Trade data
    if (msg.e === "trade") {
      const priceNow = parseFloat(msg.p)

      if (priceNow !== latestPrice) {
        latestPrice = priceNow
        console.log("Current price:", priceNow)

        if (lastUpdate === "tradePrice") {
          closes[closes.length - 1] = priceNow
        } else {
          closes.push(priceNow)
        }
        lastUpdate = "tradePrice"

        let closesNow = closes
        console.log(closesNow)

        if (closesNow.length > 22) {
          const shortMA = ti.SMA.calculate({
            period: 3,
            values: closesNow.slice(-3),
          })[0]

          const longMA = ti.SMA.calculate({
            period: 20,
            values: closesNow.slice(-20),
          })[0]

          const pastMA = ti.SMA.calculate({
            period: 3,
            values: closesNow.slice(-7, -4),
          })[0]

          if (
            shortMA < longMA &&
            (pastMA - shortMA) / pastMA > 0.01 &&
            !entryPrice &&
            regressionSlope(closes.slice(-5)) < 0
          ) {
            await toAR(priceNow)
          }

          if (entryPrice && priceNow >= entryPrice * 1.005) {
            await fromAR(priceNow, `Target reached`)
          }
        }
      }
    }
  })
}

// ========== 🚀 Start ==========
async function startBot() {
  await sendTelegramMessage(
    "🚀 Binance Telegram bot 2 has started and is watching prices..."
  )
  startWatcher()
}

startBot()
