import { access, constants } from "node:fs/promises";

/** True when `path` exists and is executable by this user. */
export async function executableExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
