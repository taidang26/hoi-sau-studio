/**
 * The redirect half of Facebook Login, for a CLI: a one-shot server on
 * localhost catches the code Meta sends back after the user clicks Allow.
 * While the app is in Development mode Meta accepts localhost redirects
 * without registering them.
 */

import { createServer } from "node:http";

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginError";
  }
}

export interface CallbackOptions {
  port: number;
  /** The state sent in the dialog URL; anything else is rejected. */
  state: string;
  timeoutMs?: number;
  /** Called once the server is listening. */
  onListening?: () => void;
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${title}</h1><p>${body}</p></body>`;

/** Resolves with the authorization code from the first valid callback. */
export function waitForLoginCode(o: CallbackOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${o.port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const finish = (status: number, title: string, body: string, result: () => void) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(page(title, body));
        clearTimeout(timer);
        server.close();
        result();
      };

      const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
      if (error) {
        return finish(400, "Chưa kết nối", "Facebook trả về lỗi. Quay lại terminal để xem chi tiết.", () =>
          reject(new LoginError(`Facebook login was not completed: ${error}`)),
        );
      }
      if (url.searchParams.get("state") !== o.state) {
        // Not ours (stale tab or forged request): keep waiting for the real one.
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("State mismatch.");
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        return finish(400, "Chưa kết nối", "Thiếu mã từ Facebook.", () => reject(new LoginError("No code in the callback.")));
      }
      finish(200, "Đã kết nối", "Bạn có thể đóng tab này và quay lại terminal.", () => resolve(code));
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new LoginError("Timed out waiting for Facebook login."));
    }, o.timeoutMs ?? 5 * 60_000);

    server.on("error", (e) => {
      clearTimeout(timer);
      reject(new LoginError(`Cannot listen on localhost:${o.port}: ${e.message}`));
    });
    server.listen(o.port, "127.0.0.1", () => o.onListening?.());
  });
}
