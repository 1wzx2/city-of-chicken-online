# 懦夫之城在线网页版

这是一个普通网页在线版，不依赖微信小程序、云函数或云数据库。它用 Node.js + Socket.IO 做实时房间同步，适合部署到支持 WebSocket 的公网服务器。

## 功能

- 房主创建房间，生成 6 位房间码。
- 其他玩家用房间码加入。
- 房主随机分配角色。
- 每个玩家只填写自己的投兵和技能。
- 服务端保存秘密提交，结算前不会把投兵广播给其他玩家。
- 服务端校验技能轮次、次数和关键参数，无效技能不能提交。
- 所有已提交玩家必须刚好用完自己的兵力，少用或超用都不能提交。
- 房间界面实时显示排行榜；结算前显示历史分，结算后显示本轮结算后的总分。
- 玩家误关页面后，重新打开同一网址会自动尝试恢复上次房间，也可以点击“恢复上次房间”。
- 房主统一结算，所有人同步看到排名、技能发动情况和城池结果。
- 房主进入下一轮时，本轮总分会写入历史分。

## 技能限制

- 辣子鸡丁：全局只能使用 1 次。
- 炸鸡桶：只能在第 1-4 轮使用，全局只能使用 1 次。
- 可乐鸡翅：全局最多 3 次，第 5/6 轮合计最多 1 次；两个城池不能相同，实际值差不能超过 6。
- 浓鸡汤：先锁定一名查看对象，等待对方提交后，系统只向浓鸡汤展示该对象出兵；看完后才能提交自己的出兵，且不能重复查看同一个玩家。
- 黄焖鸡米饭：全局最多 3 次，第 5/6 轮合计最多 1 次。
- 鸳鸯鸡：全局最多 3 次，第 5/6 轮合计最多 1 次，合作对象不能是自己。
- 大盘鸡：全局最多 3 次，第 5/6 轮合计最多 1 次，额外兵数必须是 1-12 的整数。
- 酱油鸡：全局最多 3 次，第 5/6 轮合计最多 1 次。
- 白斩鸡拼盘：给所有玩家填写总榜预测名次，可填并列名次；系统按泡椒偷分前、且左宗/白斩加分前的总榜自动核对，预测正确 +2 分/人，不受轮次翻倍。
- 口水鸡以外的角色不能使用 0.5 兵；每个玩家在每个城池最多放 12 兵。

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

## 公网部署

这个项目必须部署成“长期运行的 Node.js Web 服务”，不能只放到静态网页托管。平台需要支持 WebSocket，因为房间同步靠 Socket.IO。

推荐最简单的方式是使用 Render、Railway、Fly.io、Zeabur 这类 Node.js 托管平台：

1. 把整个项目上传到 GitHub。
2. 在托管平台新建 Web Service / Node.js App。
3. Root Directory 填 `city-of-chicken-online`。
4. Build Command 填 `npm install`。
5. Start Command 填 `npm start`。
6. 环境变量不用手动设置端口，平台会提供 `PORT`，代码已经自动读取。
7. 部署完成后，把平台给你的 HTTPS 网址发给玩家，所有人用同一个网址进入并输入房间码。

部署后可以访问这个地址检查服务是否活着：

```text
https://你的域名/health
```

如果返回：

```json
{"ok":true}
```

说明 Node 服务已经启动。

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

然后给域名配置 HTTPS 证书，玩家就可以用域名访问。

## 临时公网测试

如果只是临时让外网朋友测试，可以先本机运行：

```bash
npm start
```

再用 ngrok、cpolar、花生壳之类的内网穿透工具把 `3000` 端口映射出去。这个方式适合测试，不适合长期正式开房，因为地址可能变化，稳定性也取决于穿透服务。

## 注意

- 当前版本房间数据保存在服务端内存里，服务器重启后房间会消失。
- 如果要长期保存战绩，可以后续接 SQLite、PostgreSQL、Redis 或其他数据库。
- Vercel、GitHub Pages、普通对象存储这类静态托管不适合直接运行当前版本，因为当前版本需要一个持续运行的 Node.js 进程。
- 如果主要玩家在国内，优先选国内云服务器或国内可稳定访问的平台，海外免费平台可能会比较慢。

## 文件结构

- `server.js`：房间、实时同步、随机角色和自动结算逻辑。
- `public/index.html`：网页入口。
- `public/app.js`：浏览器端交互。
- `public/styles.css`：界面样式。
