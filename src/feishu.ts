import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync } from "node:fs";
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

function readCachedToken(): string | null {
  if (!existsSync(TOKEN_CACHE)) return null;
  try {
    const cache: TokenCache = JSON.parse(readFileSync(TOKEN_CACHE, "utf-8"));
    if (Date.now() / 1000 < cache.exp) return cache.token;
  } catch {
    /* corrupt */
  }
  return null;
}

async function fetchToken(config: Config): Promise<string | null> {
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

function invalidateCache(): void {
  try {
    unlinkSync(TOKEN_CACHE);
  } catch {
    /* already gone */
  }
}

/** Response code indicating invalid/expired token */
function isTokenError(code: number): boolean {
  return code === 99991663 || code === 99991661 || code === 99991664;
}

interface ApiResponse {
  code?: number;
  data?: Record<string, unknown>;
}

export class FeishuClient {
  private constructor(
    private token: string,
    private config: Config,
  ) {}

  static async create(): Promise<FeishuClient | null> {
    const config = readConfig();
    if (!config) return null;
    const token = readCachedToken() || (await fetchToken(config));
    if (!token) return null;
    return new FeishuClient(token, config);
  }

  /** Refresh token and update instance */
  private async refresh(): Promise<boolean> {
    invalidateCache();
    const token = await fetchToken(this.config);
    if (!token) return false;
    this.token = token;
    return true;
  }

  async sendCard(chatId: string, card: object): Promise<string | undefined> {
    const doSend = async () => {
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
      return (await resp.json()) as ApiResponse;
    };

    try {
      let data = await doSend();
      if (isTokenError(data.code || 0) && (await this.refresh())) {
        data = await doSend();
      }
      const msgId = (data.data as { message_id?: string })?.message_id;
      appendFileSync("/tmp/cc-hook-debug.log", `feishu sendCard code=${data.code} msgId=${msgId}\n`);
      return msgId;
    } catch (e) {
      appendFileSync("/tmp/cc-hook-debug.log", `feishu sendCard error: ${e}\n`);
      return undefined;
    }
  }

  async updateCard(messageId: string, card: object): Promise<void> {
    const doUpdate = async () => {
      const resp = await fetch(
        `${API}/open-apis/im/v1/messages/${messageId}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: JSON.stringify(card) }),
          signal: AbortSignal.timeout(3000),
        },
      );
      return (await resp.json()) as ApiResponse;
    };

    try {
      const data = await doUpdate();
      if (isTokenError(data.code || 0) && (await this.refresh())) {
        await doUpdate();
      }
    } catch {
      /* best-effort */
    }
  }
}
