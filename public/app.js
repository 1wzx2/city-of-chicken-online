const socket = io();

const ROLES = [
  { id: "lazi", no: 1, short: "辣子", name: "辣子鸡丁", desc: "本轮同城其他玩家兵力 -3。" },
  { id: "zha", no: 2, short: "炸鸡", name: "炸鸡桶", desc: "前四轮炸一城，按摧毁兵数得分。" },
  { id: "kele", no: 3, short: "可乐", name: "可乐鸡翅", desc: "交换两个城池实际价值，差值不能超过 6。" },
  { id: "nongtang", no: 4, short: "浓汤", name: "浓鸡汤", desc: "查看一名玩家放置后再放置。" },
  { id: "zuozong", no: 5, short: "左宗", name: "左宗鸡", desc: "猜中泡椒偷分前本轮倒数三名之一 +10。" },
  { id: "huang", no: 6, short: "黄焖", name: "黄焖鸡米饭", desc: "指定城池胜者翻倍，失败进城者扣分。" },
  { id: "yuanyang", no: 7, short: "鸳鸯", name: "鸳鸯鸡", desc: "与一名玩家合作，双方各 17 兵，收益平分。" },
  { id: "paojiao", no: 8, short: "泡椒", name: "泡椒鸡爪", desc: "泡椒偷分前总榜唯一倒一时偷分，后两轮翻倍。" },
  { id: "dapan", no: 9, short: "大盘", name: "大盘鸡", desc: "额外 X 兵，未帮助得分兵扣分。" },
  { id: "jiangyou", no: 10, short: "酱油", name: "酱油鸡", desc: "计算前移动一枚军队。" },
  { id: "baizhan", no: 11, short: "白斩", name: "白斩鸡拼盘", desc: "预测泡椒偷分前累计排名，每对一人 +2。" },
  { id: "koushui", no: 12, short: "口水", name: "口水鸡", desc: "军队可分成 0.5 使用。" },
];
const ROLE_BY_ID = Object.fromEntries(ROLES.map((role) => [role.id, role]));

const state = {
  room: null,
  playerId: localStorage.getItem("chicken_online_player_id") || "",
  playerName: localStorage.getItem("chicken_online_name") || "",
  roomCode: localStorage.getItem("chicken_online_room") || "",
  placements: makeEmptyPlacements(16),
  skill: {},
  activeTab: "ranking",
};

const app = document.getElementById("app");
const connectionState = document.getElementById("connectionState");

socket.on("connect", () => {
  connectionState.textContent = "已连接";
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
  app.className = "page";
  app.innerHTML = `
    <section class="panel lobby">
      <h2>进入在线房间</h2>
      <p class="muted">同一局的人打开同一个服务器地址。房主创建房间，其他人用 6 位房间码加入。</p>
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
          <button id="submitBtn">提交本轮</button>
          <span class="muted">可重复提交，后一次覆盖前一次。结算前别人看不到你的投兵。</span>
        </div>
      </section>
      ${room.currentResult ? renderResults(room.currentResult) : ""}
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
  return cities.map((city) => `
    <label class="city-input">
      <span>${city} 城</span>
      <input data-placement="${city}" type="number" step="0.5" value="${formatInput(state.placements[city])}" />
    </label>
  `).join("");
}

function renderArmySummary() {
  const used = sumPlacements();
  const limit = armyLimit();
  const bad = Math.abs(used - limit) > 0.0001;
  return `<div id="armySummary" class="army ${bad ? "bad" : ""}">已投 ${fmt(used)} / ${fmt(limit)} 兵</div>`;
}

function renderSkillForm(role) {
  if (!role) return `<p class="muted">分配角色后填写技能。</p>`;
  const players = state.room.players.filter((player) => player.id !== state.playerId);
  const playerOptions = `<option value="">请选择</option>${players.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("")}`;
  const cityOptions = Array.from({ length: state.room.cityCount }, (_, index) => index + 1).map((city) => `<option value="${city}">${city} 城</option>`).join("");
  const checked = (key) => state.skill[key] ? "checked" : "";
  const selected = (key, value) => String(state.skill[key] || "") === String(value) ? "selected" : "";

  if (role.id === "lazi") return `<label class="inline"><input type="checkbox" data-skill-check="active" ${checked("active")} /> 本轮使用辣子</label>`;
  if (role.id === "zha") return `
    <div class="skill-form">
      <label class="inline"><input type="checkbox" data-skill-check="active" ${checked("active")} /> 放炸鸡</label>
      <label>炸鸡城池<select data-skill="city">${cityOptionsHtml(state.skill.city || 1)}</select></label>
    </div>`;
  if (role.id === "kele") return `
    <div class="skill-form">
      <label class="inline"><input type="checkbox" data-skill-check="active" ${checked("active")} /> 交换城池价值</label>
      <label>城池 A<select data-skill="cityA">${cityOptionsHtml(state.skill.cityA || 1)}</select></label>
      <label>城池 B<select data-skill="cityB">${cityOptionsHtml(state.skill.cityB || 2)}</select></label>
    </div>`;
  if (role.id === "nongtang") return `<label>查看对象<select data-skill="targetId">${markSelected(playerOptions, state.skill.targetId)}</select></label>`;
  if (role.id === "zuozong") return `<label>猜本轮倒数对象<select data-skill="targetId">${markSelected(playerOptions, state.skill.targetId)}</select></label>`;
  if (role.id === "huang") return `
    <div class="skill-form">
      <label class="inline"><input type="checkbox" data-skill-check="active" ${checked("active")} /> 指定黄焖城池</label>
      <label>黄焖城池<select data-skill="city">${cityOptionsHtml(state.skill.city || 1)}</select></label>
    </div>`;
  if (role.id === "yuanyang") return `
    <div class="skill-form">
      <label class="inline"><input type="checkbox" data-skill-check="active" ${checked("active")} /> 本轮合作</label>
      <label>合作玩家<select data-skill="partnerId">${markSelected(playerOptions, state.skill.partnerId)}</select></label>
    </div>`;
  if (role.id === "paojiao") return `<label class="inline"><input type="checkbox" data-skill-check="auto" ${state.skill.auto !== false ? "checked" : ""} /> 自动判定泡椒偷分</label>`;
  if (role.id === "dapan") return `
    <div class="skill-form">
      <label class="inline"><input type="checkbox" data-skill-check="active" ${checked("active")} /> 本轮加量</label>
      <label>额外兵数 X<input data-skill="extra" type="number" min="0" max="12" value="${formatInput(state.skill.extra || 0)}" /></label>
    </div>`;
  if (role.id === "jiangyou") return `<label class="inline"><input type="checkbox" data-skill-check="used" ${checked("used")} /> 本轮使用酱油；投兵表填写移动后的结果</label>`;
  if (role.id === "baizhan") return `<label>预测正确人数<input data-skill="correct" type="number" min="0" max="${state.room.players.length}" value="${formatInput(state.skill.correct || 0)}" /></label>`;
  if (role.id === "koushui") return `<p class="muted">口水鸡可用 0.5 兵，投兵表支持小数。</p>`;
  return `<p class="muted">无技能输入。</p>`;
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
  if (id === "leaveBtn") leaveRoom();
  if (id === "assignRolesBtn") emitAction("assignRoles");
  if (id === "settleBtn") emitAction("settleRound");
  if (id === "nextRoundBtn") emitAction("nextRound");
  if (id === "submitBtn") submitRound();
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
  el.textContent = `已投 ${fmt(used)} / ${fmt(limit)} 兵`;
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
  render();
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
    render();
  });
}

function submitRound() {
  emit("submitRound", { placements: state.placements, skill: state.skill }, (res) => {
    state.room = res.room;
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

function getMe() {
  return state.room ? state.room.players.find((player) => player.id === state.playerId) : null;
}

function armyLimit() {
  const me = getMe();
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
    baizhan: { correct: 0 },
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
