// External run feed contract (spec §5.2): what the dashboard accepts back from
// an external source (GET {source}/runs, SSE, or WS). Records failing
// validation are dropped by the consumer with a counted warning — this module
// only declares the accepted shape.
import { z } from "zod";
import { RunRecordSchema, type RunRecord } from "./registry.ts";

export const ExternalRunFeedSchema = z.object({ records: z.array(RunRecordSchema) });
export type ExternalRunFeed = z.infer<typeof ExternalRunFeedSchema>;
