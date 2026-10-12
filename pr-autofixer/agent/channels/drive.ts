import { defineChannel, POST, type ChannelHandlerArgsWithBody } from "@cursor/july/channels";
import type { z } from "zod";
import { driveStartBodySchema } from "../lib/drive-schemas.js";
import { githubRepos } from "../lib/repos.js";
import { startDrive } from "../lib/start-drive.js";
import { bindOpsFunnel } from "../lib/ops-funnel.js";
import { describeResponse, traced } from "../lib/factory-otel.js";

export default defineChannel({
  routes: [
    POST("/", {
      description:
        "Start PR autofixer on a GitHub PR (same path as the drive_pr tool).",
      bodySchema: driveStartBodySchema,
      handler: traced({ span: "factory.delivery", kind: "drive.start", describe: describeResponse }, async (req: Request, { send, sessionUrls, host, body }: ChannelHandlerArgsWithBody<z.infer<typeof driveStartBodySchema>>) => {
        bindOpsFunnel(host);
        const result = await startDrive({
          pr: body.pr,
          hint: body.hint,
          repos: githubRepos(),
          send,
          host,
        });

        if (!result.ok) {
          return Response.json({ error: result.error }, { status: 400 });
        }

        return Response.json({
          pr: result.pr,
          sessionId: result.sessionId,
          continuationToken: result.continuationToken,
          bcId: result.bcId,
          agentUrl: result.agentUrl,
          status: result.status,
          result: result.result,
          playgroundUrl:
            result.sessionId === null
              ? null
              : sessionUrls(req, result.sessionId).playgroundUrl,
          mergeConflictReminderId: result.mergeConflictReminderId,
        });
      }),
    }),
  ],
});
