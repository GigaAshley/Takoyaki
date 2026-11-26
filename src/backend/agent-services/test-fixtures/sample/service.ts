/**
 * Test-only sample service: proves a service is one folder. Lives outside
 * services/, so it never ships. Used by registry.test.ts.
 */

import { z } from "zod";
import { defineService, ok } from "../../engine/types.js";

export default defineService({
  name: "sample",
  title: "Sample",
  description: "Echo a word back (test only)",
  input: z.strictObject({ word: z.string().min(1) }),
  secrets: {
    SAMPLE_API_KEY: {
      label: "Sample API key",
      description: "Made up for the test",
    },
  },
  ttlMs: 60_000,
  async handle(input, ctx) {
    return ok({ word: input.word, keyLength: ctx.secrets.SAMPLE_API_KEY.length });
  },
});
