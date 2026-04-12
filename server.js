require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();

/* ================= CONFIG ================= */

const CONFIG = {
  KEY_ID: process.env.RAZORPAY_KEY_ID,
  KEY_SECRET: process.env.RAZORPAY_SECRET,
  WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET || "smartpay123",
  ESP_IP: process.env.ESP_IP || "10.200.188.240",

  AMOUNT_DURATION_MAP: {
    10: 10,
    25: 30,
    50: 60
  }
};

/* ================= DEBUG ================= */
console.log("🚀 Server starting...");
console.log("KEY_ID:", CONFIG.KEY_ID ? "Loaded ✅" : "Missing ❌");
console.log("WEBHOOK_SECRET:", CONFIG.WEBHOOK_SECRET ? "Loaded ✅" : "Missing ❌");

/* ================= MIDDLEWARE ================= */

app.use(cors());
app.use(express.json());

/* ================= MEMORY ================= */

const processedPayments = new Set();

/* ================= WEBHOOK ================= */

app.post("/razorpay-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    // ✅ FIXED LINE (only change)
    const body = req.body instanceof Buffer ? req.body : Buffer.from(JSON.stringify(req.body));

    const expectedSignature = crypto
      .createHmac("sha256", CONFIG.WEBHOOK_SECRET)
      .update(body)
      .digest("hex");

    const receivedSignature = req.headers["x-razorpay-signature"];

    if (expectedSignature !== receivedSignature) {
      console.log("❌ Invalid webhook signature");
      return res.status(400).send("Invalid signature");
    }

    console.log("✅ Webhook verified");

    const data = JSON.parse(body.toString());

    if (data.event === "payment.captured") {
      const payment = data.payload.payment.entity;

      const amount = payment.amount / 100;
      const paymentId = payment.id;

      console.log("💰 Payment received:", amount, paymentId);

      if (processedPayments.has(paymentId)) {
        console.log("⚠️ Duplicate payment ignored");
        return res.send("Duplicate");
      }

      processedPayments.add(paymentId);

      const duration = CONFIG.AMOUNT_DURATION_MAP[amount];

      if (!duration) {
        console.log("⚠️ Unknown amount");
        return res.send("Ignored");
      }

      console.log("⏱ Duration:", duration);

      try {
        const url = `http://${CONFIG.ESP_IP}/relay?time=${duration}`;
        console.log("👉 Trigger ESP:", url);

        const response = await fetch(url);

        if (!response.ok) throw new Error("ESP failed");

        console.log("✅ ESP triggered");
      } catch (err) {
        console.log("❌ ESP ERROR:", err.message);
      }
    }

    res.send("OK");

  } catch (err) {
    console.log("❌ WEBHOOK ERROR:", err.message);
    res.status(500).send("Error");
  }
});

/* ================= CREATE ORDER ================= */

app.post("/create-order", async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount) {
      return res.status(400).json({ error: "Amount required" });
    }

    const auth = Buffer.from(
      CONFIG.KEY_ID + ":" + CONFIG.KEY_SECRET
    ).toString("base64");

    const response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`
      },
      body: JSON.stringify({
        amount: amount * 100,
        currency: "INR",
        receipt: "rcpt_" + Date.now()
      })
    });

    const data = await response.json();

    if (data.error) {
      console.log("❌ Razorpay Error:", data.error);
      return res.status(400).json(data);
    }

    res.json(data);

  } catch (err) {
    console.log("❌ ORDER ERROR:", err.message);
    res.status(500).send("Error");
  }
});

/* ================= HEALTH ================= */

app.get("/", (req, res) => {
  res.send("🚀 SmartPay Backend Running");
});

/* ================= START ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🔥 Server running on port ${PORT}`);
});
