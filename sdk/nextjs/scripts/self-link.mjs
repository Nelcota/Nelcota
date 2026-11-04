import { lstat, mkdir, readlink, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Keep the example on this checkout without replacing another installation.
 * @param {URL} packageRoot Directory URL of the checkout package.
 */
export async function linkSelf(packageRoot) {
  const scope = new URL("node_modules/@nelcota/", packageRoot);
  const link = new URL("nextjs", scope);
  await mkdir(scope, { recursive: true });
  try {
    const stat = await lstat(link);
    // Windows returns backslashes even for the relative target we created.
    const expected = resolve(fileURLToPath(packageRoot));
    if (
      stat.isSymbolicLink() === false ||
      resolve(fileURLToPath(scope), await readlink(link)) !== expected
    )
      throw new Error(`Refusing to replace ${fileURLToPath(link)}`);
  } catch (error) {
    if (error instanceof Error === false || ("code" in error && error.code === "ENOENT") === false)
      throw error;
    await symlink("../..", link, "dir");
  }
}
