require("dotenv").config();

const fetch   = require("node-fetch");
const express = require("express");
const cors    = require("cors");
const crypto  = require("crypto");
const admin   = require("firebase-admin");

/* ────────────────────────────────────────
   FIREBASE ADMIN INIT
──────────────────────────────────────── */
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault()
  });
}

const db  = admin.firestore();
const app = express();

/* ────────────────────────────────────────
   CONFIG  (all values come from .env)
──────────────────────────────────────── */
const KEY_ID          = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET      = process.env.RAZORPAY_SECRET;
const WEBHOOK_SECRET  = process.env.RAZORPAY_WEBHOOK_SECRET;
const ESP_IP          = process.env.ESP_IP || "10.200.188.240";
const PORT            = process.env.PORT   || 3000;

const AMOUNT_PLAN_MAP = {
  10: { plan: "Quick Charge",    minutes: 10 },
  25: { plan: "Standard Charge", minutes: 30 },
  50: { plan: "Full Charge",     minutes: 60 }
};

/* ────────────────────────────────────────
   STARTUP DIAGNOSTICS
──────────────────────────────────────── */
console.log("🚀 SmartPayPlug backend starting…");
console.log("   KEY_ID:",         KEY_ID        ? "✅ Loaded" : "❌ Missing");
console.log("   KEY_SECRET:",     KEY_SECRET    ? "✅ Loaded" : "❌ Missing");
console.log("   WEBHOOK_SECRET:", WEBHOOK_SECRET? "✅ Loaded" : "❌ Missing");
console.log("   ESP_IP:",         ESP_IP);

/* ────────────────────────────────────────
   MIDDLEWARE
──────────────────────────────────────── */
app.use(cors());
app.use(express.json());

/* ────────────────────────────────────────
   IDEMPOTENCY GUARD  (in-memory)
──────────────────────────────────────── */
const processedPayments = new Set();

/* ────────────────────────────────────────
   RAZORPAY WEBHOOK
   • Verifies HMAC signature
   • Saves to Firestore  (plan + amount + status)
   • Triggers ESP relay
──────────────────────────────────────── */
app.post(
  "/razorpay-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const body = req.body instanceof Buffer
        ? req.body
        : Buffer.from(JSON.stringify(req.body));

      /* ── Signature verification ── */
      const expected = crypto
        .createHmac("sha256", WEBHOOK_SECRET)
        .update(body)
        .digest("hex");

      const received = req.headers["x-razorpay-signature"];

      if (expected !== received) {
        console.warn("❌ Invalid webhook signature");
        return res.status(400).send("Invalid signature");
      }

      console.log("✅ Webhook signature verified");

      const data = JSON.parse(body.toString());

      if (data.event !== "payment.captured") {
        return res.send("OK");
      }

      const payment   = data.payload.payment.entity;
      const amount    = payment.amount / 100;        // paise → ₹
      const paymentId = payment.id;
      const uid       = payment.notes?.uid;

      if (!uid) {
        console.warn("⚠️  UID missing in payment notes — cannot save to Firestore");
        return res.send("Missing UID");
      }

      /* ── Idempotency check ── */
      if (processedPayments.has(paymentId)) {
        console.log("⚠️  Duplicate event — already processed:", paymentId);
        return res.send("Duplicate");
      }
      processedPayments.add(paymentId);

      const planInfo = AMOUNT_PLAN_MAP[amount];
      if (!planInfo) {
        console.warn("⚠️  Unknown amount:", amount);
        return res.send("Unknown amount");
      }

      console.log(`💰 Payment captured: ₹${amount} | ${planInfo.plan} | ${paymentId}`);

      /* ── Save to Firestore ── */
      try {
        await db.collection("users").doc(uid).collection("payments").add({
          amount:    amount,
          plan:      planInfo.plan,
          status:    "success",
          source:    "razorpay",
          paymentId: paymentId,
          time:      new Date().toLocaleString("en-IN")
        });
        console.log("✅ Firestore saved");
      } catch (err) {
        console.error("❌ Firestore save error:", err.message);
      }

      /* ── ESP relay trigger ── */
      try {
        const url = `http://${ESP_IP}/relay?time=${planInfo.minutes}`;
        console.log("🔌 Triggering ESP:", url);
        const response = await fetch(url, { timeout: 5000 });
        if (!response.ok) throw new Error(`Status ${response.status}`);
        console.log("✅ ESP triggered successfully");
      } catch (err) {
        console.error("❌ ESP trigger error:", err.message);
        // Non-fatal — payment is already saved
      }

      return res.send("OK");

    } catch (err) {
      console.error("❌ Webhook handler error:", err.message);
      return res.status(500).send("Internal error");
    }
  }
);

/* ────────────────────────────────────────
   CREATE RAZORPAY ORDER
   • Called by frontend before opening Razorpay checkout
   • Attaches uid to order notes (used by webhook)
──────────────────────────────────────── */
app.post("/create-order", async (req, res) => {
  try {
    const { amount, uid } = req.body;

    if (!amount) {
      return res.status(400).json({ error: "Amount required" });
    }

    const authHeader = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64");

    const response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:  `Basic ${authHeader}`
      },
      body: JSON.stringify({
        amount:   amount * 100,
        currency: "INR",
        receipt:  "rcpt_" + Date.now(),
        notes:    { uid: uid || "" }
      })
    });

    const data = await response.json();

    if (data.error) {
      console.error("❌ Razorpay order error:", data.error);
      return res.status(400).json(data);
    }

    console.log(`📦 Order created: ₹${amount} | ${data.id}`);
    return res.json(data);

  } catch (err) {
    console.error("❌ Create-order error:", err.message);
    return res.status(500).send("Error creating order");
  }
});

/* ────────────────────────────────────────
   HEALTH CHECK
──────────────────────────────────────── */
app.get("/", (req, res) => {
  res.send("🚀 SmartPayPlug Backend Running");
});

/* ────────────────────────────────────────
   START SERVER
──────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`🔥 Server running on port ${PORT}`);
});
