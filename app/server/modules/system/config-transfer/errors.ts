import { BadRequestError } from "http-errors-enhanced";

export const INVALID_CONFIG_TRANSFER_MESSAGE = "Invalid export file or passphrase";

export class InvalidConfigTransferError extends BadRequestError {
	readonly name = "InvalidConfigTransferError";

	constructor() {
		super(INVALID_CONFIG_TRANSFER_MESSAGE);
	}
}

export class InvalidConfigTransferEnvelopeError extends Error {
	readonly name = "InvalidConfigTransferEnvelopeError";

	constructor() {
		super("Invalid configuration transfer envelope");
	}
}

export class UnsupportedConfigTransferEnvelopeVersionError extends Error {
	readonly name = "UnsupportedConfigTransferEnvelopeVersionError";

	constructor(version: number, currentVersion: number) {
		super(
			`Unsupported config export encryption version: ${version}. This Zerobyte release supports up to v${currentVersion}. Update Zerobyte to the latest release to import this export.`,
		);
	}
}

export class UnsupportedConfigTransferVersionError extends Error {
	readonly name = "UnsupportedConfigTransferVersionError";

	constructor(version: number, currentVersion: number) {
		super(
			`Unsupported config transfer version: ${version}. This Zerobyte release supports up to v${currentVersion}. Update Zerobyte to the latest release to import this export.`,
		);
	}
}
