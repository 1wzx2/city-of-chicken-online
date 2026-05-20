const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");
const { createRoomStore } = require("./storage");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "public")));

const roomStore = createRoomStore();
const rooms = new Map();
const socketMeta = new Map();

const ROLES = [
  { id: "lazi", no: 1, short: "辣子", name: "辣子鸡丁" },
  { id: "zha", no: 2, short: "炸鸡", name: "炸鸡桶" },
  { id: "kele", no: 3, short: "可乐", name: "可乐鸡翅" },
  { id: "nongtang", no: 4, short: "浓汤", name: "浓鸡汤" },
  { id: "zuozong", no: 5, short: "左宗", name: "左宗鸡" },
  { id: "huang", no: 6, short: "黄焖", name: "黄焖鸡米饭" },
  { id: "yuanyang", no: 7, short: "鸳鸯", name: "鸳鸯鸡" },
  { id: "paojiao", no: 8, short: "泡椒", name: "泡椒鸡爪" },
  { id: "dapan", no: 9, short: "大盘", name: "大盘鸡" },
  { id: "jiangyou", no: 10, short: "酱油", name: "酱油鸡" },
  { id: "baizhan", no: 11, short: "白斩", name: "白斩鸡拼盘" },
  { id: "koushui", no: 12, short: "口水", name: "口水鸡" },
];
const ROLE_BY_ID = Object.fromEntries(ROLES.map((role) => [role.id, role]));
const SKILL_LIMITS = {
  lazi: { total: 1, label: "全局 1 次" },
  zha: { total: 1, rounds: [1, 2, 3, 4], label: "前四轮 1 次" },
  kele: { total: 3, late: 1, label: "全局 3 次，第五/六轮合计 1 次" },
  huang: { total: 3, late: 1, label: "全局 3 次，第五/六轮合计 1 次" },
  yuanyang: { total: 3, late: 1, label: "全局 3 次，第五/六轮合计 1 次" },
  dapan: { total: 3, late: 1, label: "全局 3 次，第五/六轮合计 1 次" },
  jiangyou: { total: 3, late: 1, label: "全局 3 次，第五/六轮合计 1 次" },
};

io.on("connection", (socket) => {
  socket.on("createRoom", (payload, reply) => safeReply(reply, async () => {
    const room = await createRoom(cleanName(payload.name, "房主"));
    const player = room.players[0];
    attachSocket(socket, room, player.id);
    await saveAndBroadcast(room);
    return { room: publicRoom(room, player.id), playerId: player.id, code: room.code };
  }));

  socket.on("joinRoom", (payload, reply) => safeReply(reply, async () => {
    const code = String(payload.code || "").trim().toUpperCase();
    const room = await loadRoom(code);
    if (!room) throw new Error("房间不存在");
    const playerId = payload.playerId && room.players.some((p) => p.id === payload.playerId)
      ? payload.playerId
      : randomId();
    let player = room.players.find((p) => p.id === playerId);
    if (player) {
      player.name = cleanName(payload.name, player.name);
      player.connected = true;
    } else {
      if (room.players.length >= 12) throw new Error("房间最多 12 名玩家");
      player = makePlayer(playerId, cleanName(payload.name, "玩家"));
      room.players.push(player);
    }
    attachSocket(socket, room, player.id);
    await saveAndBroadcast(room);
    return { room: publicRoom(room, player.id), playerId: player.id, code: room.code };
  }));

  socket.on("keepAlive", (payload, reply) => safeReply(reply, async () => {
    const { room, player } = await requireOrRestoreMeta(socket, payload);
    player.connected = true;
    player.lastSeenAt = Date.now();
    await saveRoom(room);
    return { code: room.code };
  }));

  socket.on("rejoinPlayer", (payload, reply) => safeReply(reply, async () => {
    const playerId = String(payload.playerId || "").trim();
    const found = await findRoomByPlayerId(playerId);
    if (!found) throw new Error("没有找到上次加入的房间");
    const { room, player } = found;
    player.name = cleanName(payload.name, player.name);
    player.connected = true;
    attachSocket(socket, room, player.id);
    await saveAndBroadcast(room);
    return { room: publicRoom(room, player.id), playerId: player.id, code: room.code };
  }));

  socket.on("assignRoles", (_, reply) => safeReply(reply, async () => {
    const { room, player } = await requireMeta(socket);
    assertHost(room, player.id);
    const roles = shuffle([...ROLES]);
    room.players.forEach((p, index) => {
      p.roleId = roles[index].id;
    });
    room.status = "playing";
    room.submissions[String(room.round)] = {};
    room.nongtangTargets[String(room.round)] = {};
    room.currentResult = null;
    await saveAndBroadcast(room);
    return { room: publicRoom(room, player.id) };
  }));

  socket.on("setNongtangTarget", (payload, reply) => safeReply(reply, async () => {
    const { room, player } = await requireMeta(socket);
    if (player.roleId !== "nongtang") throw new Error("只有浓鸡汤可以查看玩家出兵。");
    const roundKey = String(room.round);
    room.nongtangTargets = room.nongtangTargets || {};
    room.nongtangTargets[roundKey] = room.nongtangTargets[roundKey] || {};
    if (room.submissions[roundKey] && room.submissions[roundKey][player.id]) throw new Error("你已经提交本轮，不能再更换查看对象。");
    const target = requireOtherPlayer(room, player, payload.targetId, "浓汤查看对象");
    if (hasNongtangViewedBefore(room, player.id, target.id)) throw new Error("浓鸡汤不能重复选择同一个玩家查看。");
    room.nongtangTargets[roundKey][player.id] = target.id;
    await saveAndBroadcast(room);
    return { room: publicRoom(room, player.id) };
  }));

  socket.on("submitRound", (payload, reply) => safeReply(reply, async () => {
    const { room, player } = await requireMeta(socket);
    const roundKey = String(room.round);
    room.submissions[roundKey] = room.submissions[roundKey] || {};
    if (roundJiangyouAdjusted(room)) throw new Error("酱油鸡已经完成调整，本轮提交已锁定，不能再修改。");
    const submission = {
      playerId: player.id,
      placements: normalizePlacements(payload.placements, room.cityCount),
      skill: payload.skill && typeof payload.skill === "object" ? payload.skill : {},
      submittedAt: Date.now(),
    };
    validateSubmission(room, player, submission);
    room.submissions[roundKey][player.id] = {
      ...submission,
      submittedAt: Date.now(),
    };
    room.currentResult = null;
    await saveAndBroadcast(room);
    return { room: publicRoom(room, player.id) };
  }));

  socket.on("adjustJiangyou", (payload, reply) => safeReply(reply, async () => {
    const { room, player } = await requireMeta(socket);
    adjustJiangyou(room, player, payload);
    room.currentResult = null;
    await saveAndBroadcast(room);
    return { room: publicRoom(room, player.id) };
  }));

  socket.on("settleRound", (_, reply) => safeReply(reply, async () => {
    const { room, player } = await requireMeta(socket);
    assertHost(room, player.id);
    validateRoomSubmissions(room);
    room.currentResult = calculateRoom(room);
    await saveAndBroadcast(room);
    return { room: publicRoom(room, player.id) };
  }));

  socket.on("nextRound", (_, reply) => safeReply(reply, async () => {
    const { room, player } = await requireMeta(socket);
    assertHost(room, player.id);
    if (room.currentResult) {
      room.players.forEach((p) => {
        p.history = numberOr(room.currentResult.totals[p.id], p.history);
      });
    }
    room.round = Math.min(6, room.round + 1);
    room.submissions[String(room.round)] = {};
    room.nongtangTargets[String(room.round)] = {};
    room.currentResult = null;
    await saveAndBroadcast(room);
    return { room: publicRoom(room, player.id) };
  }));

  socket.on("leaveRoom", (_, reply) => safeReply(reply, async () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return {};
    socket.leave(meta.code);
    socketMeta.delete(socket.id);
    const room = await loadRoom(meta.code);
    if (room) {
      if (room.hostId === meta.playerId) {
        await deleteRoom(room.code);
        return { dissolved: true };
      }
      const stillConnected = [...socketMeta.values()].some((item) => item.code === meta.code && item.playerId === meta.playerId);
      const player = room.players.find((p) => p.id === meta.playerId);
      if (player && !stillConnected) player.connected = false;
      await saveAndBroadcast(room);
    }
    return {};
  }));

  socket.on("dissolveRoom", (_, reply) => safeReply(reply, async () => {
    const { room, player } = await requireMeta(socket);
    assertHost(room, player.id);
    await deleteRoom(room.code);
    return { dissolved: true };
  }));

  socket.on("disconnect", async () => {
    const meta = socketMeta.get(socket.id);
    socketMeta.delete(socket.id);
    if (!meta) return;
    const room = await loadRoom(meta.code);
    if (!room) return;
    const stillConnected = [...socketMeta.values()].some((item) => item.code === meta.code && item.playerId === meta.playerId);
    const player = room.players.find((p) => p.id === meta.playerId);
    if (player && !stillConnected) player.connected = false;
    await saveAndBroadcast(room);
  });
});

async function createRoom(hostName) {
  const code = await makeRoomCode();
  const host = makePlayer(randomId(), hostName);
  const room = {
    code,
    hostId: host.id,
    status: "lobby",
    round: 1,
    cityCount: 16,
    players: [host],
    submissions: {},
    nongtangTargets: {},
    currentResult: null,
    createdAt: Date.now(),
  };
  await saveRoom(room);
  return room;
}

function makePlayer(id, name) {
  return { id, name, roleId: "", history: 0, connected: true };
}

async function findRoomByPlayerId(playerId) {
  if (!playerId) return null;
  for (const room of rooms.values()) {
    const player = room.players.find((item) => item.id === playerId);
    if (player) return { room, player };
  }
  const room = await roomStore.findRoomByPlayerId(playerId);
  if (!room) return null;
  normalizeRoom(room);
  markPlayersDisconnected(room);
  rooms.set(room.code, room);
  const player = room.players.find((item) => item.id === playerId);
  if (player) return { room, player };
  return null;
}

function attachSocket(socket, room, playerId) {
  socket.join(room.code);
  socketMeta.set(socket.id, { code: room.code, playerId });
}

function normalizeRoom(room) {
  room.code = String(room.code || "").trim().toUpperCase();
  room.hostId = room.hostId || "";
  room.status = room.status || "lobby";
  room.round = numberOr(room.round, 1);
  room.cityCount = numberOr(room.cityCount, 16);
  room.players = Array.isArray(room.players) ? room.players : [];
  room.submissions = room.submissions && typeof room.submissions === "object" ? room.submissions : {};
  room.nongtangTargets = room.nongtangTargets && typeof room.nongtangTargets === "object" ? room.nongtangTargets : {};
  room.currentResult = room.currentResult || null;
  room.createdAt = room.createdAt || Date.now();
  room.players.forEach((player) => {
    player.id = String(player.id || "");
    player.name = cleanName(player.name, "玩家");
    player.roleId = player.roleId || "";
    player.history = numberOr(player.history, 0);
    player.connected = Boolean(player.connected);
  });
  return room;
}

function markPlayersDisconnected(room) {
  room.players.forEach((player) => {
    player.connected = false;
  });
}

async function loadRoom(code) {
  const normalizedCode = String(code || "").trim().toUpperCase();
  if (!normalizedCode) return null;
  const cached = rooms.get(normalizedCode);
  if (cached) return cached;
  const room = await roomStore.getRoom(normalizedCode);
  if (!room) return null;
  normalizeRoom(room);
  markPlayersDisconnected(room);
  rooms.set(room.code, room);
  return room;
}

async function saveRoom(room) {
  normalizeRoom(room);
  rooms.set(room.code, room);
  await roomStore.saveRoom(room);
}

async function saveAndBroadcast(room) {
  await saveRoom(room);
  await broadcast(room.code);
}

async function deleteRoom(code) {
  const normalizedCode = String(code || "").trim().toUpperCase();
  if (!normalizedCode) return;
  rooms.delete(normalizedCode);
  for (const [socketId, meta] of [...socketMeta.entries()]) {
    if (meta.code !== normalizedCode) continue;
    io.to(socketId).emit("roomClosed", { code: normalizedCode });
    io.sockets.sockets.get(socketId)?.leave(normalizedCode);
    socketMeta.delete(socketId);
  }
  await roomStore.deleteRoom(normalizedCode);
}

async function broadcast(code) {
  const room = await loadRoom(code);
  if (!room) return;
  room.players.forEach((player) => {
    const sockets = [...socketMeta.entries()].filter(([, meta]) => meta.code === code && meta.playerId === player.id);
    sockets.forEach(([socketId]) => io.to(socketId).emit("roomState", publicRoom(room, player.id)));
  });
}

function publicRoom(room, viewerId) {
  const roundSubmissions = room.submissions[String(room.round)] || {};
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    round: room.round,
    cityCount: room.cityCount,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      roleId: p.roleId,
      roleName: p.roleId ? ROLE_BY_ID[p.roleId].name : "",
      roleShort: p.roleId ? ROLE_BY_ID[p.roleId].short : "",
      history: p.history,
      connected: p.connected,
      submitted: Boolean(roundSubmissions[p.id]),
    })),
    ownSubmission: roundSubmissions[viewerId] || null,
    skillUsage: publicSkillUsage(room, viewerId),
    allianceAnnouncement: publicAllianceAnnouncement(room),
    allianceInvite: publicAllianceInvite(room, viewerId),
    nongtangView: publicNongtangView(room, viewerId),
    jiangyouView: publicJiangyouView(room, viewerId),
    leaderboard: buildLiveLeaderboard(room),
    currentResult: room.currentResult,
  };
}

function buildLiveLeaderboard(room) {
  const result = room.currentResult;
  return room.players
    .map((player) => ({
      id: player.id,
      name: player.name,
      roleShort: player.roleId ? ROLE_BY_ID[player.roleId].short : "",
      score: result ? numberOr(result.totals[player.id], player.history) : numberOr(player.history, 0),
      submitted: Boolean((room.submissions[String(room.round)] || {})[player.id]),
    }))
    .sort((a, b) => b.score - a.score);
}

function publicAllianceInvite(room, viewerId) {
  const invite = currentAllianceInvite(room, viewerId);
  if (!invite) return null;
  return {
    partnerId: invite.yuanyangPlayer.id,
    partnerName: invite.yuanyangPlayer.name,
    armyLimit: 17,
  };
}

function publicAllianceAnnouncement(room) {
  const alliance = currentAllianceAnnouncement(room);
  if (!alliance) return null;
  return {
    yuanyangId: alliance.yuanyangPlayer.id,
    yuanyangName: alliance.yuanyangPlayer.name,
    partnerId: alliance.partner.id,
    partnerName: alliance.partner.name,
  };
}

function publicNongtangView(room, viewerId) {
  const player = room.players.find((item) => item.id === viewerId);
  if (!player || player.roleId !== "nongtang") return null;
  const roundKey = String(room.round);
  const targetId = room.nongtangTargets && room.nongtangTargets[roundKey] && room.nongtangTargets[roundKey][viewerId];
  if (!targetId) return { targetId: "", targetName: "", targetSubmitted: false, placements: null };
  const target = room.players.find((item) => item.id === targetId);
  const targetSubmission = room.submissions[roundKey] && room.submissions[roundKey][targetId];
  return {
    targetId,
    targetName: target ? target.name : "未知玩家",
    targetSubmitted: Boolean(targetSubmission),
    placements: targetSubmission ? targetSubmission.placements : null,
  };
}

function publicJiangyouView(room, viewerId) {
  const player = room.players.find((item) => item.id === viewerId);
  if (!player || player.roleId !== "jiangyou") return null;
  const roundKey = String(room.round);
  const submissions = room.submissions[roundKey] || {};
  const ownSubmission = submissions[player.id];
  const used = Boolean(ownSubmission && ownSubmission.skill && ownSubmission.skill.used);
  const allSubmitted = room.players.every((item) => Boolean(submissions[item.id]));
  return {
    used,
    allSubmitted,
    adjusted: Boolean(ownSubmission && ownSubmission.skill && ownSubmission.skill.adjusted),
    fromCity: ownSubmission && ownSubmission.skill ? ownSubmission.skill.fromCity || null : null,
    toCity: ownSubmission && ownSubmission.skill ? ownSubmission.skill.toCity || null : null,
    playerPlacements: used && allSubmitted ? buildJiangyouPlayerPlacements(room) : null,
  };
}

function publicSkillUsage(room, playerId) {
  const player = room.players.find((item) => item.id === playerId);
  if (!player || !player.roleId) return null;
  const limit = SKILL_LIMITS[player.roleId];
  const counts = countSkillUses(room, player.id, player.roleId);
  return {
    limited: Boolean(limit),
    rule: limit ? limit.label : "",
    totalUsed: counts.total,
    totalMax: limit ? limit.total : null,
    lateUsed: counts.late,
    lateMax: limit && limit.late ? limit.late : null,
    roundAllowed: !limit || !limit.rounds || limit.rounds.includes(room.round),
  };
}

async function requireMeta(socket) {
  const meta = socketMeta.get(socket.id);
  if (!meta) throw new Error("还没有加入房间");
  const room = await loadRoom(meta.code);
  if (!room) throw new Error("房间不存在");
  const player = room.players.find((p) => p.id === meta.playerId);
  if (!player) throw new Error("玩家不存在");
  return { room, player };
}

async function requireOrRestoreMeta(socket, payload) {
  const meta = socketMeta.get(socket.id);
  if (meta) return requireMeta(socket);
  const code = String((payload && payload.code) || "").trim().toUpperCase();
  const playerId = String((payload && payload.playerId) || "").trim();
  const codedRoom = code ? await loadRoom(code) : null;
  const found = codedRoom
    ? { room: codedRoom, player: codedRoom.players.find((item) => item.id === playerId) }
    : await findRoomByPlayerId(playerId);
  if (!found || !found.room || !found.player) throw new Error("还没有加入房间");
  attachSocket(socket, found.room, found.player.id);
  return found;
}

function assertHost(room, playerId) {
  if (room.hostId !== playerId) throw new Error("只有房主可以操作");
}

async function safeReply(reply, fn) {
  try {
    const result = await fn();
    if (typeof reply === "function") reply({ ok: true, ...result });
  } catch (error) {
    if (typeof reply === "function") reply({ ok: false, message: error.message || "操作失败" });
  }
}

function validateSubmission(room, player, submission) {
  if (!player.roleId) throw new Error("还没有分配角色，不能提交本轮。");
  validateSkill(room, player, submission.skill || {});
  if (player.roleId === "nongtang") {
    const targetId = requireNongtangReady(room, player);
    submission.skill = { ...(submission.skill || {}), targetId };
  }
  validatePlacements(room, player, submission.placements, submission.skill || {});
}

function validatePlacements(room, player, placements, skill) {
  const roleId = player.roleId;
  const limit = armyLimitFor(room, player, skill);
  let used = 0;
  for (let city = 1; city <= room.cityCount; city += 1) {
    const value = numberOr(placements[city], 0);
    if (value < 0) throw new Error(`${city} 城不能投负数兵。`);
    if (value > 12) throw new Error(`${city} 城单人最多只能放 12 兵。`);
    if (roleId !== "koushui" && !Number.isInteger(value)) throw new Error("只有口水鸡可以使用 0.5 兵。");
    used += value;
  }
  if (Math.abs(used - limit) > 0.0001) {
    throw new Error(`${player.name} 本轮必须刚好用完 ${fmt(limit)} 兵，当前用了 ${fmt(used)} 兵。`);
  }
}

function validateSkill(room, player, skill) {
  const roleId = player.roleId;
  if (currentAllianceInvite(room, player.id)) return;
  if (usesLimitedSkill(roleId, skill)) {
    const limit = SKILL_LIMITS[roleId];
    if (limit.rounds && !limit.rounds.includes(room.round)) throw new Error(`${ROLE_BY_ID[roleId].name}只能在第 ${limit.rounds.join("、")} 轮使用技能。`);
    const counts = countSkillUses(room, player.id, roleId, { excludeRound: room.round, includeSkill: skill });
    if (limit.total && counts.total > limit.total) throw new Error(`${ROLE_BY_ID[roleId].name}技能次数已用完：${limit.label}。`);
    if (limit.late && counts.late > limit.late) throw new Error(`${ROLE_BY_ID[roleId].name}在第五/六轮只能使用一次技能。`);
  }

  if (roleId === "zha" && skill.active) {
    requireCity(skill.city, room.cityCount, "炸鸡城池");
  }
  if (roleId === "kele" && skill.active) {
    const cityA = requireCity(skill.cityA, room.cityCount, "可乐城池 A");
    const cityB = requireCity(skill.cityB, room.cityCount, "可乐城池 B");
    if (cityA === cityB) throw new Error("可乐鸡翅不能交换同一个城池。");
    if (Math.abs(cityA - cityB) > 6) throw new Error("可乐鸡翅交换的两个城池实际值差不能超过 6。");
  }
  if (roleId === "nongtang" && skill.targetId) {
    requireOtherPlayer(room, player, skill.targetId, "浓汤查看对象");
  }
  if (roleId === "zuozong" && skill.targetId) {
    requireOtherPlayer(room, player, skill.targetId, "左宗猜测对象");
  }
  if (roleId === "huang" && skill.active) {
    requireCity(skill.city, room.cityCount, "黄焖城池");
  }
  if (roleId === "yuanyang" && skill.active) {
    requireOtherPlayer(room, player, skill.partnerId, "鸳鸯合作玩家");
  }
  if (roleId === "dapan" && skill.active) {
    const extra = numberOr(skill.extra, 0);
    if (extra <= 0) throw new Error("大盘鸡使用加量时，额外兵数必须大于 0。");
    if (extra > 12) throw new Error("大盘鸡额外兵数最多为 12。");
    if (!Number.isInteger(extra)) throw new Error("大盘鸡额外兵数必须是整数。");
  }
  if (roleId === "baizhan") {
    validateBaizhanPredictions(room, skill.predictions);
  }
}

function validateBaizhanPredictions(room, predictions) {
  if (!predictions || typeof predictions !== "object") throw new Error("白斩鸡需要给每名玩家填写总榜预测名次。");
  room.players.forEach((player) => {
    const rank = numberOr(predictions[player.id], NaN);
    if (!Number.isInteger(rank) || rank < 1 || rank > room.players.length) {
      throw new Error(`白斩鸡需要给 ${player.name} 填写 1 到 ${room.players.length} 之间的整数名次。`);
    }
  });
}

function requireNongtangReady(room, player) {
  const roundKey = String(room.round);
  const targetId = room.nongtangTargets && room.nongtangTargets[roundKey] && room.nongtangTargets[roundKey][player.id];
  if (!targetId) throw new Error("浓鸡汤需要先选择查看对象，等对方提交后再提交自己的出兵。");
  const targetSubmission = room.submissions[roundKey] && room.submissions[roundKey][targetId];
  if (!targetSubmission) {
    const target = room.players.find((item) => item.id === targetId);
    throw new Error(`${target ? target.name : "查看对象"} 还没有提交，浓鸡汤需要等对方提交后再出兵。`);
  }
  return targetId;
}

function requireCity(value, cityCount, label) {
  const city = numberOr(value, NaN);
  if (!Number.isInteger(city) || city < 1 || city > cityCount) throw new Error(`${label}必须是 1 到 ${cityCount} 的整数。`);
  return city;
}

function requireOtherPlayer(room, player, targetId, label) {
  if (!targetId) throw new Error(`请选择${label}。`);
  if (targetId === player.id) throw new Error(`${label}不能选择自己。`);
  const target = room.players.find((item) => item.id === targetId);
  if (!target) throw new Error(`${label}不存在。`);
  return target;
}

function countSkillUses(room, playerId, roleId, options = {}) {
  let total = 0;
  let late = 0;
  Object.entries(room.submissions).forEach(([roundKey, submissions]) => {
    const round = Number(roundKey);
    if (round === options.excludeRound) return;
    const submission = submissions[playerId];
    if (!submission || !usesLimitedSkill(roleId, submission.skill || {})) return;
    total += 1;
    if (isLateRound(round)) late += 1;
  });
  if (options.includeSkill && usesLimitedSkill(roleId, options.includeSkill)) {
    total += 1;
    if (isLateRound(room.round)) late += 1;
  }
  return { total, late };
}

function hasNongtangViewedBefore(room, playerId, targetId) {
  return Object.entries(room.nongtangTargets || {}).some(([roundKey, targets]) => Number(roundKey) !== room.round && targets[playerId] === targetId);
}

function validateRoomSubmissions(room) {
  const submissions = room.submissions[String(room.round)] || {};
  room.players.forEach((player) => {
    const submission = submissions[player.id];
    if (!submission) return;
    validateSubmission(room, player, submission);
    if (player.roleId === "jiangyou" && submission.skill && submission.skill.used && !submission.skill.adjusted) {
      throw new Error("酱油鸡已使用技能，需要等全员提交后确认调整，完成后才能结算。");
    }
  });
}

function adjustJiangyou(room, player, payload) {
  if (player.roleId !== "jiangyou") throw new Error("只有酱油鸡可以调整出兵。");
  const roundKey = String(room.round);
  const submissions = room.submissions[roundKey] || {};
  const submission = submissions[player.id];
  if (!submission) throw new Error("酱油鸡需要先提交本轮出兵，并勾选使用技能。");
  if (!submission.skill || !submission.skill.used) throw new Error("本轮没有开启酱油鸡技能。");
  if (submission.skill.adjusted) throw new Error("酱油鸡本轮已经调整过，不能再次调整。");
  if (!room.players.every((item) => Boolean(submissions[item.id]))) throw new Error("需要等待所有玩家提交后，酱油鸡才能查看每名玩家的兵力分布并调整。");

  const fromCity = requireCity(payload.fromCity, room.cityCount, "酱油移出城池");
  const toCity = requireCity(payload.toCity, room.cityCount, "酱油移入城池");
  if (fromCity !== toCity) {
    if (numberOr(submission.placements[fromCity], 0) < 1) throw new Error(`${fromCity} 城没有可移动的 1 个兵。`);
    if (numberOr(submission.placements[toCity], 0) + 1 > 12) throw new Error(`${toCity} 城移动后会超过单城 12 兵上限。`);
    submission.placements[fromCity] = numberOr(submission.placements[fromCity], 0) - 1;
    submission.placements[toCity] = numberOr(submission.placements[toCity], 0) + 1;
  }
  submission.skill = {
    ...submission.skill,
    adjusted: true,
    fromCity,
    toCity,
  };
  submission.adjustedAt = Date.now();
  validateSubmission(room, player, submission);
}

function roundJiangyouAdjusted(room) {
  const submissions = room.submissions[String(room.round)] || {};
  return room.players.some((player) => {
    const submission = submissions[player.id];
    return player.roleId === "jiangyou" && submission && submission.skill && submission.skill.adjusted;
  });
}

function buildJiangyouPlayerPlacements(room) {
  const submissions = room.submissions[String(room.round)] || {};
  return room.players.map((player) => ({
    playerId: player.id,
    name: player.name,
    roleShort: player.roleId ? ROLE_BY_ID[player.roleId].short : "",
    placements: submissions[player.id] && submissions[player.id].placements ? submissions[player.id].placements : normalizePlacements({}, room.cityCount),
  }));
}

function armyLimitFor(room, player, skill) {
  if (player.roleId === "yuanyang" && skill && skill.active) return 17;
  const invite = currentAllianceInvite(room, player.id);
  if (invite) return 17;
  if (player.roleId === "dapan" && skill && skill.active) return 12 + Math.min(12, Math.max(0, numberOr(skill.extra, 0)));
  return 12;
}

function currentAllianceInvite(room, viewerId) {
  const alliance = currentAllianceAnnouncement(room);
  if (!alliance || alliance.partner.id !== viewerId) return null;
  return { yuanyangPlayer: alliance.yuanyangPlayer };
}

function currentAllianceAnnouncement(room) {
  const yuanyangPlayer = room.players.find((player) => player.roleId === "yuanyang");
  if (!yuanyangPlayer) return null;
  const yuanyangSubmission = (room.submissions[String(room.round)] || {})[yuanyangPlayer.id];
  const skill = yuanyangSubmission ? yuanyangSubmission.skill || {} : {};
  if (!skill.active || !skill.partnerId || skill.partnerId === yuanyangPlayer.id) return null;
  const partner = room.players.find((player) => player.id === skill.partnerId);
  if (!partner) return null;
  return { yuanyangPlayer, partner };
}

function usesLimitedSkill(roleId, skill) {
  if (!SKILL_LIMITS[roleId]) return false;
  if (roleId === "jiangyou") return Boolean(skill.used);
  return Boolean(skill.active);
}

function isLateRound(round) {
  return round === 5 || round === 6;
}

function calculateRoom(room) {
  const players = room.players;
  const playerById = Object.fromEntries(players.map((player) => [player.id, player]));
  const roundMultiplier = room.round >= 5 ? 2 : 1;
  const cityNums = Array.from({ length: room.cityCount }, (_, index) => index + 1);
  const submissions = room.submissions[String(room.round)] || {};
  const raw = {};
  const adjusted = {};
  const skillByPlayer = {};
  const roundScores = {};
  const breakdowns = {};
  const cityWonByPlayer = {};
  const cityResults = [];
  const warnings = [];

  players.forEach((player) => {
    const sub = submissions[player.id] || {};
    raw[player.id] = normalizePlacements(sub.placements, room.cityCount);
    adjusted[player.id] = { ...raw[player.id] };
    skillByPlayer[player.id] = sub.skill || {};
    roundScores[player.id] = 0;
    breakdowns[player.id] = [];
    cityWonByPlayer[player.id] = new Set();
  });

  const rolePlayer = (roleId) => players.find((player) => player.roleId === roleId);
  const yuanyangPlayer = rolePlayer("yuanyang");
  const yuanyangSkill = yuanyangPlayer ? skillByPlayer[yuanyangPlayer.id] : {};
  const yuanyangActive =
    Boolean(yuanyangPlayer) &&
    Boolean(yuanyangSkill.active) &&
    Boolean(yuanyangSkill.partnerId) &&
    Boolean(playerById[yuanyangSkill.partnerId]) &&
    yuanyangSkill.partnerId !== yuanyangPlayer.id;
  const allianceMembers = yuanyangActive ? [yuanyangPlayer.id, yuanyangSkill.partnerId] : [];
  const blockedSkillPlayerIds = new Set(yuanyangActive ? [yuanyangSkill.partnerId] : []);

  const actualValues = {};
  cityNums.forEach((city) => {
    actualValues[city] = city;
  });

  const kelePlayer = rolePlayer("kele");
  const keleSkill = kelePlayer ? skillByPlayer[kelePlayer.id] : {};
  if (kelePlayer && keleSkill.active && !blockedSkillPlayerIds.has(kelePlayer.id)) {
    const cityA = clampCity(keleSkill.cityA, room.cityCount);
    const cityB = clampCity(keleSkill.cityB, room.cityCount);
    if (cityA !== cityB && Math.abs(actualValues[cityA] - actualValues[cityB]) <= 6) {
      [actualValues[cityA], actualValues[cityB]] = [actualValues[cityB], actualValues[cityA]];
    }
  }

  const laziPlayer = rolePlayer("lazi");
  const laziSkill = laziPlayer ? skillByPlayer[laziPlayer.id] : {};
  if (laziPlayer && laziSkill.active && !blockedSkillPlayerIds.has(laziPlayer.id)) {
    cityNums.forEach((city) => {
      if (raw[laziPlayer.id][city] > 0) {
        players.forEach((player) => {
          if (player.id !== laziPlayer.id && raw[player.id][city] > 0) adjusted[player.id][city] -= 3;
        });
      }
    });
  }

  const entities = buildEntities(players, yuanyangActive, allianceMembers);
  const zhaPlayer = rolePlayer("zha");
  const zhaSkill = zhaPlayer ? skillByPlayer[zhaPlayer.id] : {};
  const bombActive = Boolean(zhaPlayer && zhaSkill.active && room.round <= 4 && !blockedSkillPlayerIds.has(zhaPlayer.id));
  const bombCity = bombActive ? clampCity(zhaSkill.city, room.cityCount) : null;
  const huangPlayer = rolePlayer("huang");
  const huangSkill = huangPlayer ? skillByPlayer[huangPlayer.id] : {};
  const huangActive = Boolean(huangPlayer && huangSkill.active && !blockedSkillPlayerIds.has(huangPlayer.id));
  const huangCity = huangActive ? clampCity(huangSkill.city, room.cityCount) : null;

  cityNums.forEach((city) => {
    const baseScore = actualValues[city] * roundMultiplier;
    const entries = entities.map((entity) => ({
      ...entity,
      value: entity.members.reduce((sum, playerId) => sum + adjusted[playerId][city], 0),
    }));
    const result = { city, value: actualValues[city], winnerLabel: "", formula: "" };

    if (bombActive && city === bombCity) {
      const destroyed = players.reduce((sum, player) => sum + Math.max(0, raw[player.id][city]), 0);
      addPoints(zhaPlayer.id, destroyed * roundMultiplier, `${city}城炸鸡`, roundScores, breakdowns);
      result.formula = `炸鸡摧毁 ${fmt(destroyed)} 兵，${zhaPlayer.name} +${fmt(destroyed * roundMultiplier)}。`;
      cityResults.push(result);
      return;
    }

    const winner = findHighestUnique(entries);
    if (winner) {
      const boosted = huangActive && city === huangCity;
      const score = baseScore * (boosted ? 2 : 1);
      addEntityPoints(winner, score, `${city}城`, roundScores, breakdowns);
      winner.members.forEach((playerId) => cityWonByPlayer[playerId].add(city));
      result.winnerLabel = winner.label;
      result.formula = `${winner.label} 以 ${fmt(winner.value)} 兵胜出，得 ${fmt(score)}。`;
    } else {
      result.formula = "本城无人得分。";
    }

    if (huangActive && city === huangCity) {
      const winnerMembers = new Set(winner ? winner.members : []);
      const losers = players.filter((player) => raw[player.id][city] > 0 && !winnerMembers.has(player.id));
      losers.forEach((player) => addPoints(player.id, -baseScore, `${city}城黄焖失败`, roundScores, breakdowns));
      if (losers.length) result.formula += ` 黄焖失败进城者各扣 ${fmt(baseScore)}：${losers.map((p) => p.name).join("、")}。`;
    }
    cityResults.push(result);
  });

  applyDapan(players, skillByPlayer, raw, cityNums, cityWonByPlayer, roundMultiplier, blockedSkillPlayerIds, roundScores, breakdowns);
  const prePaojiaoRoundScores = cloneScores(roundScores);
  const prePaojiaoTotals = {};
  players.forEach((player) => {
    prePaojiaoTotals[player.id] = numberOr(player.history, 0) + prePaojiaoRoundScores[player.id];
  });
  applyPaojiao(players, skillByPlayer, prePaojiaoRoundScores, roundMultiplier, blockedSkillPlayerIds, roundScores, breakdowns);
  applyZuozong(players, skillByPlayer, prePaojiaoRoundScores, blockedSkillPlayerIds, roundScores, breakdowns);
  applyBaizhan(players, skillByPlayer, prePaojiaoTotals, blockedSkillPlayerIds, roundScores, breakdowns);

  const totals = {};
  players.forEach((player) => {
    totals[player.id] = numberOr(player.history, 0) + roundScores[player.id];
  });

  const ranking = players
    .map((player) => ({
      id: player.id,
      name: player.name,
      roleShort: ROLE_BY_ID[player.roleId] ? ROLE_BY_ID[player.roleId].short : "",
      round: fmt(roundScores[player.id]),
      total: fmt(totals[player.id]),
      formula: buildPlayerFormula(player.id, player.history, breakdowns, totals),
    }))
    .sort((a, b) => Number(b.total) - Number(a.total));
  const skillEvents = buildSkillEvents(players, skillByPlayer, {
    playerById,
    blockedSkillPlayerIds,
    yuanyangActive,
    bombActive,
    bombCity,
    huangCity,
    raw,
    roundMultiplier,
    breakdowns,
    prePaojiaoTotals,
  });

  return {
    round: room.round,
    roundScores,
    totals,
    ranking,
    cityResults: cityResults.sort((a, b) => b.city - a.city),
    skillEvents,
    warnings,
    settledAt: Date.now(),
  };
}

function applyDapan(players, skillByPlayer, raw, cityNums, cityWonByPlayer, roundMultiplier, blocked, scores, breakdowns) {
  const player = players.find((item) => item.roleId === "dapan");
  if (!player || blocked.has(player.id) || !skillByPlayer[player.id].active) return;
  let wasted = 0;
  cityNums.forEach((city) => {
    if (!cityWonByPlayer[player.id].has(city)) wasted += Math.max(0, raw[player.id][city]);
  });
  if (wasted > 0) addPoints(player.id, -2 * wasted * roundMultiplier, "大盘未得分兵扣分", scores, breakdowns);
}

function applyPaojiao(players, skillByPlayer, snapshot, roundMultiplier, blocked, scores, breakdowns) {
  const player = players.find((item) => item.roleId === "paojiao");
  if (!player || blocked.has(player.id) || skillByPlayer[player.id].auto === false) return;
  const totals = players.map((item) => ({ id: item.id, total: numberOr(item.history, 0) + snapshot[item.id] }));
  const min = Math.min(...totals.map((item) => item.total));
  const lowest = totals.filter((item) => Math.abs(item.total - min) < 0.0001);
  if (lowest.length === 1 && lowest[0].id === player.id) {
    const steal = 2 * roundMultiplier;
    players.forEach((other) => {
      if (other.id !== player.id) addPoints(other.id, -steal, "泡椒被偷", scores, breakdowns);
    });
    addPoints(player.id, steal * (players.length - 1), "泡椒偷分", scores, breakdowns);
  }
}

function applyZuozong(players, skillByPlayer, snapshot, blocked, scores, breakdowns) {
  const player = players.find((item) => item.roleId === "zuozong");
  if (!player || blocked.has(player.id)) return;
  const target = skillByPlayer[player.id].targetId;
  if (!target) return;
  const sorted = players.map((item) => snapshot[item.id]).sort((a, b) => a - b);
  const threshold = sorted[Math.min(2, sorted.length - 1)];
  if (snapshot[target] <= threshold) addPoints(player.id, 10, "左宗猜中", scores, breakdowns);
}

function applyBaizhan(players, skillByPlayer, prePaojiaoTotals, blocked, scores, breakdowns) {
  const player = players.find((item) => item.roleId === "baizhan");
  if (!player || blocked.has(player.id)) return;
  const correct = countBaizhanCorrect(players, skillByPlayer[player.id].predictions, prePaojiaoTotals);
  if (correct > 0) addPoints(player.id, correct * 2, "白斩预测", scores, breakdowns);
}

function countBaizhanCorrect(players, predictions, prePaojiaoTotals) {
  if (!predictions || typeof predictions !== "object") return 0;
  const ranks = buildRankMap(players, prePaojiaoTotals);
  return players.reduce((count, player) => {
    const predicted = numberOr(predictions[player.id], NaN);
    return count + (predicted === ranks[player.id] ? 1 : 0);
  }, 0);
}

function buildRankMap(players, scores) {
  const sorted = players
    .map((player) => ({ id: player.id, score: numberOr(scores[player.id], 0) }))
    .sort((a, b) => b.score - a.score);
  const ranks = {};
  let previousScore = null;
  let previousRank = 0;
  sorted.forEach((item, index) => {
    if (previousScore !== null && Math.abs(item.score - previousScore) < 0.0001) {
      ranks[item.id] = previousRank;
    } else {
      previousRank = index + 1;
      previousScore = item.score;
      ranks[item.id] = previousRank;
    }
  });
  return ranks;
}

function buildSkillEvents(players, skillByPlayer, ctx) {
  return players.map((player) => {
    const role = ROLE_BY_ID[player.roleId];
    const skill = skillByPlayer[player.id] || {};
    const base = {
      playerId: player.id,
      title: `${player.name}（${role ? role.short : "无"}）`,
      status: "未使用",
      detail: "本轮没有记录主动技能发动。",
    };
    if (!role) return base;
    if (ctx.blockedSkillPlayerIds.has(player.id)) return { ...base, status: "被锁定", detail: "鸳鸯合作玩家本轮不能使用自己的技能。" };
    if (player.roleId === "lazi") return skill.active ? { ...base, status: "已发动", detail: "同城其他玩家兵力 -3。" } : base;
    if (player.roleId === "zha") return skill.active ? { ...base, status: ctx.bombActive ? "已发动" : "未生效", detail: ctx.bombActive ? `炸 ${ctx.bombCity} 城。` : "炸鸡只能在前四轮使用。" } : base;
    if (player.roleId === "kele") return skill.active ? { ...base, status: "已发动", detail: `尝试交换 ${skill.cityA || 1} 城和 ${skill.cityB || 2} 城。` } : base;
    if (player.roleId === "nongtang") return skill.targetId ? { ...base, status: "已发动", detail: `查看 ${targetName(ctx.playerById, skill.targetId)}。` } : base;
    if (player.roleId === "zuozong") return skill.targetId ? { ...base, status: hasBreakdown(player.id, "左宗", ctx.breakdowns) ? "猜中" : "未猜中", detail: `猜 ${targetName(ctx.playerById, skill.targetId)}。` } : base;
    if (player.roleId === "huang") return skill.active ? { ...base, status: "已发动", detail: `指定 ${ctx.huangCity} 城，胜者翻倍，失败进城者扣分。` } : base;
    if (player.roleId === "yuanyang") return skill.active ? { ...base, status: ctx.yuanyangActive ? "已发动" : "未生效", detail: ctx.yuanyangActive ? `与 ${targetName(ctx.playerById, skill.partnerId)} 合作，收益平分。` : "合作玩家无效。" } : base;
    if (player.roleId === "paojiao") return { ...base, status: hasBreakdown(player.id, "泡椒偷分", ctx.breakdowns) ? "已触发" : "未触发", detail: `泡椒偷分前累计 ${fmt(ctx.prePaojiaoTotals[player.id])}。` };
    if (player.roleId === "dapan") return skill.active ? { ...base, status: "已发动", detail: `额外 ${fmt(skill.extra || 0)} 兵，扣分 ${fmt(Math.abs(pointsByLabel(player.id, "大盘", ctx.breakdowns)))}。` } : base;
    if (player.roleId === "jiangyou") return skill.used ? {
      ...base,
      status: skill.adjusted ? "已发动" : "待调整",
      detail: skill.adjusted
        ? (skill.fromCity === skill.toCity ? `查看每名玩家兵力分布后，选择原地不动（${skill.fromCity} 城）。` : `查看每名玩家兵力分布后，将 1 兵从 ${skill.fromCity} 城移动到 ${skill.toCity} 城。`)
        : "已声明使用，等待全员提交后查看分布并调整。",
    } : base;
    if (player.roleId === "baizhan") {
      const correct = countBaizhanCorrect(players, skill.predictions, ctx.prePaojiaoTotals);
      return skill.predictions ? { ...base, status: "已发动", detail: `总榜名次预测正确 ${fmt(correct)} 人，得 ${fmt(pointsByLabel(player.id, "白斩", ctx.breakdowns))} 分。` } : base;
    }
    if (player.roleId === "koushui") return { ...base, status: "被动", detail: "允许使用 0.5 兵。" };
    return base;
  });
}

function buildEntities(players, yuanyangActive, allianceMembers) {
  const alliance = new Set(allianceMembers);
  const entities = players.filter((player) => !alliance.has(player.id)).map((player) => ({ label: player.name, members: [player.id] }));
  if (yuanyangActive) {
    entities.push({ label: allianceMembers.map((id) => players.find((player) => player.id === id).name).join(" + "), members: allianceMembers });
  }
  return entities;
}

function findHighestUnique(entries) {
  const groups = new Map();
  entries.forEach((entry) => {
    const key = String(roundTiny(entry.value));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  });
  const values = [...groups.keys()].map(Number).sort((a, b) => b - a);
  for (const value of values) {
    if (value <= 0) continue;
    const group = groups.get(String(value));
    if (group.length === 1) return group[0];
  }
  return null;
}

function addEntityPoints(entity, points, label, scores, breakdowns) {
  const share = points / entity.members.length;
  entity.members.forEach((id) => addPoints(id, share, entity.members.length > 1 ? `${label}平分` : label, scores, breakdowns));
}

function addPoints(id, points, label, scores, breakdowns) {
  scores[id] += points;
  breakdowns[id].push({ label, points });
}

function buildPlayerFormula(playerId, history, breakdowns, totals) {
  const chunks = [`历史 ${fmt(history)}`];
  (breakdowns[playerId] || []).forEach((item) => chunks.push(`${item.points >= 0 ? "+" : "-"} ${item.label} ${fmt(Math.abs(item.points))}`));
  chunks.push(`= ${fmt(totals[playerId])}`);
  return chunks.join(" ");
}

function pointsByLabel(id, pattern, breakdowns) {
  return (breakdowns[id] || []).filter((item) => item.label.includes(pattern)).reduce((sum, item) => sum + item.points, 0);
}

function hasBreakdown(id, pattern, breakdowns) {
  return (breakdowns[id] || []).some((item) => item.label.includes(pattern));
}

function targetName(playerById, id) {
  return playerById[id] ? playerById[id].name : "未知玩家";
}

function normalizePlacements(input, cityCount) {
  const placements = {};
  for (let city = 1; city <= cityCount; city += 1) placements[city] = numberOr(input && input[city], 0);
  return placements;
}

async function makeRoomCode() {
  let code = "";
  do {
    code = Math.random().toString(36).slice(2, 8).toUpperCase();
  } while (rooms.has(code) || await roomStore.roomCodeExists(code));
  return code;
}

function randomId() {
  return crypto.randomBytes(8).toString("hex");
}

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function cloneScores(scores) {
  return Object.fromEntries(Object.entries(scores).map(([id, score]) => [id, score]));
}

function cleanName(name, fallback) {
  const value = String(name || "").trim();
  return value ? value.slice(0, 16) : fallback;
}

function clampCity(value, cityCount) {
  return clampNumber(value, 1, cityCount, 1);
}

function clampNumber(value, min, max, fallback) {
  return Math.min(max, Math.max(min, numberOr(value, fallback)));
}

function numberOr(value, fallback) {
  if (value === "" || value === null || value === undefined) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundTiny(value) {
  return Math.round(Number(value) * 1000000) / 1000000;
}

function fmt(value) {
  const number = roundTiny(value);
  return Number.isInteger(number) ? number : Number(number.toFixed(2));
}

roomStore.init().then(() => {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`City of Chicken online server: http://localhost:${PORT}`);
  });
}).catch((error) => {
  console.error("Failed to initialize room storage", error);
  process.exit(1);
});

