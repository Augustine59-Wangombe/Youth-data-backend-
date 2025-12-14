import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { GoogleAuth } from "google-auth-library";

const app = express();

/* --------------------
   CORS (IMPORTANT)
-------------------- */
const allowedOrigins = [
  "https://augustine59-wangombe.github.io",
  "https://augustine59-wangombe.github.io/Catholic-youth-system"
];

app.use(cors({
  origin: allowedOrigins,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

// Handle OPTIONS preflight requests
app.options("*", cors());

app.use(express.json());

/* --------------------
   HELPERS
-------------------- */
function getTimestamp() {
  const d = new Date();
  return (
    d.getFullYear().toString() +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0") +
    String(d.getHours()).padStart(2, "0") +
    String(d.getMinutes()).padStart(2, "0") +
    String(d.getSeconds()).padStart(2, "0")
  );
}

async function getFirestoreToken(serviceAccount) {
  const auth = new GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/datastore"]
  });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  return token;
}

/* --------------------
   CALLBACK (CRITICAL)
-------------------- */
app.post("/callback", async (req, res) => {
  // Respond immediately to Safaricom
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });

  try {
    console.log("📥 CALLBACK:", JSON.stringify(req.body));

    const serviceAccount = JSON.parse(
      Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, "base64").toString("utf8")
    );

    const token = await getFirestoreToken(serviceAccount);

    const items = req.body?.Body?.stkCallback?.CallbackMetadata?.Item || [];
    const phone = items.find(i => i.Name === "PhoneNumber")?.Value?.toString() || "";
    const amount = items.find(i => i.Name === "Amount")?.Value || 0;
    const resultCode = req.body?.Body?.stkCallback?.ResultCode ?? -1;

    const firestoreUrl =
      `https://firestore.googleapis.com/v1/projects/${serviceAccount.project_id}` +
      `/databases/(default)/documents/mpesa_payments`;

    await fetch(firestoreUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        fields: {
          phone: { stringValue: phone },
          amount: { integerValue: amount },
          success: { booleanValue: resultCode === 0 },
          payload: { stringValue: JSON.stringify(req.body) },
          timestamp: { timestampValue: new Date().toISOString() }
        }
      })
    });

  } catch (err) {
    console.error("❌ CALLBACK ERROR:", err);
  }
});

/* --------------------
   STK PUSH
-------------------- */
app.post("/stkpush", async (req, res) => {
  try {
    const { phone, amount } = req.body;

    if (!/^2547\d{8}$/.test(phone)) {
      return res.status(400).json({ error: "Invalid phone format" });
    }

    const shortcode = process.env.DARAJA_SHORTCODE;
    const passkey = process.env.DARAJA_PASSKEY;
    const timestamp = getTimestamp();
    const password = Buffer.from(shortcode + passkey + timestamp).toString("base64");

    // OAuth
    const oauthRes = await fetch(
      "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              process.env.DARAJA_CONSUMER_KEY + ":" +
              process.env.DARAJA_CONSUMER_SECRET
            ).toString("base64")
        }
      }
    );

    const { access_token } = await oauthRes.json();

    // STK request
    const stkRes = await fetch(
      "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access_token}`,
          "Content-Type": "application/json"
        },
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
          TransactionDesc: "Membership"
        })
      }
    );

    const data = await stkRes.json();
    res.json(data);

  } catch (err) {
    console.error("❌ STK ERROR:", err);
    res.status(500).json({ error: "STK push failed" });
  }
});

/* --------------------
   CHECK PAYMENT
-------------------- */
app.get("/check-payment", async (req, res) => {
  try {
    const phone = req.query.phone;
    if (!phone) return res.status(400).json({ paid: false });

    const serviceAccount = JSON.parse(
      Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, "base64").toString("utf8")
    );

    const token = await getFirestoreToken(serviceAccount);

    const url =
      `https://firestore.googleapis.com/v1/projects/${serviceAccount.project_id}` +
      `/databases/(default)/documents/mpesa_payments?pageSize=50`;

    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const data = await r.json();

    const paid = (data.documents || []).some(doc =>
      doc.fields?.phone?.stringValue === phone &&
      doc.fields?.success?.booleanValue === true
    );

    res.json({ paid });

  } catch (err) {
    console.error("❌ CHECK PAYMENT ERROR:", err);
    res.status(500).json({ paid: false });
  }
});

/* --------------------
   START SERVER
-------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Backend running on", PORT));
