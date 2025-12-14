
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ---------------- CORS ----------------
const allowedOrigins = ["https://augustine59-wangombe.github.io"];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------------- 1) M-PESA CALLBACK ----------------
app.post("/callback", async (req, res) => {
  // ✅ Respond immediately to M-PESA
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });

  try {
    const body = req.body;
    console.log("📥 M-PESA CALLBACK RECEIVED:", body);

    const serviceAccount = JSON.parse(
      Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, "base64").toString("utf-8")
    );
    const token = await getAccessToken(serviceAccount);

    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${serviceAccount.project_id}/databases/(default)/documents/mpesa_payments`;

    const items = body?.Body?.stkCallback?.CallbackMetadata?.Item || [];
    const phone = items.find(i => i.Name === "PhoneNumber")?.Value?.toString() || "";
    const amount = items.find(i => i.Name === "Amount")?.Value || 0;

    await fetch(firestoreUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        fields: {
          payload: { stringValue: JSON.stringify(body) },
          phone: { stringValue: phone },
          amount: { integerValue: amount },
          timestamp: { timestampValue: new Date().toISOString() },
        },
      }),
    });

    console.log(`✅ Stored payment from ${phone} for amount ${amount}`);
  } catch (err) {
    console.error("❌ Error storing callback:", err);
  }
});

// ---------------- 2) STK PUSH ----------------
app.post("/stkpush", async (req, res) => {
  try {
    const { phone, amount } = req.body;

    // ---------------- Validate ----------------
    if (!phone || !amount) return res.status(400).json({ error: "Phone and amount are required" });
    if (!/^2547\d{8}$/.test(phone)) return res.status(400).json({ error: "Phone must be in format 2547XXXXXXXX" });
    if (amount < 1) return res.status(400).json({ error: "Amount must be greater than 0" });

    const shortcode = process.env.DARAJA_SHORTCODE;
    const passkey = process.env.DARAJA_PASSKEY;
    const timestamp = getTimestamp();
    const password = Buffer.from(shortcode + passkey + timestamp).toString("base64");

    // ---------------- OAuth ----------------
    const oauthRes = await fetch(
      "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      {
        headers: {
          Authorization:
            "Basic " + Buffer.from(process.env.DARAJA_CONSUMER_KEY + ":" + process.env.DARAJA_CONSUMER_SECRET).toString("base64"),
        },
      }
    );
    const { access_token } = await oauthRes.json();

    // ---------------- STK PUSH ----------------
    const stkRes = await fetch("https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest", {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: amount,
        PartyA: phone,
        PartyB: shortcode,
        PhoneNumber: phone,
        CallBackURL: process.env.CALLBACK_URL,
        AccountReference: "Youth Registration",
        TransactionDesc: "Membership Payment",
      }),
    });

    const stkJson = await stkRes.json();
    console.log("📤 STK RESPONSE:", stkJson);

    res.json(stkJson);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.toString() });
  }
});

// ---------------- 3) CHECK PAYMENT STATUS ----------------
app.get("/check-payment", async (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.status(400).json({ error: "Phone number required" });

  try {
    const serviceAccount = JSON.parse(
      Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, "base64").toString("utf-8")
    );
    const token = await getAccessToken(serviceAccount);

    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${serviceAccount.project_id}/databases/(default)/documents/mpesa_payments?pageSize=100`;
    const response = await fetch(firestoreUrl, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();

    const payments = (data.documents || []).filter(doc => doc.fields?.phone?.stringValue === phone);
    const success = payments.some(p => JSON.parse(p.fields.payload.stringValue)?.Body?.stkCallback?.ResultCode === 0);

    res.json({ paid: success });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.toString() });
  }
});

// ---------------- START SERVER ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// ---------------- HELPERS ----------------
function getTimestamp() {
  const date = new Date();
  return (
    date.getFullYear().toString() +
    ("0" + (date.getMonth() + 1)).slice(-2) +
    ("0" + date.getDate()).slice(-2) +
    ("0" + date.getHours()).slice(-2) +
    ("0" + date.getMinutes()).slice(-2) +
    ("0" + date.getSeconds()).slice(-2)
  );
}

async function getAccessToken(sa) {
  const { GoogleAuth } = await import("google-auth-library");
  const auth = new GoogleAuth({ credentials: sa, scopes: ["https://www.googleapis.com/auth/datastore"] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  return token.token;
}
