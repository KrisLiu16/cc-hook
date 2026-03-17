import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API = "https://open.feishu.cn";
const TOKEN_CACHE = "/tmp/cc-hook-token.json";

interface TokenCache {
  token: string;
  exp: number;
}

interface Config {
  app_id: string;
  app_secret: string;
}

function readConfig(): Config | null {
  const configPath = join(homedir(), ".mini-bridge", "config.yaml");
  if (!existsSync(configPath)) return null;

  const content = readFileSync(configPath, "utf-8");
  const appId = content.match(/^app_id:\s*(.+)$/m)?.[1]?.trim();
  const appSecret = content.match(/^app_secret:\s*(.+)$/m)?.[1]?.trim();

  if (!appId || !appSecret) return null;
  return { app_id: appId, app_secret: appSecret };
}

async function getToken(config: Config): Promise<string | null> {
  if (existsSync(TOKEN_CACHE)) {
    try {
      const cache: TokenCache = JSON.parse(
        readFileSync(TOKEN_CACHE, "utf-8"),
      );
      if (Date.now() / 1000 < cache.exp) return cache.token;
    } catch {
      /* expired or corrupt */
    }
  }

  try {
    const resp = await fetch(
      `${API}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
        signal: AbortSignal.timeout(3000),
      },
    );
    const data = (await resp.json()) as { tenant_access_token?: string };
    const token = data.tenant_access_token;
    if (!token) return null;

    writeFileSync(
      TOKEN_CACHE,
      JSON.stringify({ token, exp: Math.floor(Date.now() / 1000) + 7000 }),
    );
    return token;
  } catch {
    return null;
  }
}

export class FeishuClient {
  private constructor(private token: string) {}

  static async create(): Promise<FeishuClient | null> {
    const config = readConfig();
    if (!config) return null;
    const token = await getToken(config);
    if (!token) return null;
    return new FeishuClient(token);
  }

  async sendCard(chatId: string, card: object): Promise<string | undefined> {
    try {
      const resp = await fetch(
        `${API}/open-apis/im/v1/messages?receive_id_type=chat_id`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            receive_id: chatId,
            msg_type: "interactive",
            content: JSON.stringify(card),
          }),
          signal: AbortSignal.timeout(3000),
        },
      );
      const data = (await resp.json()) as {
        data?: { message_id?: string };
      };
      return data.data?.message_id;
    } catch {
      return undefined;
    }
  }

  async updateCard(messageId: string, card: object): Promise<void> {
    try {
      await fetch(`${API}/open-apis/im/v1/messages/${messageId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: JSON.stringify(card) }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      /* best-effort */
    }
  }
}
