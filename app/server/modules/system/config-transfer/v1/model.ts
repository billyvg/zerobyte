import type { ConfigTransferPayloadV1 } from "./payload";

export type ConfigTransferModelV1 = Omit<ConfigTransferPayloadV1, "version">;
