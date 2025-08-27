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
  USDT: 30,
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
    `🟢 Bought AR @ ${price.toFixed(
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
    `🔴 Sold AR @ ${price.toFixed(
      4
    )}\n Reason: ${reason}\n Received $${usdtReceived.toFixed(
      2
    )}\n USDT: $${balances.USDT.toFixed(2)}\n AR: ${balances.AR.toFixed(2)}`
  )
}

function roundUp2(num) {
  return Math.ceil(num * 100) / 100
}

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

    console.log("message received")

    // Candle data
    if (msg.e === "kline") {
      const {
        k: { x: isClosed, c },
      } = msg

      if (isClosed) {
        const closePrice = parseFloat(c)

        closes.push(closePrice)

        if (closes.length > 25) {
          closes.shift()
        }
      }
    }

    // Trade data
    if (msg.e === "trade") {
      const priceNow = parseFloat(msg.p)

      // Price changed
      if (priceNow !== latestPrice) {
        latestPrice = priceNow
        console.log("Current price:", priceNow)

        if (closes.length > 20) {
          const MA3 = roundUp2(
            ti.SMA.calculate({
              period: 3,
              values: closes.slice(-3),
            })[0]
          )

          const MA20 = roundUp2(
            ti.SMA.calculate({
              period: 20,
              values: closes.slice(-20),
            })[0]
          )

          console.log({
            MA3,
            MA20,
            priceNow,
          })

          // If MA3 > MA20 , convert to AR

          if (MA3 > MA20 && balances.USDT > 10) {
            toAR(priceNow)
          }

          if (balances.AR > 0 && entryPrice) {
            const takeProfit = entryPrice * 1.005 // +0.5%
            const stopLoss = entryPrice * 0.995 // -0.5%

            if (price >= takeProfit) {
              await fromAR(price, "Take Profit (+0.5%)")
            } else if (price <= stopLoss) {
              await fromAR(price, "Stop Loss (-0.5%)")
            } else if (MA3 < MA20) {
              await fromAR(price, "MA3 crossed below MA20")
            }
          }
        }
      }
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
