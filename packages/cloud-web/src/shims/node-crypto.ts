/** Browser stand-in for the one `node:crypto` import the mini presentation code makes. */
export function randomUUID(): string {
	return crypto.randomUUID();
}
