const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { ExpressPeerServer } = require("peer");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();

const PORT = process.env.PORT || 4000;
const DB_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DB_DIR, "monitor.db");
const APP_LOGIN_PASSWORD = process.env.APP_LOGIN_PASSWORD || "salom dunyo";

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new sqlite3.Database(DB_PATH);

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(String(password)).digest("hex");
}

const appPasswordHash = hashPassword(APP_LOGIN_PASSWORD);

async function initDb() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      password_hash TEXT,
      proctoring_connected INTEGER NOT NULL DEFAULT 0,
      camera_active INTEGER NOT NULL DEFAULT 0,
      proctoring_error TEXT,
      current_skill TEXT,
      violation_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await dbRun(
    "CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)"
  );
}

async function upsertUserProfile({ username, fullName, passwordHash = null }) {
  const now = new Date().toISOString();
  await dbRun(
    `
      INSERT INTO users (
        username,
        full_name,
        password_hash,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(username)
      DO UPDATE SET
        full_name = excluded.full_name,
        password_hash = COALESCE(excluded.password_hash, users.password_hash),
        updated_at = excluded.updated_at
    `,
    [username, fullName, passwordHash, now, now]
  );
}

async function updateUserProctoringState(username, state) {
  const now = new Date().toISOString();
  const setClauses = [];
  const params = [];

  if (state.proctoringConnected !== undefined) {
    setClauses.push("proctoring_connected = ?");
    params.push(state.proctoringConnected);
  }
  if (state.cameraActive !== undefined) {
    setClauses.push("camera_active = ?");
    params.push(state.cameraActive);
  }
  if (state.proctoringError !== undefined) {
    setClauses.push("proctoring_error = ?");
    params.push(state.proctoringError);
  }
  if (state.currentSkill !== undefined) {
    setClauses.push("current_skill = ?");
    params.push(state.currentSkill);
  }
  if (state.violationCount !== undefined) {
    setClauses.push("violation_count = ?");
    params.push(state.violationCount);
  }

  setClauses.push("updated_at = ?");
  params.push(now, username);

  await dbRun(
    `
      UPDATE users
      SET ${setClauses.join(", ")}
      WHERE username = ?
    `,
    params
  );
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const fullName = String(req.body?.fullName || "").trim();
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");

    if (!fullName || !username || !password) {
      res.status(400).json({ success: false, message: "fullName, username and password are required" });
      return;
    }

    const providedHash = hashPassword(password);
    if (providedHash !== appPasswordHash) {
      res.status(401).json({ success: false, message: "Invalid password" });
      return;
    }

    await upsertUserProfile({ username, fullName, passwordHash: providedHash });

    const user = await dbGet(
      `
        SELECT
          username,
          full_name as fullName,
          proctoring_connected as proctoringConnected,
          camera_active as cameraActive,
          proctoring_error as proctoringError,
          current_skill as currentSkill,
          violation_count as violationCount,
          updated_at as updatedAt
        FROM users
        WHERE username = ?
      `,
      [username]
    );

    res.json({ success: true, user });
  } catch (error) {
    console.error("[Auth] login failed:", error.message);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ─── PeerJS server on the same origin/port (Coolify-friendly) ─────────

const peerServer = ExpressPeerServer(server, {
  path: "/",
  allow_discovery: false,
  proxied: true,
});

app.use("/peerjs", peerServer);

peerServer.on("error", (err) => {
  console.error(`[PeerJS] Server error:`, err.message);
});
peerServer.on("connection", (client) => {
  console.log(`[PeerJS] connected: ${client.getId()}`);
});
peerServer.on("disconnect", (client) => {
  console.log(`[PeerJS] disconnected: ${client.getId()}`);
});

app.use(express.static(path.join(__dirname, "public")));

// ─── State ───────────────────────────────────────────────────────────────

const students = new Map();
// Map<socketId, { fullName, username, skill, joinedAt, violations, peerId }>

const monitors = new Map();
// Map<socketId, { peerId }>

function buildStudentList() {
  return Array.from(students, ([id, data]) => ({ id, ...data }));
}

const socketUsers = new Map();
// Map<socketId, username>

// ─── Monitor namespace ──────────────────────────────────────────────────

const monitorNs = io.of("/monitor");

monitorNs.on("connection", (socket) => {
  console.log("[Monitor] connected:", socket.id);

  // Send current student list
  socket.emit("student-list", buildStudentList());

  // Monitor registers its PeerJS peerId
  socket.on("monitor-peer-id", ({ peerId }) => {
    const pid = String(peerId || "").slice(0, 60);
    monitors.set(socket.id, { peerId: pid });
    console.log(`[Monitor] registered peerId: ${pid}`);
    socket.emit("student-list", buildStudentList());
    // Tell all students about this monitor so they can call it
    studentNs.emit("monitor-peer-id", { peerId: pid });
  });

  socket.on("disconnect", () => {
    console.log("[Monitor] disconnected:", socket.id);
    monitors.delete(socket.id);
  });
});

// ─── Student namespace ──────────────────────────────────────────────────

const studentNs = io.of("/student");

studentNs.on("connection", (socket) => {
  console.log("[Student] connected:", socket.id);

  socket.on("register", ({ fullName, username, skill, peerId }) => {
    const info = {
      fullName: String(fullName).slice(0, 100),
      username: String(username).slice(0, 50),
      skill: String(skill).slice(0, 20),
      peerId: String(peerId || "").slice(0, 60),
      joinedAt: new Date().toISOString(),
      violations: 0,
    };
    students.set(socket.id, info);
    socketUsers.set(socket.id, info.username);
    console.log(`[Student] registered: ${info.fullName} (${info.skill}) peer=${info.peerId}`);

    upsertUserProfile({ username: info.username, fullName: info.fullName }).catch((err) => {
      console.error("[DB] upsert user profile failed:", err.message);
    });
    updateUserProctoringState(info.username, {
      proctoringConnected: 1,
      cameraActive: 0,
      currentSkill: info.skill,
      proctoringError: null,
      violationCount: 0,
    }).catch((err) => {
      console.error("[DB] update proctoring state failed:", err.message);
    });

    monitorNs.emit("student-joined", { id: socket.id, ...info });

    // Send existing monitor peerIds so this student can call them
    for (const [, m] of monitors) {
      if (m.peerId) {
        socket.emit("monitor-peer-id", { peerId: m.peerId });
      }
    }
  });

  socket.on("peer-id-update", ({ peerId }) => {
    const student = students.get(socket.id);
    if (!student) return;
    student.peerId = String(peerId || "").slice(0, 60);
    monitorNs.emit("student-peer-update", { id: socket.id, peerId: student.peerId });
  });

  socket.on("proctoring-state", ({ connected, cameraActive, error, skill }) => {
    const student = students.get(socket.id);
    const username = socketUsers.get(socket.id);
    if (!student || !username) return;

    if (typeof connected === "boolean") student.connected = connected;
    if (typeof cameraActive === "boolean") student.cameraActive = cameraActive;
    if (typeof error === "string" || error === null) student.proctoringError = error;
    if (typeof skill === "string" && skill.trim()) student.skill = String(skill).slice(0, 20);

    updateUserProctoringState(username, {
      proctoringConnected: typeof connected === "boolean" ? Number(connected) : undefined,
      cameraActive: typeof cameraActive === "boolean" ? Number(cameraActive) : undefined,
      proctoringError: typeof error === "string" || error === null ? error : undefined,
      currentSkill: typeof skill === "string" && skill.trim() ? String(skill).slice(0, 20) : undefined,
      violationCount: undefined,
    }).catch((err) => {
      console.error("[DB] proctoring-state update failed:", err.message);
    });
  });

  socket.on("violation", ({ type, count }) => {
    const student = students.get(socket.id);
    if (!student) return;
    student.violations = Number(count) || 0;

    const username = socketUsers.get(socket.id);
    if (username) {
      updateUserProctoringState(username, {
        proctoringConnected: undefined,
        cameraActive: undefined,
        proctoringError: undefined,
        currentSkill: undefined,
        violationCount: student.violations,
      }).catch((err) => {
        console.error("[DB] violation update failed:", err.message);
      });
    }

    monitorNs.emit("student-violation", {
      id: socket.id,
      type: String(type).slice(0, 30),
      count: student.violations,
    });
  });

  socket.on("disconnect", () => {
    const student = students.get(socket.id);
    const username = socketUsers.get(socket.id);
    if (username) {
      updateUserProctoringState(username, {
        proctoringConnected: 0,
        cameraActive: 0,
        proctoringError: null,
        currentSkill: student?.skill ?? undefined,
        violationCount: student?.violations ?? undefined,
      }).catch((err) => {
        console.error("[DB] disconnect update failed:", err.message);
      });
      socketUsers.delete(socket.id);
    }

    if (student) {
      console.log(`[Student] disconnected: ${student.fullName}`);
      monitorNs.emit("student-left", { id: socket.id });
      students.delete(socket.id);
    }
  });
});

// ─── LAN IP helper ──────────────────────────────────────────────────────

function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

// ─── Start ──────────────────────────────────────────────────────────────

initDb()
  .then(() => {
    server.listen(PORT, "0.0.0.0", () => {
      const lanIPs = getLanAddresses();
      console.log("\n╔══════════════════════════════════════════════════╗");
      console.log("║     Mockmee Monitoring Server                    ║");
      console.log("╠══════════════════════════════════════════════════╣");
      console.log(`║  Dashboard: http://localhost:${PORT}`);
      console.log(`║  PeerJS:    http://localhost:${PORT}/peerjs`);
      console.log(`║  Auth API:  http://localhost:${PORT}/api/auth/login`);
      for (const ip of lanIPs) {
        console.log(`║  LAN:       http://${ip}:${PORT}`);
      }
      console.log("╠══════════════════════════════════════════════════╣");
      console.log("║  Open the app URL in Coolify or on your LAN     ║");
      console.log("╚══════════════════════════════════════════════════╝\n");
    });
  })
  .catch((error) => {
    console.error("[DB] initialization failed:", error.message);
    process.exit(1);
  });
