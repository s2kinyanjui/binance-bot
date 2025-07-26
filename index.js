import WebSocket from "ws"
import { MainClient } from "binance"

// ========== 🔐 Setup ==========
const API_KEY = process.env.BINANCE_API_KEY
const API_SECRET = process.env.BINANCE_API_SECRET
const client = new MainClient({ api_key: API_KEY, api_secret: API_SECRET })

// ========== 🎯 Config ==========
const BUDGET = 30
const TARGET_GAIN = 1.03
const ALLOWABLE_NEGATIVES = 1
const BUY_PERCENT = -0.005
const symbols = ["AR", "AAVE", "JTO", "BTC", "SOL"].map((s) => s + "USDT")

let position = null // { symbol, entryPrice, quantity, quoteId }

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
  const precision = Math.max(0, stepSize.toString().indexOf("1") - 1)
  return parseFloat(rawQty.toFixed(precision))
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
      limitPrice: price * 0.95,
      entryPrice: price,
      quoteId: res.quoteId,
      quantity,
    }

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
async function placeSell(symbol, quantity) {
  const baseAsset = symbol.replace("USDT", "")
  const quoteAsset = "USDT"

  console.log({
    baseAsset,
    quoteAsset,
    limitPrice: price * 1.03,
    baseAmount: quantity,
    side: "SELL",
    expiredType: "1_D",
  })

  try {
    const res = await client.submitConvertLimitOrder({
      baseAsset,
      quoteAsset,
      limitPrice: price * TARGET_GAIN,
      baseAmount: quantity,
      side: "SELL",
      expiredType: "1_D",
    })

    console.log(`🟢 Selling ${quantity} ${baseAsset}`)
    await waitForOrderSuccess(res.quoteId)

    position = null
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
      if (position && position.symbol === symbol) {
        const gain = currentPrice / position.entryPrice
        if (gain >= TARGET_GAIN) {
          await placeSell(symbol, position.quantity)
        }
        return
      }

      // 🛒 Buy Condition
      const negSymbols = symbols.filter((s) => priceChange[s] < 0)
      if (!position && negSymbols.length >= ALLOWABLE_NEGATIVES) {
        const target = negSymbols.reduce((acc, sym) => {
          if (
            priceChange[sym] <= BUY_PERCENT &&
            (!acc || priceChange[sym] < priceChange[acc])
          )
            return sym
          return acc
        }, null)

        if (target) {
          await placeBuy(target, lastPrices[target])
        }
      }
    } catch (err) {
      console.error("❌ Parse error:", err)
    }
  })
}

// 🚀 Launch
startWatcher()
