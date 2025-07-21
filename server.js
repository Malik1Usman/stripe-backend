require("dotenv").config();
const express = require("express");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");
const serviceAccount = require("./config/tourease-22761-firebase-adminsdk-fbsvc-28cc60c4ea.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

// 👇 Your existing endpoints
app.get("/", (req, res) => {
  res.send("Stripe Backend is Running 🚀");
});

app.post("/create-payment-intent", async (req, res) => {
  try {
    const { amount } = req.body;
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: "usd",
    });
    res.send({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 👇 🔥 ADD YOUR REFUND ENDPOINT HERE
app.post("/refund-booking", async (req, res) => {
  const { bookingId, userId } = req.body;

  try {
    const bookingRef = db.collection("bookings").doc(bookingId);
    const bookingSnap = await bookingRef.get();

    if (!bookingSnap.exists) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    const booking = bookingSnap.data();
    const createdAt = booking.timestamp.toDate();
    const now = new Date();
    const hoursPassed = (now - createdAt) / (1000 * 60 * 60);
    if (hoursPassed > 24) {
      return res.status(403).json({ success: false, message: "Refund not allowed after 24 hours." });
    }

    const source = booking.source || "tour";
    let paymentIntentId, amount, persons = 1;

    if (source === "hotel") {
      if (booking.userId !== userId) {
        return res.status(403).json({ success: false, message: "User mismatch" });
      }

      paymentIntentId = booking.stripeCustomerId;
      amount = booking.totalPrice;

      await stripe.refunds.create({
        payment_intent: paymentIntentId,
        amount: amount,
      });

      await bookingRef.update({
        status: "cancelled",
        isRefunded: true
      });

    } else if (source === "tour") {
      const userEntry = booking.users.find(user => user.userId === userId);
      if (!userEntry) {
        return res.status(404).json({ success: false, message: "User not found in group" });
      }

      paymentIntentId = userEntry.stripeCustomerId;
      persons = userEntry.persons || 1;

      await stripe.refunds.create({
        payment_intent: paymentIntentId,
        // amount: optional
      });

      const updatedUsers = booking.users.filter(user => user.userId !== userId);
      const updatedCount = booking.currentCount - persons;

      await bookingRef.update({
        users: updatedUsers,
        currentCount: updatedCount
      });
    }

    await db.collection("refunds").add({
      bookingId,
      userId,
      source,
      refundId: paymentIntentId,
      persons,
      status: "refunded",
      timestamp: admin.firestore.Timestamp.now()
    });

    return res.status(200).json({
      success: true,
      message: `Refund processed successfully for ${source}`
    });

  } catch (error) {
    console.error("Refund error:", error.message);
    res.status(500).json({ success: false, message: "Refund failed", error: error.message });
  }
});


// 🔚 Server Start
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
