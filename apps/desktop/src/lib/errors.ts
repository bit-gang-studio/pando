/// Turn a core error into one short line plus the full text.
/// Core errors look like "git push -u origin x failed: fatal: ...\nhint: ...".
export function errorParts(e: unknown): { message: string; detail: string } {
  const detail = String(e).replace(/^Error:\s*/, "").trim();
  const body = detail.replace(/^git .*? failed:\s*/s, "");
  const line = body.split("\n").map((l) => l.trim()).find((l) => l && !/^hint:/i.test(l)) ?? body;
  const message = line.replace(/^(fatal|error):\s*/i, "");
  return { message: message.charAt(0).toUpperCase() + message.slice(1), detail };
}
