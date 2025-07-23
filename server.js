require("dotenv").config();
const express = require("express");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
  }),
});

const db = admin.firestore();
const app = express();

app.use(cors());
app.use(express.json());

// ✅ Basic Route
app.get("/", (req, res) => {
  res.send("Stripe Backend is Running 🚀");
});

// ✅ Create Payment Intent
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

// ✅ Refund Endpoint
app.post("/refund-booking", async (req, res) => {
  const { bookingId, userId } = req.body;

  try {
    const bookingRef = db.collection("bookings").doc(bookingId);
    const bookingSnap = await bookingRef.get();

    if (!bookingSnap.exists) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    const booking = bookingSnap.data();
    const source = booking.source || "tour";

    let createdAt;

    if (source === "hotel") {
      if (!booking.timestamp) {
        return res.status(400).json({ success: false, message: "Missing booking timestamp" });
      }
      createdAt = booking.timestamp.toDate();
    } else {
      const userEntry = booking.users.find(user => user.userId === userId);
      if (!userEntry || !userEntry.timestamp) {
        return res.status(404).json({ success: false, message: "User timestamp not found" });
      }
      createdAt = userEntry.timestamp.toDate();
    }

    const now = new Date();
    const hoursPassed = (now - createdAt) / (1000 * 60 * 60);
    if (hoursPassed > 24) {
      return res.status(403).json({ success: false, message: "Refund not allowed after 24 hours." });
    }

    let paymentIntentId, persons = 1;

    if (source === "hotel") {
      if (booking.userId !== userId) {
        return res.status(403).json({ success: false, message: "User mismatch" });
      }

      if (!booking.stripeCustomerId) {
        return res.status(400).json({ success: false, message: "Missing stripeCustomerId." });
      }

      paymentIntentId = booking.stripeCustomerId.split("_secret_")[0];

      await stripe.refunds.create({
        payment_intent: paymentIntentId,
      });

      await bookingRef.update({
        status: "cancelled",
        isRefunded: true
      });

      await db.collection("users").doc(userId)
        .collection("bookings").doc(bookingId)
        .update({ status: "cancelled" });

    } else if (source === "tour") {
      const userEntry = booking.users.find(user => user.userId === userId);
      if (!userEntry) {
        return res.status(404).json({ success: false, message: "User not found in group" });
      }

      if (!userEntry.stripeCustomerId) {
        return res.status(400).json({ success: false, message: "Missing stripeCustomerId for user." });
      }

      paymentIntentId = userEntry.stripeCustomerId.split("_secret_")[0];
      persons = userEntry.persons || 1;

      await stripe.refunds.create({
        payment_intent: paymentIntentId,
      });

      const updatedUsers = booking.users.filter(user => user.userId !== userId);
      const updatedCount = booking.currentCount - persons;

      const updateFields = {
        users: updatedUsers,
        currentCount: updatedCount
      };

      // Optional: Auto-cancel tour if all users leave
      // if (updatedUsers.length === 0) {
      //   updateFields.status = "cancelled";
      // }

      await bookingRef.update(updateFields);

      await db.collection("users").doc(userId)
        .collection("bookings").doc(bookingId)
        .update({ status: "cancelled" });
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
    
    // ya ha notification ka lya

    const itemId = source === "tour" ? booking.tourId : booking.hotelId;
let title = "your package";
try {
  const itemSnap = await db.collection(source === "tour" ? "tours" : "hotels").doc(itemId).get();
  if (itemSnap.exists) {
    title = itemSnap.data().title || title;
  }
} catch (err) {
  console.log("Error fetching item title:", err.message);
}

await admin.messaging().sendToTopic(userId, {
  notification: {
    title: "Booking Cancelled",
    body: `Your booking for ${title} has been cancelled.`,
  },
  data: {
    type: "cancel",
    itemId,
    source,
    bookingId,
    title
  }
});

await db.collection("users").doc(userId).collection("notifications").add({
  userId,
  title: "Booking Cancelled",
  message: `Your booking for ${title} has been cancelled.`,
  type: "cancel",
  source,
  itemId,
  bookingId,
  timestamp: admin.firestore.Timestamp.now(),
  isRead: false
});


await admin.messaging().sendToTopic(userId, {
  notification: {
    title: "Refund Processed",
    body: `Refund for your ${title} booking has been successfully processed.`,
  },
  data: {
    type: "refund",
    itemId,
    source,
    bookingId,
    title
  }
});
await db.collection("users").doc(userId).collection("notifications").add({
  userId,
  title: "Refund Processed",
  message: `Refund for your ${title} booking has been successfully processed.`,
  type: "refund",
  source,
  itemId,
  bookingId,
  timestamp: admin.firestore.Timestamp.now(),
  isRead: false
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

// ✅ Server Start
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
