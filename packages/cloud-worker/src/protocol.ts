/** Services the cloud slice adds on top of `mini`'s. */

import { defineService } from "@earendil-works/pi-coding-agent/experimental/mini/shared/protocol";

export interface CloudWorkerStatus {
	sessionId: string;
	leaseEpoch: number | undefined;
	/** An operation is in flight; the supervisor keeps the worker alive regardless of viewers. */
	busy: boolean;
	currentOperationId: string | null;
	/** Resource bundle the worker runs with, or null when bare. */
	bundleVersion: string | null;
}

export interface CloudWorkerServiceApi {
	inspect(): Promise<CloudWorkerStatus>;
}

/** Provided by the worker, consumed only by its supervisor. */
export const CloudWorker = defineService<CloudWorkerServiceApi>("cloud-worker");
