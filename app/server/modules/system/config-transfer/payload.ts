import { z } from "zod";
import { decodeConfigTransferPayloadV1, encodeConfigTransferPayloadV1 } from "./v1/codec";
import { UnsupportedConfigTransferVersionError } from "./errors";
import { validateConfigTransferGraph } from "./graph";
import type { ConfigTransferModel } from "./model";
import { configTransferPayloadV1Schema, type ConfigTransferPayloadV1 } from "./v1/payload";

const configTransferVersionSchema = z.object({ version: z.number().int().positive().safe() });

export const CURRENT_CONFIG_TRANSFER_PAYLOAD_VERSION = 1;

export const encodeCurrentConfigTransferPayload = (payload: ConfigTransferModel): ConfigTransferPayloadV1 => {
	return encodeConfigTransferPayloadV1(validateConfigTransferGraph(payload));
};

export const parseConfigTransferPayload = (raw: unknown): ConfigTransferModel => {
	const { version } = configTransferVersionSchema.parse(raw);

	switch (version) {
		case 1:
			return validateConfigTransferGraph(decodeConfigTransferPayloadV1(configTransferPayloadV1Schema.parse(raw)));
		default:
			throw new UnsupportedConfigTransferVersionError(version, CURRENT_CONFIG_TRANSFER_PAYLOAD_VERSION);
	}
};
