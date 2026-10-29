// Resolve the example against the freshly built checkout during local quality checks.
import { linkPackage } from "./example.mjs";

await linkPackage();
