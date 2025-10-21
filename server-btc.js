// server-btc.js
// Watch a single BTC or Testnet address and credit balance when confirmed.
// Compatible with LowDB v3+ (ESM) and Render deployment.

import express from "express";
import http from "http";
import axios from "axios";
import { Server as SocketIOServer } from "socket.io";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import path from "path";
import { fileURLToPath } from "url";

// ----------------------
// Environment Variables
// ----------------------
const BTC_ADDRESS = process.env.BTC_ADDRESS; // your BTC or testnet address
const NETWORK = process.env.NETWORK || "testnet"; // "mainnet" or "testnet"
const PORT = process.env.PORT || 3000;
const REQUIRED_CONFIRMATIONS = parseInt(process.env.CONFIRMATIONS || "1", 10);

if (!BTC_ADDRESS) {
  console.error("❌ ERROR: Set BTC_ADDRESS environment variable to your deposit address.");
  process.exit(1);
}

// ----------------------
// Path & Database Setup
// ----------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbFile = path.join(process.cwd(), "db.json");

const adapter = new JSONFile(dbFile);
const defaultData = { deposits: [], balanceSats: 0 };
const db = new Low(adapter, defaultData);

async function initDb() {
  await db.read();
  db.data ||= defaultData;
  await db.write();
}

// ----------------------
// Blockstream API Helper
// ----------------------
function blockstreamUrl(suffix) {
  return NETWORK === "mainnet"
    ? `https://blockstream.info/api${suffix}`
    : `https://blockstream.info/testnet/api${suffix}`;
}

// ----------------------
// App Initialization
// ----------------------
await initDb();

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/account", async (req, res) => {
  await db.read();
  res.json({
    balanceBTC: (db.data.balanceSats / 1e8).toFixed(8),
    deposits: db.data.deposits
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

// ----------------------
// BTC Transaction Watcher
// ----------------------
async function fetchTxs() {
  try {
    const url = blockstreamUrl(`/address/${BTC_ADDRESS}/txs`);
    const res = await axios.get(url);
    return res.data || [];
  } catch (err) {
    console.error("⚠️ Error fetching txs:", err.message);
    return [];
  }
}

async function fetchTxStatus(txid) {
  try {
    const url = blockstreamUrl(`/tx/${txid}/status`);
    const res = await axios.get(url);
    return res.data || {};
  } catch (err) {
    console.error("⚠️ Error fetching status:", err.message);
    return {};
  }
}

async function checkDeposits() {
  const txs = await fetchTxs();

  for (const tx of txs) {
    const txid = tx.txid;
    const outputs = tx.vout || [];
    let valueSats = 0;

    outputs.forEach(out => {
      if (out.scriptpubkey_address === BTC_ADDRESS) {
        valueSats += out.value;
      }
    });

    if (valueSats > 0) {
      await db.read();
      const already = db.data.deposits.find(d => d.txid === txid);
      if (already) continue;

      const status = await fetchTxStatus(txid);
      if (status.confirmed) {
        const deposit = {
          txid,
          amountSats: valueSats,
          amountBTC: valueSats / 1e8,
          creditedAt: new Date().toISOString()
        };

        db.data.deposits.push(deposit);
        db.data.balanceSats += valueSats;
        await db.write();

        io.emit("deposit", deposit);
        console.log("✅ Credited:", deposit);
      } else {
        console.log(`⏳ Pending tx ${txid}, not confirmed yet`);
      }
    }
  }
}

// ----------------------
// Poll every 30s
// ----------------------
setInterval(checkDeposits, 30000);
checkDeposits();
