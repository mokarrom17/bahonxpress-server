const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");

dotenv.config();
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

/* ===================================================
   APP INITIALIZATION
=================================================== */
const app = express();
const port = process.env.PORT || 5000;

// Core Middleware
app.use(cors());
app.use(express.json());

/* ===================================================
   FIREBASE ADMIN INITIALIZATION
=================================================== */
const decodedKey = Buffer.from(process.env.FB_Service_Key, "base64").toString(
  "utf8",
);
const serviceAccount = JSON.parse(decodedKey);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

/* ===================================================
   MONGODB CONNECTION
=================================================== */
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.olgdgso.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

/* ===================================================
   MAIN SERVER FUNCTION
=================================================== */
async function run() {
  try {
    // await client.connect();

    /* --------------------------------------------------
       DATABASE COLLECTIONS
    -------------------------------------------------- */
    const db = client.db("parcelDB");
    const userCollection = db.collection("users");
    const parcelCollection = db.collection("parcels");
    const trackingsCollection = db.collection("trackings");
    const paymentCollection = db.collection("payments");
    const riderCollection = db.collection("riderApplications");
    const cashOutCollection = db.collection("cashOut");

    /* --------------------------------------------------
       UTILITY: Tracking ID Generator
       Format: BX-YYYYMMDD-XXXXXAAAA
    -------------------------------------------------- */
    const generateTrackingId = () => {
      const date = new Date();
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      const timestamp = Date.now().toString().slice(-5);
      const random = Math.random().toString(36).substring(2, 6).toUpperCase();
      return `BX-${year}${month}${day}-${timestamp}${random}`;
    };

    /* ==================================================
       MIDDLEWARE
    ================================================== */

    // Firebase Token Verification — সব protected route এ ব্যবহার হয়
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

    // Admin Verification — verifyFBToken এর পরে ব্যবহার করতে হবে
    const verifyAdmin = async (req, res, next) => {
      const user = await userCollection.findOne({ email: req.decoded.email });
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "Forbidden access" });
      }
      next();
    };

    // Rider Verification — verifyFBToken এর পরে ব্যবহার করতে হবে
    const verifyRider = async (req, res, next) => {
      const user = await userCollection.findOne({ email: req.decoded.email });
      if (!user || user.role !== "rider") {
        return res.status(403).send({ message: "Rider only access" });
      }
      next();
    };

    /* ==================================================
       USER ROUTES
    ================================================== */

    // POST /users — নতুন user তৈরি বা last login আপডেট
    app.post("/users", async (req, res) => {
      try {
        const email = req.body.email;
        const userExists = await userCollection.findOne({ email });

        if (userExists) {
          await userCollection.updateOne(
            { email },
            { $set: { lastLogin: new Date().toISOString() } },
          );
          return res.send({ message: "User already exists", inserted: false });
        }

        const result = await userCollection.insertOne(req.body);
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to create user" });
      }
    });

    // GET /users/me — নিজের profile data load করা
    app.get("/users/me", verifyFBToken, async (req, res) => {
      try {
        const user = await userCollection.findOne({ email: req.decoded.email });
        res.send(user);
      } catch (error) {
        res.status(500).send({ message: "Failed to load profile" });
      }
    });

    // ✅ এখানে যোগ করো
    // PATCH /users/profile — নিজের profile update করা
    app.patch("/users/profile", verifyFBToken, async (req, res) => {
      try {
        const {
          name,
          phone,
          alternatePhone,
          gender,
          dateOfBirth,
          nid,
          emergencyContact,
          district,
          address,
          photoURL,
        } = req.body;
        const result = await userCollection.updateOne(
          { email: req.decoded.email },
          {
            $set: {
              name,
              phone,
              alternatePhone,
              gender,
              dateOfBirth,
              nid,
              emergencyContact,
              district,
              address,
              photoURL,
              updatedAt: new Date(),
            },
          },
        );
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to update profile" });
      }
    });

    // GET /users/search — email দিয়ে user খোঁজা (admin only)
    // ⚠️ /users/:email/role এর আগে থাকতে হবে
    app.get("/users/search", verifyFBToken, verifyAdmin, async (req, res) => {
      const emailQuery = req.query.email;

      if (!emailQuery) {
        return res.status(400).send({ message: "Email query required" });
      }

      try {
        const regex = new RegExp(`^${emailQuery}`, "i");
        const users = await userCollection
          .find({ email: { $regex: regex } })
          .project({ email: 1, createdAt: 1, role: 1 })
          .limit(10)
          .toArray();

        res.send(users);
      } catch (error) {
        res.status(500).send({ message: "Error searching users" });
      }
    });

    // GET /users/:email/role — user এর role জানা (public)
    app.get("/users/:email/role", async (req, res) => {
      try {
        const email = req.params.email;

        if (!email) {
          return res.status(400).send({ message: "Email required" });
        }

        const user = await userCollection.findOne({ email });
        const role = user?.role || "user";

        res.send({ role });
      } catch (error) {
        res.status(500).send({ message: "Server error" });
      }
    });

    // PATCH /users/:id/admin — user কে admin বানানো বা সরানো (admin only)
    app.patch(
      "/users/:id/admin",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { isAdmin } = req.body;
          const role = isAdmin ? "admin" : "user";

          const result = await userCollection.updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { role } },
          );

          res.send(result);
        } catch (error) {
          res.status(500).send({ message: "Failed to update role" });
        }
      },
    );

    /* ==================================================
       PARCEL ROUTES
       ⚠️ ROUTE ORDER (IMPORTANT):
          Specific routes → Dynamic :id route
          নিচের order ঠিক রাখতে হবে, নাহলে :id সব ধরে ফেলবে
    ================================================== */

    // GET /parcels — সব বা নিজের পার্সেল (role-based)
    app.get("/parcels", verifyFBToken, async (req, res) => {
      try {
        const email = req.query.email;
        const status = req.query.status;
        const decodedEmail = req.decoded.email;

        const user = await userCollection.findOne({ email: decodedEmail });

        let query = {};

        if (user?.role !== "admin") {
          if (email !== decodedEmail) {
            return res.status(403).send({ message: "Forbidden access" });
          }
          query.userEmail = decodedEmail;
        }

        if (status && status !== "all") {
          query.delivery_status = status;
        }

        const parcels = await parcelCollection
          .find(query)
          .sort({ createdAt: -1 })
          .toArray();

        res.send(parcels);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch parcels" });
      }
    });

    // GET /parcels/pending — paid কিন্তু rider assign হয়নি (admin only)
    app.get(
      "/parcels/pending",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const parcels = await parcelCollection
            .find({ paymentStatus: "paid", delivery_status: "pending" })
            .sort({ createdAt: 1 })
            .toArray();

          res.send(parcels);
        } catch (error) {
          res.status(500).send({ message: "Failed to load parcels" });
        }
      },
    );

    // GET /parcels/assigned — rider assign হয়েছে এমন সব পার্সেল (admin only)
    app.get(
      "/parcels/assigned",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const result = await parcelCollection
            .find({ riderEmail: { $exists: true } })
            .sort({ assignedAt: -1 })
            .toArray();

          res.send(result);
        } catch (error) {
          res.status(500).send({ message: "Failed to load parcels" });
        }
      },
    );

    // GET /parcels/my-assigned — rider এর নিজের assigned পার্সেল (rider only)
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
          res.status(500).send({ message: "Failed to load rider parcels" });
        }
      },
    );

    // GET /parcels/delivered — rider এর সম্পন্ন ডেলিভারি (rider only)
    app.get(
      "/parcels/delivered",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const email = req.decoded.email;

          const result = await parcelCollection
            .find({ riderEmail: email, delivery_status: "delivered" })
            .project({
              trackingId: 1,
              parcelName: 1,
              receiverName: 1,
              receiverPhone: 1,
              receiverAddress: 1,
              delivery_status: 1,
              earning: 1,
              updatedAt: 1,
              isCashedOut: 1,
            })
            .sort({ updatedAt: -1 })
            .toArray();

          res.send(result);
        } catch (error) {
          res.status(500).send({ message: "Failed to load deliveries" });
        }
      },
    );

    // GET /parcels/delivery-trend — দৈনিক ডেলিভারি trend data (chart এর জন্য)
    // ⚠️ এই route অবশ্যই /parcels/:id এর আগে থাকতে হবে
    app.get("/parcels/delivery-trend", async (req, res) => {
      try {
        const parcels = await parcelCollection
          .find({ delivery_status: "delivered", deliveryDate: { $ne: null } })
          .toArray();

        const result = {};

        parcels.forEach((p) => {
          if (!p.deliveryDate) return;
          const date = new Date(p.deliveryDate);
          if (isNaN(date)) return;
          const formatted = date.toISOString().split("T")[0];
          result[formatted] = (result[formatted] || 0) + 1;
        });

        const finalData = Object.keys(result)
          .sort()
          .map((date) => ({ date, total: result[date] }));

        res.send(finalData);
      } catch (error) {
        res.status(500).send({ message: "Failed to load delivery trend" });
      }
    });

    // GET /parcels/delivery/status-count — delivery status অনুযায়ী count (chart)
    // ⚠️ এই route অবশ্যই /parcels/:id এর আগে থাকতে হবে
    app.get(
      "/parcels/delivery/status-count",
      verifyFBToken,
      async (req, res) => {
        try {
          const pipeline = [
            { $group: { _id: "$delivery_status", count: { $sum: 1 } } },
            { $project: { status: "$_id", count: 1, _id: 0 } },
          ];

          const result = await parcelCollection.aggregate(pipeline).toArray();
          res.send(result);
        } catch (error) {
          res.status(500).send({ message: "Failed to load status counts" });
        }
      },
    );

    // GET /stats/revenue-monthly — মাসিক revenue (admin only)
    app.get(
      "/stats/revenue-monthly",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const pipeline = [
            {
              $group: {
                _id: {
                  year: { $year: { $toDate: "$createdAt" } },
                  month: { $month: { $toDate: "$createdAt" } },
                },
                total: { $sum: "$amount" },
              },
            },
            { $sort: { "_id.year": 1, "_id.month": 1 } },
            { $limit: 12 },
          ];

          const result = await paymentCollection.aggregate(pipeline).toArray();

          const monthNames = [
            "Jan",
            "Feb",
            "Mar",
            "Apr",
            "May",
            "Jun",
            "Jul",
            "Aug",
            "Sep",
            "Oct",
            "Nov",
            "Dec",
          ];

          const formatted = result.map((r) => ({
            month: `${monthNames[r._id.month - 1]} ${r._id.year}`,
            revenue: r.total,
          }));

          res.send(formatted);
        } catch (error) {
          res.status(500).send({ message: "Failed to load revenue data" });
        }
      },
    );

    // GET /stats/delivery-revenue — মাসিক delivery count + revenue একসাথে (admin only)
    app.get(
      "/stats/delivery-revenue",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const [deliveries, revenues] = await Promise.all([
            // প্রতি মাসে কতটা delivered হয়েছে
            parcelCollection
              .aggregate([
                {
                  $match: {
                    delivery_status: "delivered",
                    deliveryDate: { $ne: null },
                  },
                },
                {
                  $group: {
                    _id: {
                      year: { $year: { $toDate: "$deliveryDate" } },
                      month: { $month: { $toDate: "$deliveryDate" } },
                    },
                    deliveries: { $sum: 1 },
                  },
                },
                { $sort: { "_id.year": 1, "_id.month": 1 } },
                { $limit: 12 },
              ])
              .toArray(),

            // প্রতি মাসে কত revenue
            paymentCollection
              .aggregate([
                {
                  $group: {
                    _id: {
                      year: { $year: { $toDate: "$createdAt" } },
                      month: { $month: { $toDate: "$createdAt" } },
                    },
                    revenue: { $sum: "$amount" },
                  },
                },
                { $sort: { "_id.year": 1, "_id.month": 1 } },
                { $limit: 12 },
              ])
              .toArray(),
          ]);

          const monthNames = [
            "Jan",
            "Feb",
            "Mar",
            "Apr",
            "May",
            "Jun",
            "Jul",
            "Aug",
            "Sep",
            "Oct",
            "Nov",
            "Dec",
          ];

          // সব unique মাস collect করা
          const monthMap = {};

          deliveries.forEach((d) => {
            const key = `${d._id.year}-${String(d._id.month).padStart(2, "0")}`;
            monthMap[key] = {
              month: `${monthNames[d._id.month - 1]} ${d._id.year}`,
              deliveries: d.deliveries,
              revenue: 0,
            };
          });

          revenues.forEach((r) => {
            const key = `${r._id.year}-${String(r._id.month).padStart(2, "0")}`;
            if (monthMap[key]) {
              monthMap[key].revenue = r.revenue;
            } else {
              monthMap[key] = {
                month: `${monthNames[r._id.month - 1]} ${r._id.year}`,
                deliveries: 0,
                revenue: r.revenue,
              };
            }
          });

          const result = Object.keys(monthMap)
            .sort()
            .map((key) => monthMap[key]);

          res.send(result);
        } catch (error) {
          res.status(500).send({ message: "Failed to load comparison data" });
        }
      },
    );

    // GET /parcels/:id — নির্দিষ্ট একটি পার্সেল (owner only)
    // ⚠️ সব specific parcel route এর পরে রাখতে হবে
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
        res.status(500).json({ message: "Server error" });
      }
    });

    // POST /parcels — নতুন পার্সেল তৈরি (authenticated user)
    app.post("/parcels", verifyFBToken, async (req, res) => {
      try {
        const trackingId = generateTrackingId();

        const newParcel = {
          ...req.body,
          trackingId,
          delivery_status: "pending",
          paymentStatus: "unpaid",
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await parcelCollection.insertOne(newParcel);

        // প্রথম tracking entry
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
          trackingId,
          insertedId: result.insertedId,
        });
      } catch (error) {
        res
          .status(500)
          .send({ success: false, message: "Failed to create parcel" });
      }
    });

    // PATCH /parcels/payment/:id — payment সম্পন্ন হলে status আপডেট
    app.patch("/parcels/payment/:id", verifyFBToken, async (req, res) => {
      try {
        const id = req.params.id;

        await parcelCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              paymentStatus: "paid",
              paymentDate: new Date().toISOString(),
            },
          },
        );

        const parcel = await parcelCollection.findOne({
          _id: new ObjectId(id),
        });

        // duplicate check
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
        res.status(500).json({ message: "Failed to update payment status" });
      }
    });

    // PATCH /parcels/assign-rider/:id — পার্সেলে rider assign করা (admin only)
    app.patch(
      "/parcels/assign-rider/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const id = req.params.id;
          const { riderId } = req.body;

          const parcel = await parcelCollection.findOne({
            _id: new ObjectId(id),
          });
          const rider = await riderCollection.findOne({
            _id: new ObjectId(riderId),
          });

          if (!parcel || !rider) {
            return res
              .status(404)
              .send({ message: "Parcel or Rider not found" });
          }

          await parcelCollection.updateOne(
            { _id: new ObjectId(id) },
            {
              $set: {
                riderId,
                riderEmail: rider.userEmail,
                delivery_status: "rider_assigned",
                assignedAt: new Date(),
              },
            },
          );

          // duplicate tracking check
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
              updatedBy: req.decoded.email,
            });
          }

          res.send({ success: true });
        } catch (error) {
          res.status(500).send({ message: "Failed to assign rider" });
        }
      },
    );

    // PATCH /parcels/update-status/:id — delivery status আপডেট (rider only)
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

          // status flow: rider_assigned → picked → in_transit → delivered
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

          let updateData = { delivery_status: status, updatedAt: new Date() };

          // delivered হলে rider এর earning calculate করা হয়
          if (status === "delivered" && !parcel.deliveryDate) {
            const total = parcel.cost?.total || 0;
            const isSameDistrict =
              parcel.senderDistrict === parcel.receiverDistrict;
            const earning = isSameDistrict ? total * 0.6 : total * 0.85;

            updateData.earning = Math.round(earning);
            updateData.isCashedOut = false;
            updateData.deliveryDate = new Date();
          }

          await parcelCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: updateData },
          );

          // tracking history update
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
          res.status(500).send({ message: "Failed to update status" });
        }
      },
    );

    // DELETE /parcels/:id — পার্সেল মুছে ফেলা (owner only)
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
        res.status(500).send({ message: "Failed to delete parcel" });
      }
    });

    /* ==================================================
       TRACKING ROUTES
    ================================================== */

    // GET /track/:trackingId — tracking ID দিয়ে পার্সেলের ইতিহাস (public)
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
        res.status(500).send({ message: "Failed to load tracking data" });
      }
    });

    /* ==================================================
       PAYMENT ROUTES
    ================================================== */

    // POST /create-payment-intent — Stripe payment intent তৈরি
    app.post("/create-payment-intent", verifyFBToken, async (req, res) => {
      try {
        const { amountInCents } = req.body;

        if (!amountInCents || amountInCents < 1) {
          return res.status(400).json({ error: "Invalid amount" });
        }

        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCents,
          currency: "usd",
          payment_method_types: ["card"],
        });

        res.send({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // POST /payments — payment history সংরক্ষণ
    app.post("/payments", verifyFBToken, async (req, res) => {
      try {
        const paymentInfo = {
          ...req.body,
          userEmail: req.decoded.email,
          createdAt: new Date().toISOString(),
        };

        const result = await paymentCollection.insertOne(paymentInfo);
        res.send(result);
      } catch (error) {
        res.status(500).json({ message: "Failed to save payment history" });
      }
    });

    // GET /payments — নিজের payment history দেখা
    app.get("/payments", verifyFBToken, async (req, res) => {
      try {
        const email = req.query.email;

        if (!email) return res.status(400).json({ message: "Email required" });

        if (email !== req.decoded.email) {
          return res.status(403).json({ message: "Forbidden access" });
        }

        const result = await paymentCollection
          .find({ userEmail: email })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(result);
      } catch (error) {
        res.status(500).json({ message: "Failed to get payment history" });
      }
    });

    /* ==================================================
       RIDER ROUTES
    ================================================== */

    // GET /riders/available — নির্দিষ্ট district এর available rider (public)
    app.get("/riders/available", async (req, res) => {
      try {
        const { district } = req.query;

        const riders = await riderCollection.find({ district }).toArray();
        res.send(riders);
      } catch (error) {
        res.status(500).json({ message: "Failed to get available riders" });
      }
    });

    // GET /riders/pending — pending rider applications (admin only)
    app.get("/riders/pending", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const pendingRiders = await riderCollection
          .find({ status: "pending" })
          .toArray();

        res.send(pendingRiders);
      } catch (error) {
        res.status(500).send({ message: "Failed to load pending riders" });
      }
    });

    // GET /riders/active — সব approved/active rider (admin only)
    app.get("/riders/active", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const activeRiders = await riderCollection
          .find({ status: "approved" })
          .toArray();

        res.send(activeRiders);
      } catch (error) {
        res.status(500).send({ message: "Failed to load active riders" });
      }
    });

    // POST /riders — rider application জমা দেওয়া
    app.post("/riders", async (req, res) => {
      try {
        const result = await riderCollection.insertOne(req.body);
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to submit application" });
      }
    });

    // PATCH /riders/status/:id — rider approve/reject/deactivate (admin only)
    app.patch(
      "/riders/status/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
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

          const result = await riderCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status } },
          );

          // approve হলে user collection এও role আপডেট
          if (status === "approved") {
            await userCollection.updateOne(
              { email: rider.userEmail },
              { $set: { role: "rider" } },
            );
          }

          // deactivate হলে role user এ ফিরিয়ে দেওয়া
          if (status === "deactivated") {
            await userCollection.updateOne(
              { email: rider.userEmail },
              { $set: { role: "user" } },
            );
          }

          res.send(result);
        } catch (error) {
          res.status(500).send({ message: "Failed to update rider status" });
        }
      },
    );

    /* ==================================================
       CASH OUT ROUTES
    ================================================== */

    // POST /cashout — rider এর pending earning cash out request (rider only)
    app.post("/cashout", verifyFBToken, verifyRider, async (req, res) => {
      try {
        const email = req.decoded.email;

        // cash out হয়নি এমন delivered পার্সেল খোঁজা
        const parcels = await parcelCollection
          .find({
            riderEmail: email,
            delivery_status: "delivered",
            isCashedOut: { $ne: true },
          })
          .toArray();

        if (parcels.length === 0) {
          return res.send({ success: false, message: "No available earnings" });
        }

        const totalAmount = parcels.reduce(
          (sum, p) => sum + (p.earning || 0),
          0,
        );

        await cashOutCollection.insertOne({
          riderEmail: email,
          amount: totalAmount,
          status: "pending",
          requestedAt: new Date(),
          parcelIds: parcels.map((p) => p._id),
        });

        // পার্সেলগুলো cashed out হিসেবে mark করা
        await parcelCollection.updateMany(
          { _id: { $in: parcels.map((p) => p._id) } },
          { $set: { isCashedOut: true } },
        );

        res.send({ success: true });
      } catch (error) {
        res.status(500).send({ message: "CashOut failed" });
      }
    });

    /* ==================================================
       DASHBOARD STATS ROUTES
    ================================================== */

    // GET /stats/user — regular user এর dashboard stats
    app.get("/stats/user", verifyFBToken, async (req, res) => {
      try {
        const email = req.decoded.email;

        const [total, paid, unpaid, delivered, inTransit] = await Promise.all([
          parcelCollection.countDocuments({ userEmail: email }),
          parcelCollection.countDocuments({
            userEmail: email,
            paymentStatus: "paid",
          }),
          parcelCollection.countDocuments({
            userEmail: email,
            paymentStatus: "unpaid",
          }),
          parcelCollection.countDocuments({
            userEmail: email,
            delivery_status: "delivered",
          }),
          parcelCollection.countDocuments({
            userEmail: email,
            delivery_status: "in_transit",
          }),
        ]);

        const recentParcels = await parcelCollection
          .find({ userEmail: email })
          .sort({ createdAt: -1 })
          .limit(5)
          .project({
            trackingId: 1,
            delivery_status: 1,
            paymentStatus: 1,
            cost: 1,
            createdAt: 1,
            senderDistrict: 1,
            receiverDistrict: 1,
          })
          .toArray();

        res.send({ total, paid, unpaid, delivered, inTransit, recentParcels });
      } catch (error) {
        res.status(500).send({ message: "Failed to load user stats" });
      }
    });

    // GET /stats/admin — admin dashboard stats
    app.get("/stats/admin", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const [
          totalParcels,
          pendingParcels,
          deliveredParcels,
          totalUsers,
          totalRiders,
          pendingRiders,
          totalRevenue,
        ] = await Promise.all([
          parcelCollection.countDocuments({}),
          parcelCollection.countDocuments({
            delivery_status: "pending",
            paymentStatus: "paid",
          }),
          parcelCollection.countDocuments({ delivery_status: "delivered" }),
          userCollection.countDocuments({ role: { $ne: "admin" } }),
          userCollection.countDocuments({ role: "rider" }),
          riderCollection.countDocuments({ status: "pending" }),
          paymentCollection
            .aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }])
            .toArray(),
        ]);

        res.send({
          totalParcels,
          pendingParcels,
          deliveredParcels,
          totalUsers,
          totalRiders,
          pendingRiders,
          revenue: totalRevenue[0]?.total || 0,
        });
      } catch (error) {
        res.status(500).send({ message: "Failed to load admin stats" });
      }
    });

    // GET /stats/rider-performance — rider performance analytics (admin only)
    app.get(
      "/stats/rider-performance",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const result = await parcelCollection
            .aggregate([
              {
                $match: {
                  delivery_status: "delivered",
                  riderEmail: { $ne: null },
                },
              },

              {
                $group: {
                  _id: "$riderEmail",

                  deliveries: {
                    $sum: 1,
                  },

                  earnings: {
                    $sum: "$earning",
                  },
                },
              },

              // lookup rider info
              {
                $lookup: {
                  from: "riderApplications",
                  localField: "_id",
                  foreignField: "userEmail",
                  as: "riderInfo",
                },
              },

              // safer unwind
              {
                $unwind: {
                  path: "$riderInfo",
                  preserveNullAndEmptyArrays: true,
                },
              },

              // final output
              {
                $project: {
                  _id: 0,

                  rider: {
                    $ifNull: ["$riderInfo.userName", "$_id"],
                  },

                  deliveries: 1,

                  earnings: 1,
                },
              },

              {
                $sort: {
                  deliveries: -1,
                },
              },

              {
                $limit: 7,
              },
            ])
            .toArray();

          res.send(result);
        } catch (error) {
          console.log("RIDER PERFORMANCE ERROR:", error);

          res.status(500).send({
            message: "Failed to fetch rider analytics",
          });
        }
      },
    );

    // GET /stats/business-insights — ব্যবসার জন্য গুরুত্বপূর্ণ insights (admin only)
    app.get(
      "/stats/business-insights",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          // ================================
          // TOP RIDER
          // ================================
          const topRider = await parcelCollection
            .aggregate([
              {
                $match: {
                  delivery_status: "delivered",

                  riderEmail: {
                    $ne: null,
                  },
                },
              },

              {
                $group: {
                  _id: "$riderEmail",

                  deliveries: {
                    $sum: 1,
                  },

                  earnings: {
                    $sum: "$earning",
                  },
                },
              },

              // 🔥 JOIN RIDERS COLLECTION
              {
                $lookup: {
                  from: "riderApplications",

                  localField: "_id",

                  foreignField: "userEmail",

                  as: "riderInfo",
                },
              },

              // 🔥 SAFE UNWIND
              {
                $unwind: {
                  path: "$riderInfo",

                  preserveNullAndEmptyArrays: true,
                },
              },

              // 🔥 FINAL SHAPE
              {
                $project: {
                  _id: 0,

                  rider: {
                    $ifNull: ["$riderInfo.userName", "$_id"],
                  },

                  deliveries: 1,

                  earnings: 1,
                },
              },

              {
                $sort: {
                  deliveries: -1,
                },
              },

              {
                $limit: 1,
              },
            ])
            .toArray();

          // ================================
          // MOST POPULAR ROUTE
          // ================================
          const topRoute = await parcelCollection
            .aggregate([
              {
                $group: {
                  _id: {
                    from: "$senderDistrict",

                    to: "$receiverDistrict",
                  },

                  total: {
                    $sum: 1,
                  },
                },
              },

              {
                $sort: {
                  total: -1,
                },
              },

              {
                $limit: 1,
              },
            ])
            .toArray();

          // ================================
          // BEST REVENUE MONTH
          // ================================
          const bestRevenueMonth = await parcelCollection
            .aggregate([
              {
                $match: {
                  paymentStatus: "paid",

                  paymentDate: {
                    $ne: null,
                  },
                },
              },

              {
                $group: {
                  _id: {
                    $dateToString: {
                      format: "%b %Y",

                      date: {
                        $dateFromString: {
                          dateString: "$paymentDate",
                        },
                      },
                    },
                  },

                  revenue: {
                    $sum: "$cost.total",
                  },
                },
              },

              {
                $sort: {
                  revenue: -1,
                },
              },

              {
                $limit: 1,
              },
            ])
            .toArray();

          res.send({
            topRider: topRider[0],

            topRoute: topRoute[0],

            bestRevenueMonth: bestRevenueMonth[0],
          });
        } catch (error) {
          console.log("BUSINESS INSIGHTS ERROR:", error);

          res.status(500).send({
            error: error.message,
          });
        }
      },
    );
    // GET /rider/dashboard-overview — rider dashboard এর জন্য সারাংশ data (rider only)
    app.get(
      "/rider/dashboard-overview",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const email = req.decoded.email;

          // Rider User Info
          const user = await userCollection.findOne({ email });

          // Rider Stats
          const [assigned, delivered, cashedOut] = await Promise.all([
            parcelCollection.countDocuments({
              riderEmail: email,
              delivery_status: {
                $in: ["rider_assigned", "picked", "in_transit"],
              },
            }),

            parcelCollection.countDocuments({
              riderEmail: email,
              delivery_status: "delivered",
            }),

            parcelCollection.countDocuments({
              riderEmail: email,
              delivery_status: "delivered",
              isCashedOut: true,
            }),
          ]);

          // Pending Earnings
          const earningAgg = await parcelCollection
            .aggregate([
              {
                $match: {
                  riderEmail: email,
                  delivery_status: "delivered",
                  isCashedOut: { $ne: true },
                },
              },

              {
                $group: {
                  _id: null,
                  total: {
                    $sum: "$earning",
                  },
                },
              },
            ])
            .toArray();

          res.send({
            rider: {
              name: user?.name,
              email: user?.email,
              photoURL: user?.photoURL,
            },

            stats: {
              assigned,
              delivered,
              cashedOut,
              pendingEarning: earningAgg[0]?.total || 0,
            },
          });
        } catch (error) {
          console.log("RIDER DASHBOARD ERROR:", error);

          res.status(500).send({
            message: "Failed to load rider dashboard data",
          });
        }
      },
    );

    // GET /rider/recent-deliveries — rider এর recent 5 deliveries (rider only)
    app.get(
      "/rider/recent-deliveries",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const email = req.decoded.email;

          const recentDeliveries = await parcelCollection
            .find({
              riderEmail: email,
              delivery_status: "delivered",
            })
            .project({
              trackingId: 1,
              receiverName: 1,
              receiverAddress: 1,
              delivery_status: 1,
              earning: 1,
              deliveryDate: 1,
            })
            .sort({ deliveryDate: -1 })
            .limit(5)
            .toArray();

          res.send(recentDeliveries);
        } catch (error) {
          console.log("RECENT DELIVERIES ERROR:", error);

          res.status(500).send({
            message: "Failed to load recent deliveries",
          });
        }
      },
    );
    // GET /rider/delivery-chart — rider এর delivery status অনুযায়ী পার্সেল count (rider only)
    app.get(
      "/rider/delivery-chart",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const email = req.decoded.email;

          const deliveryStats = await parcelCollection
            .aggregate([
              {
                $match: {
                  riderEmail: email,
                },
              },

              {
                $group: {
                  _id: "$delivery_status",
                  count: {
                    $sum: 1,
                  },
                },
              },
            ])
            .toArray();

          // formatted response
          const formattedData = deliveryStats.map((item) => ({
            status: item._id || "unknown",
            value: item.count,
          }));

          res.send(formattedData);
        } catch (error) {
          console.log("DELIVERY CHART ERROR:", error);

          res.status(500).send({
            message: "Failed to load delivery chart data",
          });
        }
      },
    );

    // GET /stats/rider — rider dashboard stats
    app.get("/stats/rider", verifyFBToken, verifyRider, async (req, res) => {
      try {
        const email = req.decoded.email;

        const [assigned, delivered, cashedOut] = await Promise.all([
          parcelCollection.countDocuments({
            riderEmail: email,
            delivery_status: {
              $in: ["rider_assigned", "picked", "in_transit"],
            },
          }),
          parcelCollection.countDocuments({
            riderEmail: email,
            delivery_status: "delivered",
          }),
          parcelCollection.countDocuments({
            riderEmail: email,
            delivery_status: "delivered",
            isCashedOut: true,
          }),
        ]);

        const earningAgg = await parcelCollection
          .aggregate([
            {
              $match: {
                riderEmail: email,
                delivery_status: "delivered",
                isCashedOut: { $ne: true },
              },
            },
            { $group: { _id: null, total: { $sum: "$earning" } } },
          ])
          .toArray();

        res.send({
          assigned,
          delivered,
          cashedOut,
          pendingEarning: earningAgg[0]?.total || 0,
        });
      } catch (error) {
        res.status(500).send({ message: "Failed to load rider stats" });
      }
    });

    /* --------------------------------------------------
       MongoDB Connection Confirmation
    -------------------------------------------------- */
    // await client.db("admin").command({ ping: 1 });
    // console.log("✅ Connected to MongoDB successfully!");
  } finally {
    // await client.close(); // production এ close করা হয় না
  }
}

run().catch(console.dir);

/* ===================================================
   BASE ROUTES
=================================================== */

// Root — server চলছে কিনা check
app.get("/", (req, res) => {
  res.send("🚀 BahonXpress Parcel Server Running...");
});

// Health Check — deployment monitoring এর জন্য
app.get("/health", (req, res) => {
  res.status(200).json({ status: "OK", timestamp: new Date().toISOString() });
});

/* ===================================================
   START SERVER
=================================================== */
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
