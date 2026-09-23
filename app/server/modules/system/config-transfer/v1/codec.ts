import { configTransferPayloadV1Schema, type ConfigTransferPayloadV1 } from "./payload";
import type { ConfigTransferModelV1 } from "./model";

export const decodeConfigTransferPayloadV1 = ({
	version: _version,
	...payload
}: ConfigTransferPayloadV1): ConfigTransferModelV1 => {
	return payload;
};

export const encodeConfigTransferPayloadV1 = (payload: ConfigTransferModelV1): ConfigTransferPayloadV1 => {
	return configTransferPayloadV1Schema.parse({ version: 1, ...payload });
};
