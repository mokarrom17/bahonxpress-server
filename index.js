const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

dotenv.config();
const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

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
    const parcelCollection = db.collection("parcels");
    // ✅ GET all parcels
    app.get("/parcels", async (req, res) => {
      const parcels = await parcelCollection.find().toArray();
      res.send(parcels);
    });
    // ✅ GET parcels by user email (optional query param)

    app.get("/parcels", async (req, res) => {
      try {
        const email = req.query.email;

        const query = email ? { userEmail: email } : {};

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

    // ✅ POST new parcel
    app.post("/parcels", async (req, res) => {
      try {
        const parcelData = req.body;

        // Basic validation
        if (!parcelData.trackingId) {
          return res.status(400).json({
            success: false,
            message: "Tracking ID is required",
          });
        }

        if (!parcelData.userEmail) {
          return res.status(400).json({
            success: false,
            message: "User email is required",
          });
        }

        const result = await parcelCollection.insertOne(parcelData);

        res.status(201).json({
          success: true,
          message: "Parcel created successfully",
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error("Parcel Insert Error:", error);
        res.status(500).json({
          success: false,
          message: "Internal Server Error",
        });
      }
    });
    // ✅ Delete parcel
    app.delete("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const result = await parcelCollection.deleteOne({
          _id: new ObjectId(id),
        });

        res.send(result);
      } catch (error) {
        console.error("Error deleting parcel: ", error);
        res.status(500).send({ message: "Failed to delete parcel" });
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

/* ===========================
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
