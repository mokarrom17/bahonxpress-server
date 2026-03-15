const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const { default: Stripe } = require("stripe");
const admin = require("firebase-admin");

dotenv.config();
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);
const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

const serviceAccount = require("./firebase-admin-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// MongoDB connection URI
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.olgdgso.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("parcelDB");
    const trackingCollection = db.collection("tracking");
    const userCollection = db.collection("users");
    const parcelCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    // Rider Application Collection
    const riderCollection = db.collection("riderApplications");

    // Custom middleware to log request details
    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).send({ message: "Unauthorized access" });
      }

      const token = authHeader.split(" ")[1];

      if (!token) {
        return res.status(401).send({ message: "Unauthorized access" });
      }

      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: "Forbidden access" });
      }
    };

    // Admin verification middleware (for future use)
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await userCollection.findOne(query);

      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    // Create or update user on login/signup
    app.post("/users", async (req, res) => {
      const email = req.body.email;

      const userExists = await userCollection.findOne({ email });

      if (userExists) {
        // update last login time
        await userCollection.updateOne(
          { email },
          { $set: { lastLogin: new Date().toISOString() } },
        );
        return res.send({ message: "User already exists", inserted: false });
      }

      const user = req.body;
      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    // ✅ GET all parcels
    // app.get("/parcels", async (req, res) => {
    //   const parcels = await parcelCollection.find().toArray();
    //   res.send(parcels);
    // });
    // ✅ GET parcels by user email (optional query param)

    app.get("/parcels", verifyFBToken, async (req, res) => {
      try {
        const email = req.query.email;

        // Security check
        if (email !== req.decoded.email) {
          return res.status(403).json({ message: "Forbidden access" });
        }
        const query = { userEmail: email };
        const option = {
          sort: { createdAt: -1 }, // Sort by createdAt in descending order
        };

        const parcels = await parcelCollection.find(query, option).toArray();

        res.status(200).json(parcels);
      } catch (error) {
        console.error("Failed to fetch parcels:", error);
        res.status(500).json({
          message: "Failed to fetch parcels",
        });
      }
    });
    // Get: Get a specific parcel by ID
    app.get("/parcels/:id", verifyFBToken, async (req, res) => {
      try {
        const id = req.params.id;

        const parcel = await parcelCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!parcel || parcel.userEmail !== req.decoded.email) {
          return res.status(403).json({ message: "Forbidden access" });
        }

        res.send(parcel);
      } catch (error) {
        console.log(error);
        res.status(500).json({ message: "Server error" });
      }
    });

    // ✅ POST new parcel
    app.post("/parcels", verifyFBToken, async (req, res) => {
      try {
        const parcelData = req.body;

        const newParcel = {
          ...parcelData,
          status: "pending",
          paymentStatus: "unpaid",
          createdAt: new Date(),
        };

        const result = await parcelCollection.insertOne(newParcel);

        res.status(201).json({
          success: true,
          message: "Parcel created successfully",
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error("Parcel Insert Error:", error);
        res
          .status(500)
          .json({ success: false, message: "Internal Server Error" });
      }
    });
    // ✅ Delete parcel
    app.delete("/parcels/:id", verifyFBToken, async (req, res) => {
      try {
        const id = req.params.id;

        const parcel = await parcelCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!parcel || parcel.userEmail !== req.decoded.email) {
          return res.status(403).json({ message: "Forbidden" });
        }

        const result = await parcelCollection.deleteOne({
          _id: new ObjectId(id),
        });

        res.send(result);
      } catch (error) {
        console.error("Error deleting parcel: ", error);
        res.status(500).send({ message: "Failed to delete parcel" });
      }
    });

    // Tracking collection for status updates
    app.post("/tracking", async (req, res) => {
      const update = req.body;
      update.updatedAt = new Date();

      const result = await trackingCollection.insertOne(update);

      // also update latest status into parcels collection
      await parcelCollection.updateOne(
        { trackingId: update.trackingId },
        { $set: { status: update.status } },
      );

      res.send(result);
    });
    // Get tracking info by tracking ID
    app.get("/track/:trackingId", async (req, res) => {
      const trackingId = req.params.trackingId;

      const parcel = await parcelCollection.findOne({ trackingId });
      const updates = await trackingCollection
        .find({ trackingId })
        .sort({ updatedAt: -1 })
        .toArray();

      res.send({ parcel, updates });
    });

    // Update parcel payment status
    app.patch("/parcels/payment/:id", async (req, res) => {
      try {
        const id = req.params.id;

        const result = await parcelCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              paymentStatus: "paid",
              paymentDate: new Date().toISOString(),
            },
          },
        );

        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Failed to update payment status" });
      }
    });

    // Save payment history entry
    app.post("/payments", verifyFBToken, async (req, res) => {
      try {
        const paymentInfo = req.body;
        paymentInfo.userEmail = req.decoded.email;
        paymentInfo.createdAt = new Date().toISOString();

        const result = await paymentCollection.insertOne(paymentInfo);
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Failed to save payment history" });
      }
    });
    // GET API → Load Payment History (User-Specific)
    app.get("/payments", verifyFBToken, async (req, res) => {
      try {
        const email = req.query.email;
        console.log("decoded", req.decoded);
        if (!email) return res.status(400).json({ message: "Email required" });
        if (email !== req.decoded.email) {
          return res.status(403).json({ message: "Forbidden access" });
        }

        const query = { userEmail: email };
        const result = await paymentCollection
          .find(query)
          .sort({ createdAt: -1 })
          .toArray();

        res.send(result);
      } catch (error) {
        console.error("Error fetching payments:", error);
        res.status(500).json({ message: "Failed to get payment history" });
      }
    });
    // Create Payment Intent
    app.post("/create-payment-intent", verifyFBToken, async (req, res) => {
      try {
        const { amountInCents } = req.body;

        if (!amountInCents || amountInCents < 1) {
          return res.status(400).json({ error: "Invalid amount" });
        }

        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCents,
          currency: "bdt",
          payment_method_types: ["card"],
        });

        res.send({
          clientSecret: paymentIntent.client_secret,
        });
      } catch (error) {
        console.error("INTENT ERROR:", error);
        res.status(500).json({ error: error.message });
      }
    });

    // Rider Application Routes
    app.post("/riders", async (req, res) => {
      const rider = req.body;
      const result = await riderCollection.insertOne(rider);
      res.send(result);
    });
    // GET: Load all pending rider applications
    app.get("/riders/pending", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const pendingRiders = await riderCollection
          .find({ status: "pending" })
          .toArray();
        res.send(pendingRiders);
      } catch (error) {
        console.log("Failed to load pending riders:", error);
        res.status(500).send({ message: "Failed to load pending riders" });
      }
    });

    // GET: Load all active riders
    app.get("/riders/active", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const activeRiders = await riderCollection
          .find({ status: "approved" })
          .toArray();

        res.send(activeRiders);
      } catch (error) {
        console.log("Failed to load active riders:", error);
        res.status(500).send({ message: "Failed to load active riders" });
      }
    });
    // PATCH: Update rider application status (approve/reject/deactivate)
    app.patch("/riders/status/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const { status } = req.body;

        // allowed status check
        if (!["approved", "rejected", "pending"].includes(status)) {
          return res.status(400).send({ message: "Invalid status value" });
        }

        // rider application find
        const rider = await riderCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!rider) {
          return res.status(404).send({ message: "Rider not found" });
        }

        const updateData = {
          status,
          updatedAt: new Date(),
        };

        // timestamp based on status
        if (status === "approved") updateData.approvedAt = new Date();
        if (status === "rejected") updateData.rejectedAt = new Date();
        if (status === "pending") updateData.deactivatedAt = new Date();

        const result = await riderCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: updateData,
          },
        );

        // 2️⃣ Update user role
        let role = "user";
        if (status === "approved") role = "rider";

        const userResult = await userCollection.updateOne(
          { email: rider.userEmail },
          {
            $set: { role },
          },
        );

        res.send(result);
      } catch (error) {
        console.log("Status Update Error:", error);
        res.status(500).send({ message: "Failed to update rider status" });
      }
    });
    // GET: Search user by email (for admin use)
    app.get("/users/search", async (req, res) => {
      const emailQuery = req.query.email;

      if (!emailQuery) {
        return res.status(400).send({ message: "Email query required" });
      }
      // Create a case-insensitive regex for partial email matching
      const regex = new RegExp(`^${emailQuery}`, "i");

      try {
        const users = await userCollection
          .find({ email: { $regex: regex } })
          .project({ email: 1, createdAt: 1, role: 1, isAdmin: 1 })
          .limit(10)
          .toArray();

        res.send(users);
      } catch (error) {
        console.error("Error searching users:", error);
        res.status(500).send({ message: "Error searching users" });
      }
    });
    // PATCH: Promote user to admin (admin only)

    app.patch(
      "/users/:id/admin",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const id = req.params.id;
          const { isAdmin } = req.body;

          const role = isAdmin ? "admin" : "user";

          const result = await userCollection.updateOne(
            { _id: new ObjectId(id) },
            {
              $set: { role },
            },
          );

          res.send(result);
        } catch (error) {
          console.log("ADMIN UPDATE ERROR:", error);
          res.status(500).send({ message: "Failed to update role" });
        }
      },
    );

    //GET: Get user role by email
    app.get("/users/:email/role", async (req, res) => {
      try {
        const email = req.params.email;

        if (!email) {
          return res.status(400).send({ message: "Email required" });
        }

        const user = await userCollection.findOne({ email });

        // default role
        const role = user?.role || "user";

        res.send({ role });
      } catch (error) {
        console.log("Role API error:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

/* =============== ============
   ROUTES
=========================== */

// Root route
app.get("/", (req, res) => {
  res.send("🚀 BahonXpress Parcel Server Running...");
});

// Health check route
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    timestamp: new Date().toISOString(),
  });
});

/* ===========================
   START SERVER
=========================== */

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
