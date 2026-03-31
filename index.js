const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { ExpressPeerServer } = require("peer");
const os = require("os");
const path = require("path");

const PORT = process.env.PORT || 4000;

const app = express();
app.set("trust proxy", 1);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
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

// ─── Monitor namespace ──────────────────────────────────────────────────

const monitorNs = io.of("/monitor");

monitorNs.on("connection", (socket) => {
  console.log("[Monitor] connected:", socket.id);

  // Send current student list
  const list = [];
  for (const [id, data] of students) {
    list.push({ id, ...data });
  }
  socket.emit("student-list", list);

  // Monitor registers its PeerJS peerId
  socket.on("monitor-peer-id", ({ peerId }) => {
    const pid = String(peerId || "").slice(0, 60);
    monitors.set(socket.id, { peerId: pid });
    console.log(`[Monitor] registered peerId: ${pid}`);
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
    console.log(`[Student] registered: ${info.fullName} (${info.skill}) peer=${info.peerId}`);

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

  socket.on("violation", ({ type, count }) => {
    const student = students.get(socket.id);
    if (!student) return;
    student.violations = Number(count) || 0;
    monitorNs.emit("student-violation", {
      id: socket.id,
      type: String(type).slice(0, 30),
      count: student.violations,
    });
  });

  socket.on("disconnect", () => {
    const student = students.get(socket.id);
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

server.listen(PORT, "0.0.0.0", () => {
  const lanIPs = getLanAddresses();
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║     Mockmee Monitoring Server                    ║");
  console.log("╠══════════════════════════════════════════════════╣");
  console.log(`║  Dashboard: http://localhost:${PORT}`);
  console.log(`║  PeerJS:    http://localhost:${PORT}/peerjs`);
  for (const ip of lanIPs) {
    console.log(`║  LAN:       http://${ip}:${PORT}`);
  }
  console.log("╠══════════════════════════════════════════════════╣");
  console.log("║  Open the app URL in Coolify or on your LAN     ║");
  console.log("╚══════════════════════════════════════════════════╝\n");
});
