const socket = io();

const ROLES = [
  { id: "lazi", no: 1, short: "辣子", name: "辣子鸡丁", desc: "全局只能使用一次，本轮同城其他玩家兵力 -3。" },
  { id: "zha", no: 2, short: "炸鸡", name: "炸鸡桶", desc: "前四轮只能使用一次，炸一城，按摧毁兵数得分。" },
  { id: "kele", no: 3, short: "可乐", name: "可乐鸡翅", desc: "全局 3 次，第五/六轮合计 1 次；交换两个城池实际价值，差值不能超过 6。" },
  { id: "nongtang", no: 4, short: "浓汤", name: "浓鸡汤", desc: "先锁定一名玩家，等对方提交后查看其出兵，再提交自己的出兵。" },
  { id: "zuozong", no: 5, short: "左宗", name: "左宗鸡", desc: "猜中泡椒偷分前本轮倒数三名之一 +10。" },
  { id: "huang", no: 6, short: "黄焖", name: "黄焖鸡米饭", desc: "全局 3 次，第五/六轮合计 1 次；指定城池胜者翻倍，失败进城者扣分。" },
  { id: "yuanyang", no: 7, short: "鸳鸯", name: "鸳鸯鸡", desc: "全局 3 次，第五/六轮合计 1 次；与一名玩家合作，双方各 17 兵，收益平分。" },
  { id: "paojiao", no: 8, short: "泡椒", name: "泡椒鸡爪", desc: "泡椒偷分前总榜唯一倒一时偷分，后两轮翻倍。" },
  { id: "dapan", no: 9, short: "大盘", name: "大盘鸡", desc: "全局 3 次，第五/六轮合计 1 次；额外 X 兵，未帮助得分兵扣分。" },
  { id: "jiangyou", no: 10, short: "酱油", name: "酱油鸡", desc: "全局 3 次，第五/六轮合计 1 次；提交后等全员提交，查看总分布并移动 1 个兵。" },
  { id: "baizhan", no: 11, short: "白斩", name: "白斩鸡拼盘", desc: "预测泡椒偷分前总榜名次，每猜对一人 +2。" },
  { id: "koushui", no: 12, short: "口水", name: "口水鸡", desc: "军队可分成 0.5 使用。" },
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

const state = {
  room: null,
  playerId: localStorage.getItem("chicken_online_player_id") || "",
  playerName: localStorage.getItem("chicken_online_name") || "",
  roomCode: localStorage.getItem("chicken_online_room") || "",
  placements: makeEmptyPlacements(16),
  skill: {},
  jiangyouMove: { fromCity: 1, toCity: 2 },
  activeTab: "ranking",
  autoRejoinTried: false,
};

const app = document.getElementById("app");
const connectionState = document.getElementById("connectionState");
window.setInterval(() => {
  if (socket.connected && state.room) socket.emit("keepAlive", {});
}, 60000);

socket.on("connect", () => {
  connectionState.textContent = "已连接";
  tryAutoRejoin();
});

socket.on("disconnect", () => {
  connectionState.textContent = "已断开";
});

socket.on("roomState", (room) => {
  const previousRound = state.room ? state.room.round : null;
  const previousMe = getMe();
  const previousRole = previousMe ? previousMe.roleId : "";
  state.room = room;
  const me = getMe();
  const roleChanged = (me && me.roleId) !== previousRole;
  if (room.ownSubmission && (previousRound !== room.round || roleChanged)) {
    state.placements = { ...makeEmptyPlacements(room.cityCount), ...room.ownSubmission.placements };
    state.skill = { ...defaultSkill(me ? me.roleId : ""), ...room.ownSubmission.skill };
  } else if (previousRound !== room.round || roleChanged) {
    state.placements = makeEmptyPlacements(room.cityCount);
    state.skill = defaultSkill(me ? me.roleId : "");
  }
  syncNongtangTarget();
  render();
});

document.addEventListener("click", handleClick);
document.addEventListener("input", handleInput);
document.addEventListener("change", handleChange);

render();

function render() {
  if (!state.room) {
    renderLobby();
    return;
  }
  renderRoom();
}

function renderLobby() {
  const hasSavedSession = Boolean(state.playerId && state.playerName);
  app.className = "page";
  app.innerHTML = `
    <section class="panel lobby">
      <h2>进入在线房间</h2>
      <p class="muted">同一局的人打开同一个服务器地址。房主创建房间，其他人用 6 位房间码加入。</p>
      ${hasSavedSession ? `
        <div class="resume-box">
          <strong>检测到上次身份：${escapeHtml(state.playerName)}</strong>
          <span class="muted">${state.roomCode ? `上次房间：${escapeHtml(state.roomCode)}` : "可以尝试按上次身份找回房间。"}</span>
          <button id="resumeRoomBtn" class="secondary">恢复上次房间</button>
        </div>
      ` : ""}
      <div class="form-grid">
        <label class="full">
          <span>昵称</span>
          <input id="nameInput" value="${escapeAttr(state.playerName)}" placeholder="输入你的昵称" />
        </label>
        <button id="createRoomBtn">创建房间</button>
        <label>
          <span>房间码</span>
          <input id="roomCodeInput" value="${escapeAttr(state.roomCode)}" placeholder="例如 A1B2C3" />
        </label>
        <button id="joinRoomBtn" class="secondary">加入房间</button>
      </div>
    </section>
  `;
}

function renderRoom() {
  const room = state.room;
  const me = getMe();
  const role = me && me.roleId ? ROLE_BY_ID[me.roleId] : null;
  const isHost = me && room.hostId === me.id;
  const submitted = room.players.filter((player) => player.submitted).length;
  app.className = "page";
  app.innerHTML = `
    <aside class="side">
      <section class="panel">
        <div class="actions">
          <span class="room-code">房间 ${room.code}</span>
          <button id="leaveBtn" class="secondary">离开</button>
        </div>
        <p class="muted">第 ${room.round} 轮，${submitted}/${room.players.length} 已提交。本机玩家：${escapeHtml(me ? me.name : "未知")}。</p>
      </section>
      ${isHost ? renderHostPanel() : ""}
      <section class="panel">
        <h2>玩家</h2>
        <div class="player-list">${room.players.map(renderPlayer).join("")}</div>
      </section>
      <section class="panel">
        <h2>你的角色</h2>
        ${role ? `<div class="role-name">${role.no}. ${escapeHtml(role.name)}</div><p class="muted">${escapeHtml(role.desc)}</p>` : `<p class="muted">等待房主随机分配角色。</p>`}
      </section>
    </aside>
    <section class="main">
      ${renderLiveLeaderboard()}
      <section class="panel">
        <h2>本轮投兵</h2>
        ${renderArmySummary()}
        <div class="board-grid">${renderPlacementInputs(room.cityCount)}</div>
      </section>
      <section class="panel">
        <h2>技能输入</h2>
        ${renderSkillForm(role)}
      </section>
      <section class="panel">
        <div class="actions">
          <button id="submitBtn" ${canSubmitNow(role) ? "" : "disabled"}>提交本轮</button>
          <span class="muted">可重复提交，后一次覆盖前一次。结算前别人看不到你的投兵。</span>
        </div>
      </section>
      ${room.currentResult ? renderResults(room.currentResult) : ""}
    </section>
  `;
}

function renderLiveLeaderboard() {
  const room = state.room;
  const title = room.currentResult ? "实时排行榜（已结算）" : "实时排行榜（历史分）";
  return `
    <section class="panel">
      <h2>${title}</h2>
      <div class="leaderboard">${(room.leaderboard || []).map((item, index) => `
        <div class="leader-row ${item.id === state.playerId ? "self" : ""}">
          <span class="rank">${index + 1}</span>
          <div>
            <strong>${escapeHtml(item.name)}${item.roleShort ? `（${escapeHtml(item.roleShort)}）` : ""}</strong>
            <div class="muted">${item.submitted ? "本轮已提交" : "本轮未提交"}</div>
          </div>
          <span class="leader-score">${fmt(item.score)}</span>
        </div>
      `).join("")}</div>
    </section>
  `;
}

function renderHostPanel() {
  return `
    <section class="panel">
      <h2>房主操作</h2>
      <div class="actions">
        <button id="assignRolesBtn">随机分配角色</button>
        <button id="settleBtn" class="secondary">结算本轮</button>
        <button id="nextRoundBtn" class="secondary">进入下一轮</button>
      </div>
      <p class="muted">重新随机角色会清空本轮提交。结算时未提交玩家按 0 兵处理。</p>
    </section>
  `;
}

function renderPlayer(player) {
  const status = player.connected ? "在线" : "离线";
  return `
    <div class="player">
      <div>
        <strong>${escapeHtml(player.name)}</strong>
        <div class="muted">${player.id === state.room.hostId ? "房主" : "玩家"} · ${escapeHtml(player.roleName || "未分配角色")} · ${status}</div>
      </div>
      <span class="tag ${player.submitted ? "" : "warn"}">${player.submitted ? "已提交" : "未提交"}</span>
    </div>
  `;
}

function renderPlacementInputs(cityCount) {
  const cities = Array.from({ length: cityCount }, (_, index) => cityCount - index);
  const me = getMe();
  const step = me && me.roleId === "koushui" ? "0.5" : "1";
  return cities.map((city) => `
    <label class="city-input">
      <span>${city} 城</span>
      <input data-placement="${city}" type="number" step="${step}" value="${formatInput(state.placements[city])}" />
    </label>
  `).join("");
}

function renderArmySummary() {
  const used = sumPlacements();
  const limit = armyLimit();
  const bad = Math.abs(used - limit) > 0.0001;
  const invite = state.room && state.room.allianceInvite ? ` · ${escapeHtml(state.room.allianceInvite.partnerName)} 已选择与你鸳鸯合作` : "";
  return `<div id="armySummary" class="army ${bad ? "bad" : ""}">已投 ${fmt(used)} / ${fmt(limit)} 兵${invite}</div>`;
}

function renderSkillForm(role) {
  if (!role) return `<p class="muted">分配角色后填写技能。</p>`;
  const players = state.room.players.filter((player) => player.id !== state.playerId);
  const playerOptions = `<option value="">请选择</option>${players.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("")}`;
  const cityOptions = Array.from({ length: state.room.cityCount }, (_, index) => index + 1).map((city) => `<option value="${city}">${city} 城</option>`).join("");
  const checked = (key) => state.skill[key] ? "checked" : "";
  const selected = (key, value) => String(state.skill[key] || "") === String(value) ? "selected" : "";
  const usage = renderSkillUsage(role);

  if (role.id === "lazi") return `${usage}<label class="inline"><input type="checkbox" data-skill-check="active" ${checked("active")} /> 本轮使用辣子</label>`;
  if (role.id === "zha") return `
    ${usage}
    <div class="skill-form">
      <label class="inline"><input type="checkbox" data-skill-check="active" ${checked("active")} /> 放炸鸡</label>
      <label>炸鸡城池<select data-skill="city">${cityOptionsHtml(state.skill.city || 1)}</select></label>
    </div>`;
  if (role.id === "kele") return `
    ${usage}
    <div class="skill-form">
      <label class="inline"><input type="checkbox" data-skill-check="active" ${checked("active")} /> 交换城池价值</label>
      <label>城池 A<select data-skill="cityA">${cityOptionsHtml(state.skill.cityA || 1)}</select></label>
      <label>城池 B<select data-skill="cityB">${cityOptionsHtml(state.skill.cityB || 2)}</select></label>
    </div>`;
  if (role.id === "nongtang") return renderNongtangForm(playerOptions);
  if (role.id === "zuozong") return `<label>猜本轮倒数对象<select data-skill="targetId">${markSelected(playerOptions, state.skill.targetId)}</select></label>`;
  if (role.id === "huang") return `
    ${usage}
    <div class="skill-form">
      <label class="inline"><input type="checkbox" data-skill-check="active" ${checked("active")} /> 指定黄焖城池</label>
      <label>黄焖城池<select data-skill="city">${cityOptionsHtml(state.skill.city || 1)}</select></label>
    </div>`;
  if (role.id === "yuanyang") return `
    ${usage}
    <div class="skill-form">
      <label class="inline"><input type="checkbox" data-skill-check="active" ${checked("active")} /> 本轮合作</label>
      <label>合作玩家<select data-skill="partnerId">${markSelected(playerOptions, state.skill.partnerId)}</select></label>
    </div>`;
  if (role.id === "paojiao") return `<label class="inline"><input type="checkbox" data-skill-check="auto" ${state.skill.auto !== false ? "checked" : ""} /> 自动判定泡椒偷分</label>`;
  if (role.id === "dapan") return `
    ${usage}
    <div class="skill-form">
      <label class="inline"><input type="checkbox" data-skill-check="active" ${checked("active")} /> 本轮加量</label>
      <label>额外兵数 X<input data-skill="extra" type="number" min="0" max="12" value="${formatInput(state.skill.extra || 0)}" /></label>
    </div>`;
  if (role.id === "jiangyou") return renderJiangyouForm(usage, checked);
  if (role.id === "baizhan") return renderBaizhanForm();
  if (role.id === "koushui") return `<p class="muted">口水鸡可用 0.5 兵，投兵表支持小数。</p>`;
  return `<p class="muted">无技能输入。</p>`;
}

function renderSkillUsage(role) {
  const usage = state.room.skillUsage;
  if (!usage || !usage.limited) return "";
  const parts = [`次数 ${usage.totalUsed}/${usage.totalMax}`];
  if (usage.lateMax) parts.push(`第五/六轮 ${usage.lateUsed}/${usage.lateMax}`);
  const roundText = usage.roundAllowed ? "" : "当前轮次不可使用";
  return `<div class="skill-usage ${usage.roundAllowed ? "" : "bad"}">${escapeHtml(usage.rule)} · ${parts.join(" · ")}${roundText ? ` · ${roundText}` : ""}</div>`;
}

function renderNongtangForm(playerOptions) {
  const view = state.room.nongtangView || {};
  if (!view.targetId) {
    return `
      <div class="skill-form">
        <label>先选择查看对象<select data-skill="targetId">${markSelected(playerOptions, state.skill.targetId)}</select></label>
        <button id="lockNongtangBtn" class="secondary">锁定查看对象</button>
        <p class="muted">锁定后需要等待对方提交。看到对方出兵后，再填写自己的出兵并提交。</p>
      </div>
    `;
  }

  const status = view.targetSubmitted
    ? `已看到 ${escapeHtml(view.targetName)} 的出兵，可以提交自己的出兵。`
    : `等待 ${escapeHtml(view.targetName)} 提交。对方提交后这里会自动显示出兵。`;
  return `
    <div class="skill-form">
      <div class="skill-usage ${view.targetSubmitted ? "" : "bad"}">查看对象：${escapeHtml(view.targetName)} · ${status}</div>
      ${view.targetSubmitted ? renderViewedPlacements(view.placements) : ""}
    </div>
  `;
}

function renderBaizhanForm() {
  const predictions = state.skill.predictions || {};
  const max = state.room.players.length;
  const rows = state.room.players.map((player) => `
    <label class="prediction-row">
      <span>${escapeHtml(player.name)}${player.roleShort ? `（${escapeHtml(player.roleShort)}）` : ""}</span>
      <input data-skill-rank="${player.id}" type="number" min="1" max="${max}" step="1" value="${predictions[player.id] === undefined || predictions[player.id] === "" ? "" : formatInput(predictions[player.id])}" />
    </label>
  `).join("");
  return `
    <div class="skill-form">
      <p class="muted">预测本轮泡椒、左宗、白斩结算前的总榜名次。并列可以填相同名次。</p>
      <div class="prediction-grid">${rows}</div>
    </div>
  `;
}

function renderJiangyouForm(usage, checked) {
  const view = state.room.jiangyouView || {};
  const ownSubmitted = Boolean(state.room.ownSubmission);
  if (!ownSubmitted) {
    return `${usage}<label class="inline"><input type="checkbox" data-skill-check="used" ${checked("used")} /> 本轮使用酱油；先正常提交，等所有人提交后再移动 1 个兵</label>`;
  }
  if (!view.used) {
    return `<p class="muted">本轮没有开启酱油技能，按已提交的投兵表结算。</p>`;
  }
  if (!view.allSubmitted) {
    return `
      ${usage}
      <div class="skill-usage bad">已开启酱油技能 · 等待所有玩家提交后，会显示各城总兵力分布。</div>
    `;
  }
  if (view.adjusted) {
    return `
      ${usage}
      <div class="skill-usage">已调整：${fmt(view.fromCity)} 城 -1，${fmt(view.toCity)} 城 +1。</div>
      ${renderCityTotals(view.totals)}
    `;
  }
  return `
    ${usage}
    <div class="skill-form">
      <div class="skill-usage">所有玩家已提交。查看各城总兵力后，移动自己 1 个兵。</div>
      ${renderCityTotals(view.totals)}
      <div class="move-grid">
        <label>从<select data-jiangyou-move="fromCity">${cityOptionsHtml(state.jiangyouMove.fromCity || 1)}</select></label>
        <label>到<select data-jiangyou-move="toCity">${cityOptionsHtml(state.jiangyouMove.toCity || 2)}</select></label>
        <button id="adjustJiangyouBtn" class="secondary">确认移动 1 兵</button>
      </div>
    </div>
  `;
}

function renderCityTotals(totals) {
  const rows = Array.from({ length: state.room.cityCount }, (_, index) => state.room.cityCount - index)
    .map((city) => `
      <div class="viewed-city">
        <span>${city} 城总兵</span>
        <strong>${fmt(totals && totals[city] ? totals[city] : 0)}</strong>
      </div>
    `).join("");
  return `<div class="viewed-grid">${rows}</div>`;
}

function renderViewedPlacements(placements) {
  const rows = Array.from({ length: state.room.cityCount }, (_, index) => state.room.cityCount - index)
    .map((city) => `
      <div class="viewed-city">
        <span>${city} 城</span>
        <strong>${fmt(placements && placements[city] ? placements[city] : 0)}</strong>
      </div>
    `).join("");
  return `<div class="viewed-grid">${rows}</div>`;
}

function renderResults(result) {
  return `
    <section class="panel">
      <h2>结算结果</h2>
      <div class="tabs">
        <button data-tab="ranking" class="${state.activeTab === "ranking" ? "active" : ""}">排名</button>
        <button data-tab="skills" class="${state.activeTab === "skills" ? "active" : ""}">技能</button>
        <button data-tab="cities" class="${state.activeTab === "cities" ? "active" : ""}">城池</button>
      </div>
      <div class="${state.activeTab === "ranking" ? "" : "hidden"}">${renderRanking(result)}</div>
      <div class="${state.activeTab === "skills" ? "" : "hidden"}">${renderSkillEvents(result)}</div>
      <div class="${state.activeTab === "cities" ? "" : "hidden"}">${renderCityResults(result)}</div>
    </section>
  `;
}

function renderRanking(result) {
  return `<div class="result-list">${result.ranking.map((item, index) => `
    <div class="result-row">
      <div>
        <strong>${index + 1}. ${escapeHtml(item.name)}（${escapeHtml(item.roleShort)}）</strong>
        <div class="formula">${escapeHtml(item.formula || "")}</div>
      </div>
      <div class="score">${fmt(item.total)}</div>
    </div>
  `).join("")}</div>`;
}

function renderSkillEvents(result) {
  return `<div class="card-list">${result.skillEvents.map((event) => `
    <div class="event-card">
      <strong>${escapeHtml(event.title)} · ${escapeHtml(event.status)}</strong>
      <div class="muted">${escapeHtml(event.detail)}</div>
    </div>
  `).join("")}</div>`;
}

function renderCityResults(result) {
  return `<div class="card-list">${result.cityResults.map((city) => `
    <div class="city-card">
      <strong>${city.city} 城 · 值 ${fmt(city.value)} · ${escapeHtml(city.winnerLabel || "无人得分")}</strong>
      <div class="muted">${escapeHtml(city.formula)}</div>
    </div>
  `).join("")}</div>`;
}

function handleClick(event) {
  const id = event.target.id;
  if (id === "createRoomBtn") createRoom();
  if (id === "joinRoomBtn") joinRoom();
  if (id === "resumeRoomBtn") resumeRoom(true);
  if (id === "leaveBtn") leaveRoom();
  if (id === "assignRolesBtn") emitAction("assignRoles");
  if (id === "settleBtn") emitAction("settleRound");
  if (id === "nextRoundBtn") emitAction("nextRound");
  if (id === "submitBtn") submitRound();
  if (id === "lockNongtangBtn") lockNongtangTarget();
  if (id === "adjustJiangyouBtn") adjustJiangyou();
  if (event.target.dataset.tab) {
    state.activeTab = event.target.dataset.tab;
    render();
  }
}

function handleInput(event) {
  if (event.target.id === "nameInput") {
    state.playerName = event.target.value;
    localStorage.setItem("chicken_online_name", state.playerName);
  }
  if (event.target.id === "roomCodeInput") {
    state.roomCode = event.target.value.toUpperCase();
    localStorage.setItem("chicken_online_room", state.roomCode);
  }
  if (event.target.dataset.placement) {
    state.placements[event.target.dataset.placement] = numberOr(event.target.value, 0);
    updateArmySummary();
  }
  if (event.target.dataset.skill) {
    const key = event.target.dataset.skill;
    state.skill[key] = event.target.type === "number" ? numberOr(event.target.value, 0) : event.target.value;
    updateArmySummary();
  }
  if (event.target.dataset.skillRank) {
    state.skill.predictions = state.skill.predictions || {};
    state.skill.predictions[event.target.dataset.skillRank] = numberOr(event.target.value, "");
  }
  if (event.target.dataset.jiangyouMove) {
    state.jiangyouMove[event.target.dataset.jiangyouMove] = numberOr(event.target.value, 1);
  }
}

function handleChange(event) {
  if (event.target.dataset.skillCheck) {
    state.skill[event.target.dataset.skillCheck] = event.target.checked;
    renderRoom();
  }
}

function updateArmySummary() {
  const el = document.getElementById("armySummary");
  if (!el) return;
  const used = sumPlacements();
  const limit = armyLimit();
  const bad = Math.abs(used - limit) > 0.0001;
  el.classList.toggle("bad", bad);
  const invite = state.room && state.room.allianceInvite ? ` · ${state.room.allianceInvite.partnerName} 已选择与你鸳鸯合作` : "";
  el.textContent = `已投 ${fmt(used)} / ${fmt(limit)} 兵${invite}`;
}

function createRoom() {
  const name = state.playerName.trim();
  if (!name) return alert("先填昵称");
  emit("createRoom", { name }, (res) => enterRoom(res));
}

function joinRoom() {
  const name = state.playerName.trim();
  const code = state.roomCode.trim().toUpperCase();
  if (!name) return alert("先填昵称");
  if (!code) return alert("请输入房间码");
  emit("joinRoom", { name, code, playerId: state.playerId }, (res) => enterRoom(res));
}

function enterRoom(res) {
  state.room = res.room;
  state.playerId = res.playerId;
  state.roomCode = res.code;
  localStorage.setItem("chicken_online_player_id", state.playerId);
  localStorage.setItem("chicken_online_room", state.roomCode);
  const me = getMe();
  state.placements = res.room.ownSubmission ? { ...makeEmptyPlacements(res.room.cityCount), ...res.room.ownSubmission.placements } : makeEmptyPlacements(res.room.cityCount);
  state.skill = res.room.ownSubmission ? { ...defaultSkill(me ? me.roleId : ""), ...res.room.ownSubmission.skill } : defaultSkill(me ? me.roleId : "");
  syncNongtangTarget();
  render();
}

function tryAutoRejoin() {
  if (state.room || state.autoRejoinTried || !state.playerId || !state.playerName) return;
  state.autoRejoinTried = true;
  resumeRoom(false);
}

function resumeRoom(showError) {
  const name = state.playerName.trim();
  if (!state.playerId || !name) {
    if (showError) alert("没有可恢复的上次身份");
    return;
  }
  const code = state.roomCode.trim().toUpperCase();
  const fallback = () => {
    socket.emit("rejoinPlayer", { playerId: state.playerId, name }, (res) => {
      if (!res || !res.ok) {
        if (showError) alert((res && res.message) || "恢复失败，请让房主重新发房间码");
        return;
      }
      enterRoom(res);
    });
  };

  if (!code) {
    fallback();
    return;
  }

  socket.emit("joinRoom", { name, code, playerId: state.playerId }, (res) => {
    if (res && res.ok) {
      enterRoom(res);
      return;
    }
    fallback();
  });
}

function leaveRoom() {
  emit("leaveRoom", {}, () => {
    state.room = null;
    state.roomCode = "";
    localStorage.removeItem("chicken_online_room");
    render();
  });
}

function emitAction(action) {
  emit(action, {}, (res) => {
    state.room = res.room;
    syncNongtangTarget();
    render();
  });
}

function lockNongtangTarget() {
  if (!state.skill.targetId) return alert("请选择浓汤查看对象");
  emit("setNongtangTarget", { targetId: state.skill.targetId }, (res) => {
    state.room = res.room;
    syncNongtangTarget();
    render();
  });
}

function submitRound() {
  const error = validateLocalSubmission();
  if (error) return alert(error);
  emit("submitRound", { placements: state.placements, skill: state.skill }, (res) => {
    state.room = res.room;
    syncNongtangTarget();
    render();
  });
}

function adjustJiangyou() {
  emit("adjustJiangyou", state.jiangyouMove, (res) => {
    state.room = res.room;
    if (res.room.ownSubmission) {
      state.placements = { ...makeEmptyPlacements(res.room.cityCount), ...res.room.ownSubmission.placements };
      state.skill = { ...defaultSkill("jiangyou"), ...res.room.ownSubmission.skill };
    }
    render();
  });
}

function emit(eventName, payload, onOk) {
  socket.emit(eventName, payload, (res) => {
    if (!res || !res.ok) {
      alert((res && res.message) || "操作失败");
      return;
    }
    onOk(res);
  });
}

function syncNongtangTarget() {
  if (state.room && state.room.nongtangView && state.room.nongtangView.targetId) {
    state.skill.targetId = state.room.nongtangView.targetId;
  }
}

function canSubmitNow(role) {
  if (!role) return false;
  if (role.id === "jiangyou") {
    const view = state.room.jiangyouView || {};
    if (view.used && view.allSubmitted) return false;
  }
  if (role.id !== "nongtang") return true;
  const view = state.room.nongtangView || {};
  return Boolean(view.targetId && view.targetSubmitted);
}

function validateLocalSubmission() {
  const me = getMe();
  if (!me || !me.roleId) return "还没有分配角色，不能提交本轮。";
  if (me.roleId === "nongtang") {
    const view = state.room.nongtangView || {};
    if (!view.targetId) return "浓鸡汤需要先锁定查看对象。";
    if (!view.targetSubmitted) return `${view.targetName || "查看对象"} 还没有提交，浓鸡汤需要等对方提交后再出兵。`;
    state.skill.targetId = view.targetId;
  }
  const placementError = validateLocalPlacements(me.roleId);
  if (placementError) return placementError;
  return validateLocalSkill(me.roleId);
}

function validateLocalPlacements(roleId) {
  let used = 0;
  for (let city = 1; city <= state.room.cityCount; city += 1) {
    const value = numberOr(state.placements[city], 0);
    if (value < 0) return `${city} 城不能投负数兵。`;
    if (value > 12) return `${city} 城单人最多只能放 12 兵。`;
    if (roleId !== "koushui" && !Number.isInteger(value)) return "只有口水鸡可以使用 0.5 兵。";
    used += value;
  }
  const limit = armyLimit();
  if (Math.abs(used - limit) > 0.0001) return `本轮必须刚好用完 ${fmt(limit)} 兵，当前用了 ${fmt(used)} 兵。`;
  return "";
}

function validateLocalSkill(roleId) {
  const skill = state.skill || {};
  if (state.room && state.room.allianceInvite) return "";
  const usageError = localSkillUsageError(roleId, skill);
  if (usageError) return usageError;

  if (roleId === "zha" && skill.active && !validCity(skill.city)) return "炸鸡城池必须是有效城池。";
  if (roleId === "kele" && skill.active) {
    const cityA = skillCity(skill.cityA);
    const cityB = skillCity(skill.cityB);
    if (!cityA || !cityB) return "可乐鸡翅交换的城池必须是有效城池。";
    if (cityA === cityB) return "可乐鸡翅不能交换同一个城池。";
    if (Math.abs(cityA - cityB) > 6) return "可乐鸡翅交换的两个城池实际值差不能超过 6。";
  }
  if (roleId === "nongtang" && skill.targetId && !validOtherPlayer(skill.targetId)) return "浓汤查看对象无效。";
  if (roleId === "zuozong" && skill.targetId && !validOtherPlayer(skill.targetId)) return "左宗猜测对象无效。";
  if (roleId === "huang" && skill.active && !validCity(skill.city)) return "黄焖城池必须是有效城池。";
  if (roleId === "yuanyang" && skill.active && !validOtherPlayer(skill.partnerId)) return "请选择有效的鸳鸯合作玩家。";
  if (roleId === "dapan" && skill.active) {
    const extra = numberOr(skill.extra, 0);
    if (extra <= 0) return "大盘鸡使用加量时，额外兵数必须大于 0。";
    if (extra > 12) return "大盘鸡额外兵数最多为 12。";
    if (!Number.isInteger(extra)) return "大盘鸡额外兵数必须是整数。";
  }
  if (roleId === "baizhan") {
    const predictions = skill.predictions || {};
    for (const player of state.room.players) {
      const rank = numberOr(predictions[player.id], NaN);
      if (!Number.isInteger(rank) || rank < 1 || rank > state.room.players.length) {
        return `白斩鸡需要给 ${player.name} 填写 1 到 ${state.room.players.length} 之间的整数名次。`;
      }
    }
  }
  return "";
}

function localSkillUsageError(roleId, skill) {
  const limit = SKILL_LIMITS[roleId];
  if (!limit || !usesLimitedSkill(roleId, skill)) return "";
  if (limit.rounds && !limit.rounds.includes(state.room.round)) return `${ROLE_BY_ID[roleId].name}只能在第 ${limit.rounds.join("、")} 轮使用技能。`;

  const usage = state.room.skillUsage || { totalUsed: 0, lateUsed: 0 };
  const ownUsedThisRound = state.room.ownSubmission && usesLimitedSkill(roleId, state.room.ownSubmission.skill || {});
  const totalBefore = Math.max(0, numberOr(usage.totalUsed, 0) - (ownUsedThisRound ? 1 : 0));
  const lateBefore = Math.max(0, numberOr(usage.lateUsed, 0) - (ownUsedThisRound && isLateRound(state.room.round) ? 1 : 0));
  if (limit.total && totalBefore + 1 > limit.total) return `${ROLE_BY_ID[roleId].name}技能次数已用完：${limit.label}。`;
  if (limit.late && isLateRound(state.room.round) && lateBefore + 1 > limit.late) return `${ROLE_BY_ID[roleId].name}在第五/六轮只能使用一次技能。`;
  return "";
}

function usesLimitedSkill(roleId, skill) {
  if (!SKILL_LIMITS[roleId]) return false;
  if (roleId === "jiangyou") return Boolean(skill.used);
  return Boolean(skill.active);
}

function validCity(value) {
  return Boolean(skillCity(value));
}

function skillCity(value) {
  const city = numberOr(value, NaN);
  return Number.isInteger(city) && city >= 1 && city <= state.room.cityCount ? city : 0;
}

function validOtherPlayer(playerId) {
  return Boolean(playerId && playerId !== state.playerId && state.room.players.some((player) => player.id === playerId));
}

function isLateRound(round) {
  return round === 5 || round === 6;
}

function getMe() {
  return state.room ? state.room.players.find((player) => player.id === state.playerId) : null;
}

function armyLimit() {
  const me = getMe();
  if (state.room && state.room.allianceInvite) return 17;
  let limit = 12;
  if (me && me.roleId === "yuanyang" && state.skill.active) limit = 17;
  if (me && me.roleId === "dapan" && state.skill.active) limit += Math.min(12, Math.max(0, numberOr(state.skill.extra, 0)));
  return limit;
}

function sumPlacements() {
  return Object.values(state.placements).reduce((sum, value) => sum + numberOr(value, 0), 0);
}

function makeEmptyPlacements(cityCount) {
  const placements = {};
  for (let city = 1; city <= cityCount; city += 1) placements[city] = 0;
  return placements;
}

function defaultSkill(roleId) {
  const map = {
    lazi: { active: false },
    zha: { active: false, city: 1 },
    kele: { active: false, cityA: 1, cityB: 2 },
    nongtang: { targetId: "" },
    zuozong: { targetId: "" },
    huang: { active: false, city: 1 },
    yuanyang: { active: false, partnerId: "" },
    paojiao: { auto: true },
    dapan: { active: false, extra: 0 },
    jiangyou: { used: false },
    baizhan: { predictions: {} },
    koushui: {},
  };
  return { ...(map[roleId] || {}) };
}

function markSelected(optionsHtml, value) {
  if (!value) return optionsHtml;
  return optionsHtml.replace(`value="${value}"`, `value="${value}" selected`);
}

function cityOptionsHtml(selectedValue) {
  return Array.from({ length: state.room.cityCount }, (_, index) => index + 1)
    .map((city) => `<option value="${city}" ${String(city) === String(selectedValue) ? "selected" : ""}>${city} 城</option>`)
    .join("");
}

function numberOr(value, fallback) {
  if (value === "" || value === null || value === undefined) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function fmt(value) {
  const number = Math.round(Number(value) * 1000000) / 1000000;
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2)));
}

function formatInput(value) {
  return value === undefined || value === null ? "" : fmt(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}
