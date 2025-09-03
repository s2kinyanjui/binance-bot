import WebSocket from "ws"
import { MainClient } from "binance"
import dotenv from "dotenv"
import TelegramBot from "node-telegram-bot-api"
import ti from "technicalindicators"

dotenv.config()

// ========== 🔐 Binance Client Setup ==========
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

// ========= Variables ============
let candles = []

// ========== Helpers ============

function majority(trends, letter) {
  return trends.filter((t) => t === letter).length
}

// ========== 📈 Price Watcher ==========
function startWatcher() {
  const ws = new WebSocket(
    "wss://stream.binance.com:9443/stream?streams=arusdt@kline_15m/arusdt@trade"
  )

  ws.on("open", () => console.log("Connected to Binance"))

  ws.on("close", () => {
    console.log("❌ Disconnected... retrying")
    setTimeout(() => startWatcher(), 2000)
  })

  ws.on("error", (err) => console.error("WebSocket error:", err))

  ws.on("message", async (data) => {
    const { data: msg } = JSON.parse(data)

    // Incoming candle
    if (msg.e === "kline") {
      const k = msg.k

      if (k.x) {
        // Candle closed
        const open = parseFloat(k.o)
        const high = parseFloat(k.h)
        const low = parseFloat(k.l)
        const close = parseFloat(k.c)

        const x1 = (open + close) / 2
        const x2 = (high + low) / 2
        const color = open > close ? "R" : open < close ? "G" : "E"

        const newCandle = {
          open,
          high,
          low,
          close,
          x1,
          x2,
          color,
          trendx1: null,
          trendx2: null,
        }

        // Update previous candle trends
        if (candles.length > 0) {
          const prev = candles[candles.length - 1]

          // trendx1
          if (newCandle.x1 > prev.x1) prev.trendx1 = "U"
          else if (newCandle.x1 < prev.x1) prev.trendx1 = "D"
          else prev.trendx1 = "E"

          // trendx2
          if (newCandle.x2 > prev.x2) prev.trendx2 = "U"
          else if (newCandle.x2 < prev.x2) prev.trendx2 = "D"
          else prev.trendx2 = "E"
        }

        candles.push(newCandle)

        // keep only 8
        if (candles.length > 8) candles.shift()

        console.log("\n📊 Current Candles:")
        console.table(candles)

        // analyze only if we have at least 7  candles
        if (candles.length >= 7) analyzeCandles()
      }
    }
  })
}

// ========== 📈 Strategy ==========
async function analyzeCandles() {
  const latest = candles[candles.length - 1]
  const prevCandles = candles.slice(0, -1)

  const trendx1s = prevCandles.map((c) => c.trendx1).filter(Boolean)
  const trendx2s = prevCandles.map((c) => c.trendx2).filter(Boolean)

  const trendx1D = majority(trendx1s, "D")
  const trendx1U = majority(trendx1s, "U")
  const trendx2D = majority(trendx2s, "D")
  const trendx2U = majority(trendx2s, "U")

  const lastTrendx2 = prevCandles[prevCandles.length - 1]?.trendx2
  const lastColor = latest.color

  const condition =
    trendx2D >= trendx2U &&
    lastTrendx2 === "U" &&
    trendx1D >= trendx1U &&
    (lastColor === "G" || lastColor === "E")

  if (condition) {
    const text = `💰 Buy now between ${latest.close} -> ${latest.high}`
    await sendTelegramMessage(text)
  }
}

// ========== 🚀 Start ==========

async function startBot() {
  await sendTelegramMessage("🚀 Binance buy signal bot started")
  startWatcher()
}

startBot()
