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
    const trackingsCollection = db.collection("trackings");
    const userCollection = db.collection("users");
    const parcelCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    // Rider Application Collection
    const riderCollection = db.collection("riderApplications");
    const cashOutCollection = db.collection("cashOut");

    // 🔥 Utility: Generate Tracking ID (Backend Only)
    const generateTrackingId = () => {
      const date = new Date();

      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");

      const timestamp = Date.now().toString().slice(-5);
      const random = Math.random().toString(36).substring(2, 6).toUpperCase();

      return `BX-${year}${month}${day}-${timestamp}${random}`;
    };

    // Custom middleware to log request details
    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;

      // console.log("HEADER:", authHeader); // 👈 ADD THIS

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
        // console.log("VERIFY ERROR:", error.message);
        return res.status(403).send({ message: "Forbidden access" });
      }
    };

    // const verifyFBToken = async (req, res, next) => {
    //   const authHeader = req.headers.authorization;

    //   console.log("STEP 1 HEADER:", authHeader);

    //   if (!authHeader || !authHeader.startsWith("Bearer ")) {
    //     console.log("STEP 2 NO HEADER");
    //     return res.status(401).send({ message: "Unauthorized access" });
    //   }

    //   const token = authHeader.split(" ")[1];

    //   console.log("STEP 3 TOKEN RECEIVED");

    //   try {
    //     console.log("STEP 4 BEFORE VERIFY");

    //     const decoded = await admin.auth().verifyIdToken(token);

    //     console.log("STEP 5 AFTER VERIFY", decoded);

    //     req.decoded = decoded;
    //     next();
    //   } catch (error) {
    //     console.log("STEP ERROR:", error); // 🔥 MUST ADD
    //     return res.status(403).send({ message: "Forbidden access" });
    //   }
    // };
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
    // Rider verification middleware
    const verifyRider = async (req, res, next) => {
      const user = await userCollection.findOne({
        email: req.decoded.email,
      });

      if (!user || user.role !== "rider") {
        return res.status(403).send({ message: "Rider only access" });
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
        console.log("parcel query", req.query, query, option);

        const parcels = await parcelCollection.find(query, option).toArray();

        res.status(200).json(parcels);
      } catch (error) {
        console.error("Failed to fetch parcels:", error);
        res.status(500).json({
          message: "Failed to fetch parcels",
        });
      }
    });
    // Get: Get all pending parcels (admin only)
    app.get(
      "/parcels/pending",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const query = {
            paymentStatus: "paid",
            delivery_status: "pending",
          };

          const parcels = await parcelCollection
            .find(query)
            .sort({ createdAt: 1 }) // oldest first
            .toArray();

          res.send(parcels);
        } catch (error) {
          console.log(error);
          res.status(500).send({ message: "Failed to load parcels" });
        }
      },
    );
    // Get: Get parcels assigned to a rider (rider only)
    app.get(
      "/parcels/assigned",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const result = await parcelCollection
            .find({
              riderEmail: { $exists: true }, // 🔥 only assigned parcels
            })
            .sort({ assignedAt: -1 })
            .toArray();

          res.send(result);
        } catch (error) {
          console.log("Admin Assigned Error:", error);
          res.status(500).send({ message: "Failed to load parcels" });
        }
      },
    );
    // Get: Get parcels assigned to the logged-in rider (rider only)
    app.get(
      "/parcels/my-assigned",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const email = req.decoded.email;

          const result = await parcelCollection
            .find({
              riderEmail: email,
              delivery_status: {
                $in: ["rider_assigned", "picked", "in_transit"],
              },
            })
            .project({
              trackingId: 1,
              parcelName: 1,
              receiverName: 1,
              receiverPhone: 1,
              receiverAddress: 1,
              delivery_status: 1,
              assignedAt: 1,
            })
            .sort({ assignedAt: -1 })
            .toArray();

          res.send(result);
        } catch (error) {
          console.log("Rider Parcels Error:", error);
          res.status(500).send({ message: "Failed to load rider parcels" });
        }
      },
    );
    // PATCH: Update parcel delivery status (rider only)
    app.patch(
      "/parcels/update-status/:id",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const id = req.params.id;
          const { status } = req.body;

          const validStatus = [
            "rider_assigned",
            "picked",
            "in_transit",
            "delivered",
          ];

          if (!validStatus.includes(status)) {
            return res.status(400).send({ message: "Invalid status" });
          }

          if (!ObjectId.isValid(id)) {
            return res.status(400).send({ message: "Invalid ID" });
          }

          const parcel = await parcelCollection.findOne({
            _id: new ObjectId(id),
          });

          if (!parcel) {
            return res.status(404).send({ message: "Parcel not found" });
          }

          // 🔥 STATUS FLOW CONTROL (CLEAN SYSTEM)
          const statusFlow = [
            "rider_assigned",
            "picked",
            "in_transit",
            "delivered",
          ];

          const currentIndex = statusFlow.indexOf(parcel.delivery_status);
          const newIndex = statusFlow.indexOf(status);

          if (newIndex !== currentIndex + 1) {
            return res
              .status(400)
              .send({ message: "Invalid status transition" });
          }

          let updateData = {
            delivery_status: status,
            updatedAt: new Date(),
          };

          // 🔥 delivered হলে earning calculate
          if (status === "delivered") {
            const total = parcel.cost?.total || 0;

            let earning = 0;

            if (parcel.senderDistrict === parcel.receiverDistrict) {
              earning = total * 0.6;
            } else {
              earning = total * 0.85;
            }

            updateData.earning = Math.round(earning);
            updateData.isCashedOut = false;
          }

          // ✅ Update parcel
          await parcelCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: updateData },
          );

          // 🔥🔥 ADD THIS PART (MAIN TRACKING INSERT)
          const statusMessages = {
            rider_assigned: "Rider has been assigned",
            picked: "Parcel picked up by rider",
            in_transit: "Parcel is on the way",
            delivered: "Parcel delivered successfully",
          };

          await trackingsCollection.insertOne({
            trackingId: parcel.trackingId,
            status,
            message: statusMessages[status],
            updatedAt: new Date(),
            updatedBy: req.decoded.email,
          });

          res.send({ success: true });
        } catch (error) {
          console.log("Update Error:", error);
          res.status(500).send({ message: "Failed to update status" });
        }
      },
    );
    // Get: Get tracking history by tracking ID
    app.get("/track/:trackingId", async (req, res) => {
      try {
        const trackingId = req.params.trackingId;

        const parcel = await parcelCollection.findOne({ trackingId });

        if (!parcel) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        const updates = await trackingsCollection
          .find({ trackingId })
          .sort({ updatedAt: -1 })
          .toArray();

        res.send({ parcel, updates });
      } catch (error) {
        console.log("Track API Error:", error);
        res.status(500).send({ message: "Failed to load tracking data" });
      }
    });
    // Get: Get delivered parcels for the logged-in rider (rider only)
    app.get(
      "/parcels/delivered",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const email = req.decoded.email;

          const result = await parcelCollection
            .find({
              riderEmail: email,
              delivery_status: "delivered",
            })
            .project({
              trackingId: 1,
              parcelName: 1,
              receiverName: 1,
              receiverPhone: 1,
              receiverAddress: 1,
              delivery_status: 1,
              earning: 1, // 🔥 MUST
              updatedAt: 1,
              isCashedOut: 1, // 🔥 MUST
            })
            .sort({ updatedAt: -1 })
            .toArray();

          res.send(result);
        } catch (error) {
          console.log("Delivered Error:", error);
          res.status(500).send({ message: "Failed to load deliveries" });
        }
      },
    );
    app.post("/cashout", verifyFBToken, verifyRider, async (req, res) => {
      try {
        const email = req.decoded.email;

        // 🔥 get only unCashOut delivered parcels
        const parcels = await parcelCollection
          .find({
            riderEmail: email,
            delivery_status: "delivered",
            isCashedOut: { $ne: true },
          })
          .toArray();

        if (parcels.length === 0) {
          return res.send({
            success: false,
            message: "No available earnings",
          });
        }

        // 🔥 total earning
        const totalAmount = parcels.reduce(
          (sum, p) => sum + (p.earning || 0),
          0,
        );

        // 🔥 save cashOut request
        const cashOut = {
          riderEmail: email,
          amount: totalAmount,
          status: "pending",
          requestedAt: new Date(),
          parcelIds: parcels.map((p) => p._id),
        };

        await cashOutCollection.insertOne(cashOut);

        // 🔥 mark parcels as cashed out
        await parcelCollection.updateMany(
          { _id: { $in: parcels.map((p) => p._id) } },
          { $set: { isCashedOut: true } },
        );

        res.send({ success: true });
      } catch (error) {
        console.log("CashOut Error:", error);
        res.status(500).send({ message: "CashOut failed" });
      }
    });
    // Get: Get a specific parcel by ID
    app.get("/parcels/:id", verifyFBToken, async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid parcel id" });
        }

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
    // ✅ CREATE PARCEL (PRODUCTION VERSION)
    app.post("/parcels", verifyFBToken, async (req, res) => {
      try {
        const body = req.body;

        // 🔥 Generate tracking ID in backend
        const trackingId = generateTrackingId();

        const newParcel = {
          ...body,
          trackingId,
          delivery_status: "pending",
          paymentStatus: "unpaid",
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        // ✅ Insert parcel
        const result = await parcelCollection.insertOne(newParcel);

        // 🔥 INITIAL TRACKING ENTRY
        await trackingsCollection.insertOne({
          trackingId,
          status: "pending",
          message: "Parcel created",
          updatedAt: new Date(),
          updatedBy: req.decoded.email,
        });

        res.status(201).send({
          success: true,
          message: "Parcel created successfully",
          trackingId, // 🔥 return to frontend
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error("Parcel Create Error:", error);
        res.status(500).send({
          success: false,
          message: "Failed to create parcel",
        });
      }
    });
    // ✅ Delete parcel
    app.delete("/parcels/:id", verifyFBToken, async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid parcel id" });
        }

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

    // Update parcel payment status
    app.patch("/parcels/payment/:id", verifyFBToken, async (req, res) => {
      try {
        const id = req.params.id;

        // ✅ update payment
        await parcelCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              paymentStatus: "paid",
              paymentDate: new Date().toISOString(),
            },
          },
        );

        // ✅ get parcel
        const parcel = await parcelCollection.findOne({
          _id: new ObjectId(id),
        });

        // 🔥 DUPLICATE CHECK (ADD THIS PART)
        const existing = await trackingsCollection.findOne({
          trackingId: parcel.trackingId,
          status: "paid",
        });

        if (!existing) {
          await trackingsCollection.insertOne({
            trackingId: parcel.trackingId,
            status: "paid",
            message: "Payment completed successfully",
            updatedAt: new Date(),
            updatedBy: req.decoded.email,
          });
        }

        res.send({ success: true });
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

    // Rider routes
    app.get("/riders/available", async (req, res) => {
      const { district } = req.query;

      try {
        const riders = await riderCollection
          .find({
            district,
            // status: { $in: ["approved", "active"] },
            // working_status: "available",
          })
          .toArray();

        res.send(riders);
      } catch (error) {
        console.error("Error fetching available riders:", error);
        res.status(500).json({ message: "Failed to get available riders" });
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

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid rider id" });
        }

        const { status } = req.body;

        const rider = await riderCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!rider) {
          return res.status(404).send({ message: "Rider not found" });
        }

        // ✅ Update rider application
        const result = await riderCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status } },
        );

        // 🔥 ADD THIS PART (MAIN FIX)
        if (status === "approved") {
          await userCollection.updateOne(
            { email: rider.userEmail },
            { $set: { role: "rider" } },
          );
        }

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

    // PATCH: Assign rider to parcel (admin only)
    app.patch("/parcels/assign-rider/:id", async (req, res) => {
      const id = req.params.id;
      const { riderId } = req.body;

      const parcel = await parcelCollection.findOne({
        _id: new ObjectId(id),
      });

      // 🔥 get rider info
      const rider = await riderCollection.findOne({
        _id: new ObjectId(riderId),
      });

      // ✅ assign rider + email
      await parcelCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            riderId,
            riderEmail: rider.userEmail,
            delivery_status: "rider_assigned",
            assignedAt: new Date(), // optional but useful
          },
        },
      );

      // tracking (same as before)
      const existing = await trackingsCollection.findOne({
        trackingId: parcel.trackingId,
        status: "rider_assigned",
      });

      if (!existing) {
        await trackingsCollection.insertOne({
          trackingId: parcel.trackingId,
          status: "rider_assigned",
          message: "Rider has been assigned",
          updatedAt: new Date(),
          updatedBy: "admin",
        });
      }

      res.send({ success: true });
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
