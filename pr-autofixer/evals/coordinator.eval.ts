import { defineEval } from "@cursor/july/evals";

export default defineEval({
  tags: ["smoke"],
  cases: [
    {
      id: "no-pr",
      description: "Chat without a PR does not start a cloud drive.",
      async test(t) {
        await t.send("What can you help with?");
        t.succeeded();
        t.calledTool("drive_pr", { count: 0 });
      },
    },
  ],
});
