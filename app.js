if (process.env.NODE_ENV != "production") {
  require("dotenv").config();
}
const express = require("express"),
  app = express(),
  bodyParser = require("body-parser"),
  mongoose = require("mongoose"),
  user = require("./models/user"),
  passport = require("passport"),
  localStrategy = require("passport-local"),
  postsRoutes = require("./routes/posts"),
  commentsRoutes = require("./routes/comments"),
  profileRoutes = require("./routes/profile"),
  likeRoutes = require("./routes/like"),
  friendsRoutes = require("./routes/friends"),
  chatRoutes = require("./routes/chat"),
  authRoutes = require("./routes/auth"),
  methodOverride = require("method-override"),
  Message = require("./models/message"),
  flash = require("connect-flash"),
  http = require("http").createServer(app);
const dbUrl = process.env.DB_URL;
const session = require("express-session");
const PORT = process.env.PORT || 3000;
const MongoDBstore = require("connect-mongo");
//App Config
mongoose.connect(dbUrl, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  useFindAndModify: false,
});

app.use(
  bodyParser.urlencoded({
    extended: true,
  }),
);
const secret = process.env.SECRET || "kkvanonymous";
app.set("view engine", "ejs");
const store = MongoDBstore.create({
  mongoUrl: dbUrl,
  secret,
  touchAfter: 24 * 60 * 60,
});
store.on("error", function (e) {
  console.log("SESSION STORE ERROR", e);
});
app.use(
  require("express-session")({
    store,
    secret,
    resave: false,
    saveUninitialized: false,
  }),
);
app.use(express.static("public"));
app.use(flash());

app.use(passport.initialize());
app.use(passport.session());
passport.use(new localStrategy(user.authenticate()));
passport.serializeUser(user.serializeUser());
passport.deserializeUser(user.deserializeUser());

app.use((req, res, next) => {
  res.locals.currentUser = req.user;
  res.locals.error = req.flash("error");
  res.locals.success = req.flash("success");
  next();
});
app.use(methodOverride("_method"));
app.use("/posts", postsRoutes);
app.use("/posts/:id/comments", commentsRoutes);
app.use(authRoutes);
app.use("/profile/:id", profileRoutes);
app.use(likeRoutes);
app.use(friendsRoutes);
app.use(chatRoutes);

//Socket.io Config
const ioServer = require("socket.io")(http);

// --- Global Chat Namespace (unchanged, plaintext) ---
let globalChat = ioServer.of("/chats"),
  users = {};
globalChat.on("connection", (socket) => {
  socket.on("new-user-joined", (name) => {
    users[socket.id] = name;
    socket.emit("info-message", "Welcome to FakeBook Chat");
    socket.broadcast.emit("user-joined", name);
    globalChat.emit("updateOnlineUsers", Object.values(users));
  });

  socket.on("send-message", (data) => {
    socket.broadcast.emit("receive-message", {
      msg: data.msg,
      name: users[socket.id],
    });
  });

  socket.on("disconnect", () => {
    socket.broadcast.emit("user-left", `${users[socket.id]} has left the chat`);
    delete users[socket.id];
    globalChat.emit("updateOnlineUsers", Object.values(users));
  });
});

// --- Private E2EE Chat Namespace ---
let privateChat = ioServer.of("/private-chat");
// Map userId -> socketId for routing
let privateUsers = {};

privateChat.on("connection", (socket) => {
  // User registers with their userId
  socket.on("register", (userId) => {
    if (typeof userId !== "string" || userId.length > 30) return;
    socket.userId = userId;
    privateUsers[userId] = socket.id;
    socket.join(userId); // join a room named after their userId
  });

  // Relay encrypted message (server never decrypts)
  socket.on("private-message", (data) => {
    if (!socket.userId) return;
    if (
      !data ||
      typeof data.to !== "string" ||
      typeof data.ciphertext !== "string" ||
      typeof data.iv !== "string"
    )
      return;
    if (data.ciphertext.length > 10000 || data.iv.length > 100) return;

    const outgoing = {
      from: socket.userId,
      ciphertext: data.ciphertext,
      iv: data.iv,
      timestamp: new Date(),
    };

    // Send to recipient if online
    privateChat.to(data.to).emit("private-message", outgoing);

    // Persist encrypted message to DB
    Message.create(
      {
        sender: socket.userId,
        recipient: data.to,
        ciphertext: data.ciphertext,
        iv: data.iv,
      },
      (err) => {
        if (err) console.log("Error saving message:", err);
      },
    );
  });

  // Notify typing status
  socket.on("typing", (data) => {
    if (!socket.userId || !data || typeof data.to !== "string") return;
    privateChat.to(data.to).emit("typing", { from: socket.userId });
  });

  socket.on("stop-typing", (data) => {
    if (!socket.userId || !data || typeof data.to !== "string") return;
    privateChat.to(data.to).emit("stop-typing", { from: socket.userId });
  });

  socket.on("disconnect", () => {
    if (socket.userId) {
      delete privateUsers[socket.userId];
    }
  });
});

http.listen(PORT, () => {
  console.log("Starting app at PORT:", PORT);
});
