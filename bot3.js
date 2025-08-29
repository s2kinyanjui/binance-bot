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

const closes = []
let latestPrice = null
let latestCandleTime = null

let crossedDown = false
let entryPrice = null
let balances = {
  USDT: 100,
  AR: 0,
}

let priceFalling = false
let priceRising = false

async function sendTelegramMessage(msg) {
  await tgBot.sendMessage(TELEGRAM_CHAT_ID, msg)
}

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
    `🟢Bot 3: Bought AR @ ${price.toFixed(
      4
    )}\n Qty: ${quantity}\n\n USDT: ${balances.USDT.toFixed(
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
    `🔴Bot 3: Sold AR @ ${price.toFixed(
      4
    )}\n Reason: ${reason}\n Received $${usdtReceived.toFixed(
      2
    )}\n\n USDT: $${balances.USDT.toFixed(2)}\n AR: ${balances.AR.toFixed(2)}`
  )
}

function roundUp2(num) {
  return Math.ceil(num * 100) / 100
}

// ========== 📈 Price Watcher ==========
function startWatcher() {
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

  // State

  ws.on("message", async (data) => {
    const received = JSON.parse(data)
    const msg = received.data

    // === Candle data (kline) ===
    if (msg.e === "kline") {
      const {
        k: { c, x, t },
      } = msg

      const closePrice = parseFloat(c)

      if (x) {
        // Candle just closed
        if (!latestCandleTime || latestCandleTime !== t) {
          latestCandleTime = t

          console.log("Candle closed:", closePrice)

          // Remove oldest if we already have 25
          if (closes.length >= 25) closes.shift()

          // Push the closed candle
          closes.push(closePrice)
        }
      } else {
        // Candle still forming → update last element
        if (closes.length === 0) {
          closes.push(closePrice)
        } else {
          closes[closes.length - 1] = closePrice
        }
      }
    }

    // === Trade data (do NOT modify closes) ===
    if (msg.e === "trade") {
      const priceNow = parseFloat(msg.p)

      if (priceNow !== latestPrice) {
        latestPrice = priceNow

        // Only calculate SMA if we have enough candles
        if (closes.length > 22) {
          // SMA3 old , prev , curr calculation
          const sma3_old = roundUp2(
            ti.SMA.calculate({
              period: 3,
              values: closes.slice(-5, -2),
            })[0]
          )

          const sma3_prev = roundUp2(
            ti.SMA.calculate({
              period: 3,
              values: closes.slice(-4, -1),
            })[0]
          )

          const sma3_curr = roundUp2(
            ti.SMA.calculate({
              period: 3,
              values: closes.slice(-3),
            })[0]
          )

          // SMA20 old , prev , curr calulation
          const sma20_old = roundUp2(
            ti.SMA.calculate({
              period: 20,
              values: closes.slice(-22, -2),
            })[0]
          )

          const sma20_prev = roundUp2(
            ti.SMA.calculate({
              period: 20,
              values: closes.slice(-21, -1),
            })[0]
          )

          const sma20_curr = roundUp2(
            ti.SMA.calculate({
              period: 20,
              values: closes.slice(-20),
            })[0]
          )

          // Buy Conditions

          if (sma3_prev >= sma20_prev && sma3_curr < sma20_curr) {
            crossedDown = true
          }

          if (sma3_curr > sma20_curr && sma3_prev <= sma20_prev) {
            crossedDown = false
          }

          if (
            sma3_curr > sma3_prev &&
            sma3_prev > sma3_old &&
            sma20_old > sma20_prev &&
            sma20_prev > sma20_curr
          ) {
            priceRising = true
          }

          if (sma3_curr < sma3_prev && sma3_prev < sma3_old) {
            priceFalling = true
          }

          console.log({
            sma3_old,
            sma3_prev,
            sma3_curr,
            sma20_old,
            sma20_prev,
            sma20_curr,
            crossedDown,
            priceRising,
            priceFalling,
            entryPrice,
          })

          if (priceRising && crossedDown && !entryPrice) {
            await toAR(priceNow)
          }

          // Sell condition

          if (entryPrice && priceFalling) {
            await fromAR(priceNow, `Price falling`)
          }
        }
      }
    }
  })
}

// ========== 🚀 Start ==========

async function startBot() {
  await sendTelegramMessage(
    "🚀 Binance Telegram bot 3 has started and is watching prices..."
  )
  startWatcher()
}

startBot()
