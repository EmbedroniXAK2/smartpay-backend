require("dotenv").config();

const fetch   = require("node-fetch");
const express = require("express");
const cors    = require("cors");
const crypto  = require("crypto");
const admin   = require("firebase-admin");

/* ────────────────────────────────────────
   FIREBASE ADMIN INIT 
   Using service account JSON file
──────────────────────────────────────── */
const serviceAccount = require("./smartpayplug-firebase-adminsdk-fbsvc-8d48fb36ae.json");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db  = admin.firestore();
const app = express();

/* ────────────────────────────────────────
   CONFIG
──────────────────────────────────────── */
const WEBHOOK_SECRET  = process.env.RAZORPAY_WEBHOOK_SECRET;
const ESP_IP          = process.env.ESP_IP || "10.200.188.240";
const PORT            = process.env.PORT   || 3000;

/* ────────────────────────────────────────
   MIDDLEWARE
──────────────────────────────────────── */
app.use(cors());

/* ────────────────────────────────────────
   RAZORPAY WEBHOOK (FIXED)
   Uses RAW body for signature verification
──────────────────────────────────────── */
app.post("/razorpay-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      // 1. VERIFY SIGNATURE
      const shasum = crypto.createHmac("sha256", WEBHOOK_SECRET);
      shasum.update(req.body);
      const digest = shasum.digest("hex");

      if (digest !== req.headers["x-razorpay-signature"]) {
        console.log("Invalid webhook signature");
        return res.status(400).send("Invalid signature");
      }

      // 2. EXTRACT PAYMENT DATA
      const data = JSON.parse(req.body.toString());
      const payment = data.payload.payment.entity;
      console.log("Payment received:", payment);

      // 3. IDENTIFY USER USING EMAIL
      const email = payment.email;
      if (!email) {
        console.log("No email found in payment entity");
        return res.sendStatus(200);
      }

      const userSnap = await db.collection("users")
        .where("email", "==", email)
        .get();

      if (userSnap.empty) {
        console.log("User not found for email:", email);
        return res.sendStatus(200);
      }

      const userId = userSnap.docs[0].id;

      // 4. SAVE PAYMENT TO FIRESTORE
      await db.collection("users")
        .doc(userId)
        .collection("payments")
        .add({
          amount: payment.amount / 100,
          status: "success",
          source: "razorpay",
          time: new Date().toISOString()
        });

      // 5. TRIGGER ESP
      const amount = payment.amount / 100;
      let duration = 0;

      if(amount === 10) duration = 10;
      if(amount === 25) duration = 30;
      if(amount === 50) duration = 60;

      if (duration > 0) {
        try {
          await fetch(`http://${ESP_IP}/relay?time=${duration}`);
          console.log(`ESP triggered for ${duration} mins`);
        } catch (espErr) {
          console.error("ESP trigger failed:", espErr.message);
        }
      }

      return res.sendStatus(200);

    } catch (err) {
      console.error("Webhook handler error:", err.message);
      return res.status(500).send("Internal error");
    }
  }
);

/* ────────────────────────────────────────
   HEALTH CHECK
──────────────────────────────────────── */
app.get("/", (req, res) => {
  res.send("🚀 SmartPayPlug Backend Running (Webhook Only)");
});

/* ────────────────────────────────────────
   START SERVER
──────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`🔥 Server running on port ${PORT}`);
});
