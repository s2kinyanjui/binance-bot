import WebSocket from "ws"
import { MainClient } from "binance"
import dotenv from "dotenv"
import TelegramBot from "node-telegram-bot-api"

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

// ========== 🎯 Config ==========
const BUDGET = 30
const TARGET_GAIN = 1.02
const symbols = ["AR", "AAVE", "JTO", "BTC", "SOL", "ETH", "XRP", "BNB"].map(
  (s) => s + "USDT"
)

let position = null
let buying = false
let selling = false

const balances = {
  USDT: 30,
  AR: 0,
  AAVE: 0,
  JTO: 0,
  BTC: 0,
  SOL: 0,
  ETH: 0,
  XRP: 0,
  BNB: 0,
}

// ========== ⚙️ Step Size ==========
async function getStepSize(symbol) {
  const { symbols } = await client.getExchangeInfo()
  const info = symbols.find((s) => s.symbol === symbol)
  const lotSize = info.filters.find((f) => f.filterType === "LOT_SIZE")
  return parseFloat(lotSize.stepSize)
}

// ========== 🧮 Quantity ==========
async function calculateQuantity(symbol, price) {
  const stepSize = await getStepSize(symbol)
  const precision = stepSize.toString().split(".")[1]?.length || 0
  const rawQty = BUDGET / price
  const factor = Math.pow(10, precision)
  const flooredQty = Math.floor(rawQty * factor) / factor
  if (flooredQty < stepSize) return null
  return parseFloat(flooredQty.toFixed(precision))
}

// ========== 💹 Spread Simulation ==========
function getSimulatedPrices(price) {
  const spreadPercent = 0.002 // 0.2%
  const ask = price * (1 + spreadPercent / 2)
  const bid = price * (1 - spreadPercent / 2)
  return { ask, bid }
}

// ========== 📉 Place Buy ==========
async function placeBuy(symbol, price) {
  const baseAsset = symbol.replace("USDT", "")
  const quantity = await calculateQuantity(symbol, price)

  if (!quantity) {
    console.log(`❌ Cannot buy ${symbol}: quantity too low for budget`)
    await sendTelegramMessage(
      `❌ Skipped buy: Budget too low to buy ${symbol} at $${price}`
    )
    return
  }

  const { ask } = getSimulatedPrices(price)

  position = {
    symbol,
    entryPrice: ask,
    quoteId: null,
    quantity,
  }
  balances.USDT -= ask * quantity
  balances[baseAsset] += quantity
  console.log(`🟠 Bought ${quantity} ${baseAsset} at $${ask.toFixed(2)}`)
  await sendTelegramMessage(
    `🟠 Bought ${quantity} ${baseAsset} at $${ask.toFixed(
      2
    )}\nNew USDT Balance: $${balances.USDT.toFixed(2)}`
  )
}

// ========== 💰 Place Sell ==========
async function placeSell(symbol, quantity, currentPrice) {
  const baseAsset = symbol.replace("USDT", "")
  const { bid } = getSimulatedPrices(currentPrice)
  const sellValue = bid * quantity
  balances[baseAsset] -= quantity
  balances.USDT += sellValue
  position = null
  console.log(`🟢 Sold ${quantity} ${baseAsset} at $${bid.toFixed(2)}`)
  await sendTelegramMessage(
    `🟢 Sold ${quantity} ${baseAsset} at $${bid.toFixed(
      2
    )}\nNew USDT Balance: $${balances.USDT.toFixed(2)}`
  )
}

// ========== 📈 Price Watcher ==========
const lastPrices = {}
const evaluationMap = new Map()
let evaluateTimer = null

function startWatcher() {
  const streams = symbols.map((s) => s.toLowerCase() + "@ticker").join("/")
  const WS_URL = `wss://stream.binance.com:9443/stream?streams=${streams}`
  const ws = new WebSocket(WS_URL)

  ws.on("open", () => console.log("🟢 Connected to Binance WS"))
  ws.on("error", (err) => console.error("❌ WS Error:", err))
  ws.on("close", () => {
    console.log("⚠️ WebSocket closed — reconnecting...")
    setTimeout(startWatcher, 5000)
  })

  ws.on("message", async (msg) => {
    try {
      const { data } = JSON.parse(msg)
      const { s: symbol, c, h, l } = data
      const currentPrice = parseFloat(c)
      const high = parseFloat(h)
      const low = parseFloat(l)

      const priceRange = high - low
      const first20pctRange = low + priceRange * 0.2
      const withinLower20pct = currentPrice <= first20pctRange
      const projectedPrice = currentPrice * 1.02
      const projectedBelowHigh = projectedPrice <= high

      lastPrices[symbol] = currentPrice

      evaluationMap.set(symbol, {
        symbol,
        currentPrice,
        low,
        withinLower20pct,
        projectedBelowHigh,
      })

      if (!evaluateTimer && !position && !buying) {
        evaluateTimer = setTimeout(async () => {
          const candidates = Array.from(evaluationMap.values()).filter(
            (c) => c.withinLower20pct && c.projectedBelowHigh
          )

          if (candidates.length > 0) {
            const best = candidates.reduce((a, b) => {
              const aDelta = a.currentPrice - a.low
              const bDelta = b.currentPrice - b.low
              return aDelta < bDelta ? a : b
            })

            buying = true
            await placeBuy(best.symbol, best.currentPrice)
            buying = false
          }

          evaluationMap.clear()
          evaluateTimer = null
        }, 1000)
      }

      if (!selling && position && position.symbol === symbol) {
        const { bid } = getSimulatedPrices(currentPrice)
        const gain = bid / position.entryPrice
        if (gain >= TARGET_GAIN) {
          selling = true
          await placeSell(symbol, position.quantity, currentPrice)
          selling = false
        }
      }
    } catch (err) {
      console.error("❌ Parse error:", err)
      buying = false
      selling = false
      evaluationMap.clear()
      clearTimeout(evaluateTimer)
      evaluateTimer = null
    }
  })
}

// ========== 🚀 Start ==========

async function startBot() {
  await sendTelegramMessage(
    "🚀 Binance Telegram bot has started and is watching prices..."
  )
  startWatcher()
}

startBot()
