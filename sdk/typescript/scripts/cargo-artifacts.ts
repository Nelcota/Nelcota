// Lê os executáveis da saída de `cargo build --message-format=json`.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function executableOf(line: string, targetName: string): string | undefined {
  const message: unknown = JSON.parse(line);
  if (isRecord(message) === false || message["reason"] !== "compiler-artifact") return undefined;
  const target = message["target"];
  if (isRecord(target) === false || target["name"] !== targetName) return undefined;
  const executable = message["executable"];
  if (typeof executable !== "string" || executable.trim() === "") return undefined;
  return executable;
}

/** Caminho que o cargo informou para o executável `targetName`, se ele foi gerado. */
export function findExecutable(output: string, targetName: string): string | undefined {
  return output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => executableOf(line, targetName))
    .find((path) => path !== undefined);
}
