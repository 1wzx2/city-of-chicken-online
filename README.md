# 懦夫城在线网页版

这是一个 Node.js + Socket.IO 的在线房间版，适合部署到支持 WebSocket 的公网服务器。房间状态现在支持持久化：公网部署时接 PostgreSQL，本地开发时默认写入本地 JSON 文件。

## 功能

- 房主创建房间，生成 6 位房间码。
- 其他玩家用房间码加入，未开始时最多 12 人；游戏开始后不允许新玩家加入，但已在房间内的玩家页面关闭后可以用上次身份恢复。
- 房主随机分配角色、结算本轮、进入下一轮。
- 开局前每名玩家可以预选一个角色；如果该角色只有一个人预选，分配时会优先给他；如果多人预选同一角色，冲突玩家随机分配。
- 房主操作顺序固定：随机分配角色后，只能先结算本轮；结算后只能进入下一轮。第六轮结算后游戏结束，直接展示最终总排名。
- 玩家只填写自己的投兵和技能，结算前别人看不到真实提交。
- 服务端校验技能轮次、次数、关键参数和总兵数；无效技能或没用完兵力都不能提交。
- 房间界面实时显示排行榜；结算前显示历史分，结算后显示本轮结算后的总分。
- 每轮结算后会保存公开日志，所有玩家在后续出兵阶段也可以随时查看该轮排名、技能发动情况、技能剩余次数和城池投兵分布。
- 房主点击“离开”或“解散房间”会永久删除房间号和记录；普通玩家离开只会变成离线，之后还能恢复进入。

## 持久化规则

服务端会优先使用环境变量 `DATABASE_URL` 指向的 PostgreSQL 数据库。

如果没有设置 `DATABASE_URL`，会退回到本地文件：

```text
city-of-chicken-online/data/rooms.json
```

本地 JSON 适合开发测试；正式放公网建议使用 PostgreSQL。接数据库后，Render 休眠、重启或重新部署，只要数据库还在，房间记录就还在。只有下面两种情况会删除房间：

- 房主点击“离开”。
- 房主点击“解散房间”。

## 本机运行

先安装 Node.js 18-24，然后在这个目录执行：

```bash
npm install
npm start
```

浏览器打开：

```text
http://localhost:3000
```

同一局域网玩家可以访问房主电脑的局域网 IP，例如：

```text
http://192.168.1.23:3000
```

## Render 公网部署

这个项目必须部署成“长期运行的 Node.js Web Service”，不能只放到静态网页托管。平台需要支持 WebSocket。

推荐步骤：

1. 把项目上传到 GitHub。
2. 在 Render 新建 PostgreSQL 数据库，复制它的 Internal Database URL 或 External Database URL。
3. 在 Render 新建 Web Service。
4. Root Directory 填 `city-of-chicken-online`。
5. Build Command 填 `npm install`。
6. Start Command 填 `npm start`。
7. 在 Web Service 的 Environment 里添加环境变量：

```text
DATABASE_URL=你的 PostgreSQL 连接串
```

如果数据库要求 SSL，再额外加：

```text
DATABASE_SSL=true
```

部署完成后，把 Render 给你的 HTTPS 地址发给玩家。服务是否启动可以访问：

```text
https://你的域名/health
```

返回下面内容表示服务已启动：

```json
{"ok":true}
```

## 技能限制

- 辣子鸡丁：全局只能使用 1 次。
- 炸鸡桶：只能在第 1-4 轮使用，全局只能使用 1 次。
- 可乐鸡翅：全局最多 3 次，第 5/6 轮合计最多 1 次；两个城池不能相同，实际值差不能超过 6。
- 浓鸡汤：先锁定一名查看对象，等待对方提交后，系统只向浓鸡汤展示该对象出兵；看完后才能提交自己的出兵，且不能重复查看同一个玩家。
- 黄焖鸡米饭：全局最多 3 次，第 5/6 轮合计最多 1 次。
- 鸳鸯鸡：全局最多 3 次，第 5/6 轮合计最多 1 次，合作对象不能是自己，且不能重复绑定同一个玩家；先单独锁定合作玩家并全场公示，之后双方各 17 兵，可以商量后再提交投兵；被绑定玩家本轮不能使用自己的技能。
- 大盘鸡：全局最多 3 次，第 5/6 轮合计最多 1 次，额外兵数必须是 1-12 的整数。
- 酱油鸡：全局最多 3 次，第 5/6 轮合计最多 1 次；先正常提交并声明使用技能，等所有玩家提交后，只向酱油鸡展示每名玩家的兵力分布，然后酱油鸡可以把自己的 1 个兵从一个城移动到另一个城，也可以选择原地不动；只要查看并确认调整，就算使用次数。
- 白斩鸡拼盘：给所有玩家填写总榜预测名次，可填并列名次；系统按泡椒偷分前、且左宗/白斩加分前的总榜自动核对，预测正确 +2 分/人，不受轮次翻倍。
- 口水鸡以外的角色不能使用 0.5 兵；每个玩家在每个城池最多放 12 兵。

## VPS 部署

如果你买了阿里云、腾讯云、华为云或其他 VPS，可以这样部署：

```bash
cd city-of-chicken-online
npm install
npm start
```

长期运行建议用 PM2：

```bash
npm install -g pm2
pm2 start server.js --name city-of-chicken
pm2 save
```

如果用 Nginx 反向代理到 Node 服务，WebSocket 相关配置必须保留：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 注意

- Render 免费实例仍可能休眠，但接 PostgreSQL 后，休眠或重启不会让房间记录消失。
- 如果没有配置 `DATABASE_URL`，房间会保存到本地 `data/rooms.json`；这不适合多实例部署，也不适合依赖临时磁盘的平台。
- 页面在房间内会每 15 秒发送一次心跳，并在 WebSocket 重连后自动恢复玩家身份。
- Vercel、GitHub Pages 这类静态托管不适合直接运行当前版本，因为当前版本需要一个持续运行的 Node.js 进程。

## 文件结构

- `server.js`：房间、实时同步、随机角色和自动结算逻辑。
- `storage.js`：PostgreSQL / 本地 JSON 持久化。
- `public/index.html`：网页入口。
- `public/app.js`：浏览器端交互。
- `public/styles.css`：界面样式。
