import { createLogger } from "../../utils/logger";

export const workLog = createLogger("bridge");
/** Every hop of the strict Salaam work path logs at info, so a stall names its step. */
export const hop = (step: string, meta: Record<string, unknown>) =>
  workLog.info("salaam work: " + step, meta);
