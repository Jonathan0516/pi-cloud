/**
 * Session values the cloud layer keeps alongside the agent's own. Application namespaces, so forks
 * and tree scans ignore them. The gateway writes them at creation; the worker reads them at start.
 */

import { value } from "@earendil-works/pi-agent-core";

/** Which tenant a session belongs to. Absent for sessions made outside the gateway (the CLI). */
export const sessionTenant = value<string>("cloud.tenant", "id");
/** The resource bundle version the session is pinned to. Absent: the worker runs bare. */
export const sessionBundleVersion = value<string>("cloud.bundle", "version");
