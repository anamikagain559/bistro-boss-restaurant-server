const express = require("express");
const app = express();
const cors = require("cors");
const jwt = require("jsonwebtoken");
require("dotenv").config();
const port = process.env.PORT || 5000;
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
// middleware
app.use(cors());
app.use(express.json());

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.vy8vv76.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

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

    const userCollection = client.db("surveyDB").collection("users");
    const surveyCollection = client.db("surveyDB").collection("surveys");
    const voteCollection = client.db("surveyDB").collection("votes");
    const paymentCollection = client.db("surveyDB").collection("payments");

    // jwt related api
    app.post("/jwt", async (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: "1h",
      });
      res.send({ token });
    });

    // middlewares
    const verifyToken = (req, res, next) => {
      // console.log('inside verify token', req.headers.authorization);
      if (!req.headers.authorization) {
        return res.status(401).send({ message: "unauthorized access" });
      }
      const token = req.headers.authorization.split(" ")[1];
      jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
        if (err) {
          return res.status(401).send({ message: "unauthorized access" });
        }
        req.decoded = decoded;
        next();
      });
    };

    // use verify admin after verifyToken
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email: email };
      const user = await userCollection.findOne(query);
      const isAdmin = user?.role === "admin";
      if (!isAdmin) {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    // users related api
    app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
      const result = await userCollection.find().toArray();
      res.send(result);
    });

    app.get("/users/admin/:email", verifyToken, async (req, res) => {
      const email = req.params.email;

      if (email !== req.decoded.email) {
        return res.status(403).send({ message: "forbidden access" });
      }

      const query = { email: email };
      const user = await userCollection.findOne(query);
      let admin = false;
      if (user) {
        admin = user?.role === "admin";
      }
      res.send({ admin });
    });

    app.post("/users", async (req, res) => {
      const user = req.body;
      // insert email if user doesnt exists:
      // you can do this many ways (1. email unique, 2. upsert 3. simple checking)
      const query = { email: user.email };
      const existingUser = await userCollection.findOne(query);
      if (existingUser) {
        return res.send({ message: "user already exists", insertedId: null });
      }
      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    app.patch(
      "/users/admin/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const filter = { _id: new ObjectId(id) };
        const updatedDoc = {
          $set: {
            role: "admin",
          },
        };
        const result = await userCollection.updateOne(filter, updatedDoc);
        res.send(result);
      }
    );

    app.delete("/users/:id", verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await userCollection.deleteOne(query);
      res.send(result);
    });

    // payment intent
    app.post("/create-payment-intent", async (req, res) => {
      const { price } = req.body;
      const amount = parseInt(price * 100);
      console.log(amount, "amount inside the intent");

      const paymentIntent = await stripe.paymentIntents.create({
        amount: amount,
        currency: "usd",
        payment_method_types: ["card"],
      });

      res.send({
        clientSecret: paymentIntent.client_secret,
      });
    });

    app.post("/payments", async (req, res) => {
      const payment = req.body;
      const paymentResult = await paymentCollection.insertOne(payment);

      //  carefully delete each item from the cart
      console.log("payment info", payment);

      res.send({ paymentResult });
    });

    // backend/server.js
    app.get("/surveys", async (req, res) => {
      const { category, sort } = req.query;
      let filter = {};
      let sortOption = {};

      if (category) {
        filter.category = category;
      }

      if (sort === "votes") {
        sortOption.voteCount = -1; // Sort by vote count in descending order
      }

      try {
        const surveys = await surveyCollection
          .find(filter)
          .sort(sortOption)
          .toArray();
        res.status(200).send(surveys);
      } catch (error) {
        console.error("Error fetching surveys", error);
        res
          .status(500)
          .send({ message: "Internal Server Error", error: error.message });
      }
    });
    // backend/server.js
    app.get("/surveys/:id", async (req, res) => {
      const id = req.params.id;
      try {
        // Ensure the id is a valid ObjectId
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid survey ID" });
        }

        const query = { _id: new ObjectId(id) };
        const result = await surveyCollection.findOne(query);

        if (!result) {
          return res.status(404).json({ error: "Survey not found" });
        }

        res.json(result);
      } catch (error) {
        console.error("Error fetching survey:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    });
    app.post("/surveys/:surveyId/vote", async (req, res) => {
      const surveyId = req.params.surveyId;
      const userId = req.body.userId;
      const option = req.body.option;
      // Check if the user has already voted for this survey
      const existingVote = await voteCollection.findOne({
        userId: userId,
      });
      if (existingVote) {
        return res
          .status(400)
          .send({ message: "You have already voted for this survey" });
      }

      // Update the survey's vote count for the selected option
      const result = await surveyCollection.updateOne(
        { _id: surveyId, "options.text": option },
        { $inc: { "options.$.voteCount": 1 } }
      );
      // Save the user's vote
      await voteCollection.insertOne({
        surveyId: surveyId,
        userId: userId,
        option: option,
      });

      res.status(201).send({ message: "Vote submitted successfully" });
    });

    app.post("/surveys/:surveyId/report", async (req, res) => {
      const surveyId = req.params.surveyId;
      const userId = req.body.userId;

      try {
        // Implement logic to handle reporting
        res.status(200).send({ message: "Survey reported successfully" });
      } catch (error) {
        console.error("Error reporting survey", error);
        res
          .status(500)
          .send({ message: "Internal Server Error", error: error.message });
      }
    });

    app.post("/surveys", async (req, res) => {
      try {
        const surveyData = {
          ...req.body,
          status: "publish",
          timestamp: new Date(),
        };
        const result = await surveyCollection.insertOne(surveyData);
        res.send(result);
      } catch (error) {
        console.error("Error inserting survey", error);
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    app.get("/surveys/user/:userId", async (req, res) => {
      const userId = req.params.userId;
      try {
        const surveys = await surveyCollection
          .find({ userId: userId })
          .toArray();
        res.status(200).send(surveys);
      } catch (error) {
        console.error("Error fetching surveys", error);
        res
          .status(500)
          .send({ message: "Internal Server Error", error: error.message });
      }
    });

    app.get("/surveys/:surveyId/responses", async (req, res) => {
      const surveyId = req.params.surveyId;
      try {
        const responses = await responsesCollection
          .find({ surveyId: surveyId })
          .toArray();
        res.status(200).send(responses);
      } catch (error) {
        console.error("Error fetching responses", error);
        res
          .status(500)
          .send({ message: "Internal Server Error", error: error.message });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("boss is sitting");
});

app.listen(port, () => {
  console.log(`Bistro boss is sitting on port ${port}`);
});

/**
 * --------------------------------
 *      NAMING CONVENTION
 * --------------------------------
 * app.get('/users')
 * app.get('/users/:id')
 * app.post('/users')
 * app.put('/users/:id')
 * app.patch('/users/:id')
 * app.delete('/users/:id')
 *
 */
