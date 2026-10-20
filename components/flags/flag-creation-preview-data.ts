import { createApiSuccessSchema, flagCreationOutputSchema } from "@flagforge/contracts";
import { z } from "zod";

export const flagCreationPreviewResponseSchema = createApiSuccessSchema(
  z.object({
    draft: flagCreationOutputSchema,
    model: z.string().trim().min(1),
    mock: z.boolean(),
    previewOnly: z.literal(true),
  }),
);

export type FlagCreationPreview = z.infer<typeof flagCreationPreviewResponseSchema>["data"];

// Display-only backstop for generated copy. Values still render as React text,
// never as HTML or Markdown, and the validated draft itself stays intact.
export function previewText(value: string) {
  return value
    .replace(/[0-9#*]\uFE0F?\u20E3/g, "")
    .replace(
      /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200D\uFE0E\uFE0F\u20E3\u{E0020}-\u{E007F}]/gu,
      "",
    )
    .trim();
}
