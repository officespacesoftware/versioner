/**
 * HTTP entry point for Cloud Run. Routes:
 *   POST /slack/events        Slack Events API (signed by Slack)
 *   POST /slack/interactions  Slack interactivity (signed by Slack)
 *   POST /tasks/step          Cloud Tasks (Google ID token for our account)
 */

import { createServer, type IncomingMessage } from "node:http";

import {
  handleEvent,
  handleInteraction,
  handleTask,
  type Deps,
  type Reply,
  type Task,
} from "./handlers.js";
import { verifySlackSignature } from "./slack.js";

const MAX_BODY_BYTES = 256 * 1024;

class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new BodyTooLarge();
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

export function createApp(
  deps: Deps,
  verifyTask: (token: string) => Promise<boolean>
) {
  const route = async (req: IncomingMessage, raw: string): Promise<Reply> => {
    if (req.method !== "POST") {
      return { status: 405 };
    }

    if (req.url === "/tasks/step") {
      const auth = header(req, "authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!token || !(await verifyTask(token))) {
        return { status: 401 };
      }
      return handleTask(deps, JSON.parse(raw) as Task);
    }

    const signed = verifySlackSignature(
      deps.config.slackSigningSecret,
      header(req, "x-slack-request-timestamp"),
      header(req, "x-slack-signature"),
      raw
    );
    if (!signed) {
      return { status: 401 };
    }
    if (req.url === "/slack/events") {
      return handleEvent(
        deps,
        JSON.parse(raw) as Record<string, unknown>,
        header(req, "x-slack-retry-num") !== undefined
      );
    }
    if (req.url === "/slack/interactions") {
      const payload = new URLSearchParams(raw).get("payload");
      if (!payload) {
        return { status: 400 };
      }
      return handleInteraction(
        deps,
        JSON.parse(payload) as Record<string, unknown>
      );
    }
    return { status: 404 };
  };

  return createServer(async (req, res) => {
    let reply: Reply;
    try {
      reply = await route(req, await readBody(req));
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        reply = { status: 413 };
      } else if (error instanceof SyntaxError) {
        reply = { status: 400 };
      } else {
        console.error(`${req.method} ${req.url} failed:`, error);
        reply = { status: 500 };
      }
    }
    if (reply.body === undefined) {
      res.writeHead(reply.status).end();
    } else {
      res
        .writeHead(reply.status, { "content-type": "application/json" })
        .end(JSON.stringify(reply.body));
    }
  });
}
