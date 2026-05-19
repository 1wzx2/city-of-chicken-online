const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "public")));

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
  socket.on("createRoom", (payload, reply) => safeReply(reply, () => {
    const room = createRoom(cleanName(payload.name, "房主"));
    const player = room.players[0];
    attachSocket(socket, room, player.id);
    broadcast(room.code);
    return { room: publicRoom(room, player.id), playerId: player.id, code: room.code };
  }));

  socket.on("joinRoom", (payload, reply) => safeReply(reply, () => {
    const code = String(payload.code || "").trim().toUpperCase();
    const room = rooms.get(code);
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
    broadcast(room.code);
    return { room: publicRoom(room, player.id), playerId: player.id, code: room.code };
  }));

  socket.on("assignRoles", (_, reply) => safeReply(reply, () => {
    const { room, player } = requireMeta(socket);
    assertHost(room, player.id);
    const roles = shuffle([...ROLES]);
    room.players.forEach((p, index) => {
      p.roleId = roles[index].id;
    });
    room.status = "playing";
    room.submissions[String(room.round)] = {};
    room.currentResult = null;
    broadcast(room.code);
    return { room: publicRoom(room, player.id) };
  }));

  socket.on("submitRound", (payload, reply) => safeReply(reply, () => {
    const { room, player } = requireMeta(socket);
    const roundKey = String(room.round);
    room.submissions[roundKey] = room.submissions[roundKey] || {};
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
    broadcast(room.code);
    return { room: publicRoom(room, player.id) };
  }));

  socket.on("settleRound", (_, reply) => safeReply(reply, () => {
    const { room, player } = requireMeta(socket);
    assertHost(room, player.id);
    room.currentResult = calculateRoom(room);
    broadcast(room.code);
    return { room: publicRoom(room, player.id) };
  }));

  socket.on("nextRound", (_, reply) => safeReply(reply, () => {
    const { room, player } = requireMeta(socket);
    assertHost(room, player.id);
    if (room.currentResult) {
      room.players.forEach((p) => {
        p.history = numberOr(room.currentResult.totals[p.id], p.history);
      });
    }
    room.round = Math.min(6, room.round + 1);
    room.submissions[String(room.round)] = {};
    room.currentResult = null;
    broadcast(room.code);
    return { room: publicRoom(room, player.id) };
  }));

  socket.on("leaveRoom", (_, reply) => safeReply(reply, () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return {};
    socket.leave(meta.code);
    socketMeta.delete(socket.id);
    const room = rooms.get(meta.code);
    if (room) {
      const stillConnected = [...socketMeta.values()].some((item) => item.code === meta.code && item.playerId === meta.playerId);
      const player = room.players.find((p) => p.id === meta.playerId);
      if (player && !stillConnected) player.connected = false;
      broadcast(room.code);
    }
    return {};
  }));

  socket.on("disconnect", () => {
    const meta = socketMeta.get(socket.id);
    socketMeta.delete(socket.id);
    if (!meta) return;
    const room = rooms.get(meta.code);
    if (!room) return;
    const stillConnected = [...socketMeta.values()].some((item) => item.code === meta.code && item.playerId === meta.playerId);
    const player = room.players.find((p) => p.id === meta.playerId);
    if (player && !stillConnected) player.connected = false;
    broadcast(room.code);
  });
});

function createRoom(hostName) {
  const code = makeRoomCode();
  const host = makePlayer(randomId(), hostName);
  const room = {
    code,
    hostId: host.id,
    status: "lobby",
    round: 1,
    cityCount: 16,
    players: [host],
    submissions: {},
    currentResult: null,
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function makePlayer(id, name) {
  return { id, name, roleId: "", history: 0, connected: true };
}

function attachSocket(socket, room, playerId) {
  socket.join(room.code);
  socketMeta.set(socket.id, { code: room.code, playerId });
}

function broadcast(code) {
  const room = rooms.get(code);
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
    currentResult: room.currentResult,
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

function requireMeta(socket) {
  const meta = socketMeta.get(socket.id);
  if (!meta) throw new Error("还没有加入房间");
  const room = rooms.get(meta.code);
  if (!room) throw new Error("房间不存在");
  const player = room.players.find((p) => p.id === meta.playerId);
  if (!player) throw new Error("玩家不存在");
  return { room, player };
}

function assertHost(room, playerId) {
  if (room.hostId !== playerId) throw new Error("只有房主可以操作");
}

function safeReply(reply, fn) {
  try {
    reply({ ok: true, ...fn() });
  } catch (error) {
    reply({ ok: false, message: error.message || "操作失败" });
  }
}

function validateSubmission(room, player, submission) {
  if (!player.roleId) throw new Error("还没有分配角色，不能提交本轮。");
  validatePlacements(room, player, submission.placements);
  validateSkill(room, player, submission.skill || {});
}

function validatePlacements(room, player, placements) {
  const roleId = player.roleId;
  for (let city = 1; city <= room.cityCount; city += 1) {
    const value = numberOr(placements[city], 0);
    if (value < 0) throw new Error(`${city} 城不能投负数兵。`);
    if (value > 12) throw new Error(`${city} 城单人最多只能放 12 兵。`);
    if (roleId !== "koushui" && !Number.isInteger(value)) throw new Error("只有口水鸡可以使用 0.5 兵。");
  }
}

function validateSkill(room, player, skill) {
  const roleId = player.roleId;
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
    const correct = numberOr(skill.correct, 0);
    if (correct < 0 || correct > room.players.length || !Number.isInteger(correct)) throw new Error("白斩鸡预测正确人数必须是 0 到玩家人数之间的整数。");
  }
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
  applyBaizhan(players, skillByPlayer, blockedSkillPlayerIds, roundScores, breakdowns);

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

function applyBaizhan(players, skillByPlayer, blocked, scores, breakdowns) {
  const player = players.find((item) => item.roleId === "baizhan");
  if (!player || blocked.has(player.id)) return;
  const correct = clampNumber(skillByPlayer[player.id].correct, 0, players.length, 0);
  if (correct > 0) addPoints(player.id, correct * 2, "白斩预测", scores, breakdowns);
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
    if (player.roleId === "jiangyou") return skill.used ? { ...base, status: "已发动", detail: "按提交后的投兵表结算。" } : base;
    if (player.roleId === "baizhan") return (skill.correct || 0) > 0 ? { ...base, status: "已发动", detail: `预测正确 ${fmt(skill.correct)} 人，得 ${fmt(pointsByLabel(player.id, "白斩", ctx.breakdowns))} 分。` } : base;
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

function makeRoomCode() {
  let code = "";
  do {
    code = Math.random().toString(36).slice(2, 8).toUpperCase();
  } while (rooms.has(code));
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

server.listen(PORT, "0.0.0.0", () => {
  console.log(`City of Chicken online server: http://localhost:${PORT}`);
});
