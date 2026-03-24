let express = require("express"),
  route = express.Router(),
  user = require("../models/user"),
  message = require("../models/message"),
  mongoose = require("mongoose"),
  middleWare = require("../middleware");

// GET private chat hub page (friend list + chat area)
route.get("/private-chats", middleWare.isLoggedIn, (req, res) => {
  user.find(
    { _id: { $in: req.user.friends } },
    "_id username",
    (err, friends) => {
      if (err) friends = [];
      res.render("chats/hub", {
        user: req.user,
        friends: friends,
      });
    },
  );
});

// GET private chat page with a friend (still works for direct link)
route.get("/chat/:friendId", middleWare.isLoggedIn, (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.friendId)) {
    req.flash("error", "Invalid user");
    return res.redirect("/friends");
  }
  user.findById(req.params.friendId, (err, friend) => {
    if (err || !friend) {
      req.flash("error", "User not found");
      return res.redirect("/friends");
    }
    // Only allow chatting with friends
    if (!req.user.friends.includes(String(friend._id))) {
      req.flash("error", "You can only chat with friends");
      return res.redirect("/friends");
    }
    res.render("chats/private", {
      user: req.user,
      friend: friend,
    });
  });
});

// PUT save public key for current user
route.put(
  "/api/publickey",
  middleWare.isLoggedIn,
  express.json(),
  (req, res) => {
    const publicKey = req.body.publicKey;
    if (
      !publicKey ||
      typeof publicKey !== "string" ||
      publicKey.length > 1000
    ) {
      return res.status(400).json({ error: "Invalid public key" });
    }
    user.findByIdAndUpdate(req.user._id, { publicKey: publicKey }, (err) => {
      if (err) {
        return res.status(500).json({ error: "Failed to save public key" });
      }
      res.json({ success: true });
    });
  },
);

// GET public key for a specific user (must be friends)
route.get("/api/publickey/:userId", middleWare.isLoggedIn, (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.userId)) {
    return res.status(400).json({ error: "Invalid user ID" });
  }
  if (!req.user.friends.includes(req.params.userId)) {
    return res.status(403).json({ error: "Not authorized" });
  }
  user.findById(req.params.userId, "publicKey username", (err, foundUser) => {
    if (err || !foundUser) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json({
      publicKey: foundUser.publicKey,
      username: foundUser.username,
    });
  });
});

// GET encrypted message history between two users
route.get("/api/messages/:friendId", middleWare.isLoggedIn, (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.friendId)) {
    return res.status(400).json({ error: "Invalid user ID" });
  }
  if (!req.user.friends.includes(req.params.friendId)) {
    return res.status(403).json({ error: "Not authorized" });
  }
  message
    .find({
      $or: [
        { sender: req.user._id, recipient: req.params.friendId },
        { sender: req.params.friendId, recipient: req.user._id },
      ],
    })
    .sort({ timestamp: 1 })
    .limit(200)
    .exec((err, messages) => {
      if (err) {
        return res.status(500).json({ error: "Failed to fetch messages" });
      }
      res.json(
        messages.map((m) => ({
          sender: String(m.sender),
          recipient: String(m.recipient),
          ciphertext: m.ciphertext,
          iv: m.iv,
          timestamp: m.timestamp,
        })),
      );
    });
});

// GET unread counts per friend for current user
route.get("/api/unread-counts", middleWare.isLoggedIn, (req, res) => {
  message.aggregate(
    [
      { $match: { recipient: req.user._id, read: false } },
      { $group: { _id: "$sender", count: { $sum: 1 } } },
    ],
    (err, results) => {
      if (err) return res.status(500).json({ error: "Failed to fetch counts" });
      const counts = {};
      results.forEach((r) => {
        counts[String(r._id)] = r.count;
      });
      res.json(counts);
    },
  );
});

// GET total unread count (for nav badge)
route.get("/api/unread-total", middleWare.isLoggedIn, (req, res) => {
  message.countDocuments(
    { recipient: req.user._id, read: false },
    (err, count) => {
      if (err) return res.status(500).json({ error: "Failed" });
      res.json({ count: count });
    },
  );
});

// GET last message for each friend conversation
route.get("/api/last-messages", middleWare.isLoggedIn, (req, res) => {
  const friendIds = req.user.friends
    .map((f) => {
      try {
        return mongoose.Types.ObjectId(f);
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);

  if (friendIds.length === 0) return res.json([]);

  message.aggregate(
    [
      {
        $match: {
          $or: [
            { sender: req.user._id, recipient: { $in: friendIds } },
            { sender: { $in: friendIds }, recipient: req.user._id },
          ],
        },
      },
      { $sort: { timestamp: -1 } },
      {
        $group: {
          _id: {
            $cond: [
              { $eq: ["$sender", req.user._id] },
              "$recipient",
              "$sender",
            ],
          },
          lastMessage: { $first: "$$ROOT" },
        },
      },
    ],
    (err, results) => {
      if (err) return res.status(500).json({ error: "Failed" });
      res.json(
        results.map((r) => ({
          friendId: String(r._id),
          ciphertext: r.lastMessage.ciphertext,
          iv: r.lastMessage.iv,
          sender: String(r.lastMessage.sender),
          timestamp: r.lastMessage.timestamp,
        })),
      );
    },
  );
});

// PUT mark messages as read from a specific friend
route.put(
  "/api/messages/:friendId/read",
  middleWare.isLoggedIn,
  express.json(),
  (req, res) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.friendId)) {
      return res.status(400).json({ error: "Invalid user ID" });
    }
    if (!req.user.friends.includes(req.params.friendId)) {
      return res.status(403).json({ error: "Not authorized" });
    }
    message.updateMany(
      {
        sender: mongoose.Types.ObjectId(req.params.friendId),
        recipient: req.user._id,
        read: false,
      },
      { $set: { read: true } },
      (err) => {
        if (err) return res.status(500).json({ error: "Failed" });
        res.json({ success: true });
      },
    );
  },
);

module.exports = route;
