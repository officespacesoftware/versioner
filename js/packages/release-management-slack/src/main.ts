import { loadConfig } from "./config.js";
import { CursorClient } from "./cursor.js";
import {
  CloudTasksQueue,
  idTokenVerifier,
  metadataTokenSource,
} from "./google.js";
import type { Deps } from "./handlers.js";
import { createApp } from "./server.js";
import { SlackClient } from "./slack.js";

const config = loadConfig();
const deps: Deps = {
  config,
  slack: new SlackClient(config.slackBotToken),
  cursor: new CursorClient(config.cursorApiKey, {
    repos: config.cursorRepos,
    envName: config.cursorEnvName,
    model: config.cursorModel,
  }),
  queue: new CloudTasksQueue(
    {
      queue: config.tasksQueue,
      url: `${config.serviceUrl}/tasks/step`,
      audience: config.serviceUrl,
      serviceAccount: config.taskServiceAccount,
    },
    metadataTokenSource()
  ),
  log: (message, error) => console.error(message, error),
};
const verify = idTokenVerifier();
const port = Number(process.env.PORT ?? 8080);
createApp(deps, (token) =>
  verify(token, {
    audience: config.serviceUrl,
    email: config.taskServiceAccount,
  })
).listen(port, () => {
  console.log(`release-management-slack listening on ${port}`);
});
