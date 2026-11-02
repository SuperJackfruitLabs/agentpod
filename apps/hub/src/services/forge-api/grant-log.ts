/** The one logger of the station forge API lifecycle (every grant-*.ts file logs through it). */
import { createLogger } from "../../utils/logger";

export const log = createLogger("station-forge-api");
