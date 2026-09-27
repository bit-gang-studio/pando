/// Turn a core error into one short line plus the full text.
/// Core errors look like "git push -u origin x failed: fatal: ...\nhint: ...".
export function errorParts(e: unknown): { message: string; detail: string } {
  const detail = String(e).replace(/^Error:\s*/, "").trim();
  const body = detail.replace(/^git .*? failed:\s*/s, "");
  const line = body.split("\n").map((l) => l.trim()).find((l) => l && !/^hint:/i.test(l)) ?? body;
  const hint = LOGIN_HINTS.find(([re]) => re.test(detail))?.[1];
  if (hint) return { message: hint, detail };
  const message = line.replace(/^(fatal|error):\s*/i, "");
  return { message: message.charAt(0).toUpperCase() + message.slice(1), detail };
}

/// Pando can't show git's login prompts. Say what to set up instead.
const LOGIN_HINTS: [RegExp, string][] = [
  [/could not read Username|terminal prompts disabled|Authentication failed|could not read Password/i,
    "Git needs you to log in to this remote. Set up a credential helper (or sign in once in a terminal), then try again."],
  [/Permission denied \(publickey|Host key verification failed|sign_and_send_pubkey|passphrase/i,
    "Git couldn't use your SSH key. Add it to ssh-agent (ssh-add), then try again."],
];
