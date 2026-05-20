const fs = require("fs/promises");
const path = require("path");
const JSON_STORE_PATH = process.env.ROOMS_FILE || path.join(__dirname, "data", "rooms.json");

class JsonRoomStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await this.write({ rooms: {} });
    }
  }

  async roomCodeExists(code) {
    const data = await this.read();
    return Boolean(data.rooms[code]);
  }

  async getRoom(code) {
    const data = await this.read();
    return data.rooms[code] || null;
  }

  async findRoomByPlayerId(playerId) {
    const data = await this.read();
    const room = Object.values(data.rooms).find((item) => item.players.some((player) => player.id === playerId));
    return room || null;
  }

  async saveRoom(room) {
    const data = await this.read();
    data.rooms[room.code] = room;
    await this.write(data);
  }

  async deleteRoom(code) {
    const data = await this.read();
    delete data.rooms[code];
    await this.write(data);
  }

  async read() {
    const raw = await fs.readFile(this.filePath, "utf8");
    return JSON.parse(raw || '{"rooms":{}}');
  }

  async write(data) {
    const tempPath = `${this.filePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
    try {
      await fs.rename(tempPath, this.filePath);
    } catch (error) {
      if (!["EPERM", "EACCES", "EXDEV"].includes(error.code)) throw error;
      await fs.copyFile(tempPath, this.filePath);
      await fs.unlink(tempPath).catch(() => {});
    }
  }
}

class PostgresRoomStore {
  constructor(connectionString) {
    // Load the driver only when DATABASE_URL is configured.
    const { Pool } = require("pg");
    const useSsl = process.env.DATABASE_SSL === "true";
    this.pool = new Pool({
      connectionString,
      ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    });
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS chicken_rooms (
        code TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        state JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS chicken_room_players (
        room_code TEXT NOT NULL REFERENCES chicken_rooms(code) ON DELETE CASCADE,
        player_id TEXT NOT NULL,
        PRIMARY KEY (room_code, player_id)
      );
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_chicken_room_players_player_id
      ON chicken_room_players(player_id);
    `);
  }

  async roomCodeExists(code) {
    const result = await this.pool.query("SELECT 1 FROM chicken_rooms WHERE code = $1", [code]);
    return result.rowCount > 0;
  }

  async getRoom(code) {
    const result = await this.pool.query("SELECT state FROM chicken_rooms WHERE code = $1", [code]);
    return result.rows[0] ? result.rows[0].state : null;
  }

  async findRoomByPlayerId(playerId) {
    const result = await this.pool.query(`
      SELECT r.state
      FROM chicken_room_players p
      JOIN chicken_rooms r ON r.code = p.room_code
      WHERE p.player_id = $1
      ORDER BY r.updated_at DESC
      LIMIT 1
    `, [playerId]);
    return result.rows[0] ? result.rows[0].state : null;
  }

  async saveRoom(room) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        INSERT INTO chicken_rooms (code, host_id, state, created_at, updated_at)
        VALUES ($1, $2, $3::jsonb, NOW(), NOW())
        ON CONFLICT (code)
        DO UPDATE SET host_id = EXCLUDED.host_id, state = EXCLUDED.state, updated_at = NOW()
      `, [room.code, room.hostId, JSON.stringify(room)]);
      await client.query("DELETE FROM chicken_room_players WHERE room_code = $1", [room.code]);
      if (room.players.length) {
        const values = [];
        const params = [room.code];
        room.players.forEach((player, index) => {
          params.push(player.id);
          values.push(`($1, $${index + 2})`);
        });
        await client.query(`
          INSERT INTO chicken_room_players (room_code, player_id)
          VALUES ${values.join(", ")}
        `, params);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteRoom(code) {
    await this.pool.query("DELETE FROM chicken_rooms WHERE code = $1", [code]);
  }
}

function createRoomStore() {
  if (process.env.DATABASE_URL) {
    return new PostgresRoomStore(process.env.DATABASE_URL);
  }
  return new JsonRoomStore(JSON_STORE_PATH);
}

module.exports = {
  createRoomStore,
};
