import { z } from "zod";

export const driveStartBodySchema: z.ZodObject<{
  pr: z.ZodString;
  hint: z.ZodOptional<z.ZodString>;
}> = z.object({
  pr: z
    .string()
    .describe(
      "GitHub PR URL or owner/repo#N, e.g. https://github.com/acme/widgets/pull/1 or acme/widgets#1"
    ),
  hint: z
    .string()
    .optional()
    .describe(
      "Optional owner hint passed into the drive prompt (e.g. focus on CI, ignore a thread)."
    ),
});
