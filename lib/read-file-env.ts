import { readFileSync } from "fs";

export function readFileEnv(path: string | undefined): string | null {
	if (!path) {
		return null;
	}

	try {
		return readFileSync(path, "utf-8").trim();
	} catch {
		return null;
	}
}
