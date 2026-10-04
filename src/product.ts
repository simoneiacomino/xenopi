import { readFileSync } from "node:fs";

export const XENOPI_VERSION = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
).version;
export const PROVIDER_ID = "xenolith";
export const PROVIDER_API = "xenolith-wire";
export const PROVIDER_BASE_URL = "unix:///xenolith/wire.sock";
