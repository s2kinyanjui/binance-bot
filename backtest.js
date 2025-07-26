import WebSocket from "ws"
import { MainClient } from "binance"
import qrcode from "qrcode-terminal"
import { Client as WhatsAppClient } from "whatsapp-web.js"

// ========== 🔐 Setup ==========
const API_KEY = process.env.BINANCE_API_KEY
const API_SECRET = process.env.BINANCE_API_SECRET
const client = new MainClient({ api_key: API_KEY, api_secret: API_SECRET })

// ========== 🎯 Config ==========
const BUDGET = 30
const TARGET_GAIN = 1.03
const ALLOWABLE_NEGATIVES = 2 // Change to 3
const BUY_PERCENT = -4 // Change to -4
const symbols = ["AR", "AAVE", "JTO", "BTC", "SOL"].map((s) => s + "USDT")

let position = null // { symbol, entryPrice, quantity, quoteId }
let buying = false
let selling = false

const balances = {
  USDT: 30,
  AR: 0,
  AAVE: 0,
  JTO: 0,
  BTC: 0,
  SOL: 0,
}

// =========== Whatsapp setup ===============

const waClient = new WhatsAppClient({
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
})

waClient.on("qr", (qr) => qrcode.generate(qr, { small: true }))
waClient.on("ready", () => console.log("✅ WhatsApp ready"))
waClient.initialize()

async function sendWhatsAppMessage(msg) {
  const number = "254748920306" // Replace with your number
  const chatId = number + "@c.us"
  await waClient.sendMessage(chatId, msg)
}

// ========== 📈 Track 24h % Change ==========
const priceChange = {}
const lastPrices = {}

// ========== 🔗 WebSocket ==========
const streams = symbols.map((s) => s.toLowerCase() + "@miniTicker").join("/")
const WS_URL = `wss://stream.binance.com:9443/stream?streams=${streams}`

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
  const rawQty = BUDGET / price
  const precision = stepSize.toString().split(".")[1]?.length || 0
  return parseFloat(rawQty.toFixed(precision))
}

// ========= Simualate spread ===========
function getSimulatedPrices(symbol) {
  const marketPrice = lastPrices[symbol]
  const spreadPercent = 0.002 // 0.2%

  const ask = marketPrice * (1 + spreadPercent / 2) // Buy price
  const bid = marketPrice * (1 - spreadPercent / 2) // Sell price

  return { ask, bid }
}

// ========== 🔄 Poll Order Status ==========
async function waitForOrderSuccess(quoteId) {
  console.log("⏳ Waiting for order:", quoteId)
  let status = "PENDING"

  while (status !== "SUCCESS") {
    try {
      const result = await client.getOrderStatus({ quoteId })
      status = result.orderStatus
      console.log(`🔄 Status: ${status}`)
      if (status === "FAILED") {
        console.error("❌ Order failed")
        break
      }
    } catch (err) {
      console.error("❌ Polling error:", err.body || err.message)
    }
    await new Promise((res) => setTimeout(res, 3000))
  }

  if (status === "SUCCESS") {
    console.log("✅ Order SUCCESS")
  }
}

// ========== 📉 Place Buy ==========
async function placeBuy(symbol, price) {
  const baseAsset = symbol.replace("USDT", "")
  const quoteAsset = "USDT"
  const quantity = await calculateQuantity(symbol, price)
  const { ask } = getSimulatedPrices(symbol)

  try {
    // For testing only
    console.log(
      `🟢 Buying ${baseAsset}  , Quantity : ${quantity} ->  ${{
        baseAsset,
        quoteAsset,
        limitPrice: price * 0.95,
        quoteAmount: BUDGET,
        side: "BUY",
        expiredType: "1_D",
      }}`
    )

    position = {
      symbol,
      entryPrice: ask,
      quoteId: null,
      quantity,
    }

    balances.USDT -= ask * quantity
    balances[baseAsset] += quantity

    await sendWhatsAppMessage(
      `🟢 Bought ${quantity} ${baseAsset} at $${ask.toFixed(
        2
      )}\nNew USDT Balance: $${balances.USDT.toFixed(2)}`
    )

    // const res = await client.submitConvertLimitOrder({
    //   baseAsset,
    //   quoteAsset,
    //   limitPrice: price * 0.95,
    //   quoteAmount: BUDGET,
    //   side: "BUY",
    //   expiredType: "1_D",
    // })

    // console.log(`🟢 Buying ${baseAsset} (~$${price * 0.95}) with $${BUDGET}`)
    // position = {
    //   symbol,
    //   limitPrice: price * 0.95,
    //   entryPrice: price,
    //   quoteId: res.quoteId,
    //   quantity,
    // }

    // await waitForOrderSuccess(res.quoteId)
  } catch (err) {
    console.error("❌ Buy error:", err.body || err.message)
  }
}

// ========== 💰 Place Sell ==========
async function placeSell(symbol, quantity, price) {
  const baseAsset = symbol.replace("USDT", "")
  const quoteAsset = "USDT"
  const { bid } = getSimulatedPrices(symbol)

  const sellValue = bid * quantity

  balances[baseAsset] -= quantity
  balances.USDT += sellValue

  console.log({
    baseAsset,
    quoteAsset,
    limitPrice: price * TARGET_GAIN,
    baseAmount: quantity,
    side: "SELL",
    expiredType: "1_D",
  })

  try {
    // For testing only
    console.log(
      `🟢 Selling ${baseAsset}  , Quantity : ${quantity} ->  ${{
        baseAsset,
        quoteAsset,
        limitPrice: price * TARGET_GAIN,
        baseAmount: quantity,
        side: "SELL",
        expiredType: "1_D",
      }}`
    )

    position = null

    await sendWhatsAppMessage(
      `🟢 Sold ${quantity} ${baseAsset} at $${bid.toFixed(
        2
      )}\nNew USDT Balance: $${balances.USDT.toFixed(2)}`
    )

    // const res = await client.submitConvertLimitOrder({
    //   baseAsset,
    //   quoteAsset,
    //   limitPrice: price * TARGET_GAIN,
    //   baseAmount: quantity,
    //   side: "SELL",
    //   expiredType: "1_D",
    // })

    // console.log(`🟢 Selling ${quantity} ${baseAsset}`)
    // await waitForOrderSuccess(res.quoteId)

    // position = null
  } catch (err) {
    console.error("❌ Sell error:", err.body || err.message)
  }
}

// ========== 🧠 Strategy Logic ==========
function startWatcher() {
  const ws = new WebSocket(WS_URL)

  ws.on("open", () => console.log("🟢 Connected to Binance WS"))
  ws.on("error", (err) => console.error("WS Error:", err))
  ws.on("close", () => {
    console.log("⚠️ WebSocket closed — reconnecting...")
    setTimeout(startWatcher, 5000)
  })

  ws.on("message", async (msg) => {
    try {
      const { data } = JSON.parse(msg)
      const { s: symbol, c, o } = data
      const currentPrice = parseFloat(c)
      const openPrice = parseFloat(o)
      const changePct = ((currentPrice - openPrice) / openPrice) * 100

      priceChange[symbol] = changePct
      lastPrices[symbol] = currentPrice

      console.log(`${symbol}: ${changePct.toFixed(2)}%`)

      // 💰 Sell Condition
      if (!selling && position && position.symbol === symbol) {
        const { bid } = getSimulatedPrices(symbol)

        // const gain = currentPrice / position.entryPrice
        const gain = bid / position.entryPrice
        if (gain >= TARGET_GAIN) {
          selling = true
          await placeSell(symbol, position.quantity, position.entryPrice)
          selling = false
        }
        return
      }

      // 🛒 Buy Condition
      //   const negSymbols = symbols.filter((s) => priceChange[s] < 0)
      const negSymbols = symbols
      if (!position && !buying && negSymbols.length >= ALLOWABLE_NEGATIVES) {
        const target = negSymbols.reduce((acc, sym) => {
          if (
            priceChange[sym] <= BUY_PERCENT &&
            (!acc || priceChange[sym] < priceChange[acc])
          )
            return sym
          return acc
        }, null)

        if (target) {
          buying = true
          await placeBuy(target, lastPrices[target])

          buying = false
        }
      }
    } catch (err) {
      console.error("❌ Parse error:", err)
      buying = false
      selling = false
    }
  })
}

// 🚀 Launch
startWatcher()
