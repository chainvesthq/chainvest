// server-btc.js
// ChainVest — BTC deposit tracker (compatible with LowDB v6+)

import express from "express";
import http from "http";
import axios from "axios";
import { Server } from "socket.io";
import { JSONFilePreset } from "lowdb/node";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BTC_ADDRESS = process.env.BTC_ADDRESS;
const NETWORK = process.env.NETWORK || "testnet";
const PORT = process.env.PORT || 3000;
const REQUIRED_CONFIRMATIONS = parseInt(process.env.CONFIRMATIONS || "1", 10);

if (!BTC_ADDRESS) {
  console.error("❌ Please set the BTC_ADDRESS environment variable.");
  process.exit(1);
}

// Initialize LowDB (v6+)
const db = await JSONFilePreset(path.join(__dirname, "db.json"), {
  deposits: [],
  balanceSats: 0,
});

// Helper: Blockstream URL
function blockstreamUrl(suffix) {
  return NETWORK === "mainnet"
    ? `https://blockstream.info/api${suffix}`
    : `https://blockstream.info/testnet/api${suffix}`;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/account", (req, res) => {
  res.json({
    balanceBTC: (db.data.balanceSats / 1e8).toFixed(8),
    deposits: db.data.deposits,
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

// Fetch transactions for address
async function fetchTxs() {
  try {
    const url = blockstreamUrl(`/address/${BTC_ADDRESS}/txs`);
    const res = await axios.get(url);
    return res.data || [];
  } catch (err) {
    console.error("Error fetching txs:", err.message);
    return [];
  }
}

async function fetchTxStatus(txid) {
  try {
    const url = blockstreamUrl(`/tx/${txid}/status`);
    const res = await axios.get(url);
    return res.data || {};
  } catch (err) {
    console.error("Error fetching status:", err.message);
    return {};
  }
}

// Main polling logic
async function checkDeposits() {
  const txs = await fetchTxs();

  for (const tx of txs) {
    const txid = tx.txid;
    const outputs = tx.vout || [];
    let valueSats = 0;

    outputs.forEach((out) => {
      if (out.scriptpubkey_address === BTC_ADDRESS) {
        valueSats += out.value;
      }
    });

    if (valueSats > 0) {
      const already = db.data.deposits.find((d) => d.txid === txid);
      if (already) continue;

      const status = await fetchTxStatus(txid);
      if (status.confirmed) {
        const deposit = {
          txid,
          amountSats: valueSats,
          amountBTC: valueSats / 1e8,
          creditedAt: new Date().toISOString(),
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

// Poll every 30 seconds
setInterval(checkDeposits, 30000);
checkDeposits();
