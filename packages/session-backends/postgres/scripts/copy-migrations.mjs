import { cp, mkdir } from "node:fs/promises";

const source = new URL("../src/postgres/migrations/", import.meta.url);
const target = new URL("../dist/postgres/migrations/", import.meta.url);

await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
